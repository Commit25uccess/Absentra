/**
 * Simple in-memory cache with TTL support and memory leak prevention
 * Lightweight alternative to Redis for small-scale Slack apps
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  accessCount: number;
  lastAccessed: number;
  size: number; // Estimated size in bytes
}

interface CacheStats {
  size: number;
  keys: string[];
  totalMemoryEstimate: number;
  hitRate: number;
  missCount: number;
  hitCount: number;
}

interface MemoryThresholds {
  maxEntries: number;
  maxMemoryMB: number;
  cleanupThreshold: number; // Trigger cleanup when reached this percentage
}

class SimpleCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private defaultTTL: number;
  private stats: CacheStats;
  private thresholds: MemoryThresholds;
  private cleanupTimer?: any;
  
  // Memory monitoring
  private hitCount = 0;
  private missCount = 0;

  constructor(
    defaultTTLMs = 5 * 60 * 1000,
    thresholds: Partial<MemoryThresholds> = {}
  ) {
    this.defaultTTL = defaultTTLMs;
    
    // Set default thresholds
    this.thresholds = {
      maxEntries: thresholds.maxEntries || 1000,
      maxMemoryMB: thresholds.maxMemoryMB || 50, // 50MB default
      cleanupThreshold: thresholds.cleanupThreshold || 0.8, // 80%
    };

    this.stats = {
      size: 0,
      keys: [],
      totalMemoryEstimate: 0,
      hitRate: 0,
      missCount: 0,
      hitCount: 0,
    };

    // Start periodic cleanup
    this.startCleanupTimer();
  }

  /**
   * Estimate size of a value in bytes (rough approximation)
   */
  private estimateSize(value: unknown): number {
    if (value === null || value === undefined) {
      return 0;
    }
    
    try {
      const serialized = JSON.stringify(value);
      // Simple fallback for environments without TextEncoder
      return serialized.length * 2; // Rough UTF-16 approximation
    } catch {
      // Fallback approximation
      return typeof value === 'string' ? (value as string).length * 2 : 64; // Rough estimate
    }
  }

  /**
   * Start periodic cleanup timer
   */
  private startCleanupTimer(): void {
    if (this.cleanupTimer) {
      (globalThis as any).clearTimeout(this.cleanupTimer);
    }

    this.cleanupTimer = (globalThis as any).setTimeout(() => {
      this.performCleanup();
      this.startCleanupTimer(); // Reschedule
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  /**
   * Perform cleanup of expired entries and memory management
   */
  private performCleanup(): void {
    const now = Date.now();
    const entriesToRemove: string[] = [];
    let totalMemoryEstimate = 0;

    // Find expired entries
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        entriesToRemove.push(key);
        continue;
      }
      
      // Update access statistics and calculate memory
      entry.lastAccessed = now;
      entry.accessCount++;
      totalMemoryEstimate += entry.size;
    }

    // Remove expired entries
    for (const key of entriesToRemove) {
      this.cache.delete(key);
    }

    // Check memory thresholds
    const memoryThresholdBytes = this.thresholds.maxMemoryMB * 1024 * 1024;
    const memoryUsagePercent = totalMemoryEstimate / memoryThresholdBytes;

    if (memoryUsagePercent > this.thresholds.cleanupThreshold || this.cache.size > this.thresholds.maxEntries) {
      this.performEviction(totalMemoryEstimate, memoryThresholdBytes);
    }

    // Update stats
    this.updateStats();
  }

  /**
   * Evict least recently used entries when memory thresholds are exceeded
   */
  private performEviction(currentMemory: number, maxMemory: number): void {
    const entries = Array.from(this.cache.entries());
    
    // Sort by last accessed time (LRU) and access count
    entries.sort((a, b) => {
      const [_keyA, entryA] = a;
      const [_keyB, entryB] = b;
      
      // Prioritize entries with lower access count
      if (entryA.accessCount !== entryB.accessCount) {
        return entryA.accessCount - entryB.accessCount;
      }
      
      // Then by last accessed time
      return entryA.lastAccessed - entryB.lastAccessed;
    });

    let removedMemory = 0;
    const targetReduction = Math.max(currentMemory - maxMemory * 0.7, currentMemory * 0.2); // Reduce to 70% of max or by 20%
    
    for (const [key, entry] of entries) {
      if (removedMemory >= targetReduction || this.cache.size <= this.thresholds.maxEntries * 0.7) {
        break;
      }
      
      this.cache.delete(key);
      removedMemory += entry.size;
    }
  }

  /**
   * Update cache statistics
   */
  private updateStats(): void {
    const totalRequests = this.hitCount + this.missCount;
    this.stats = {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
      totalMemoryEstimate: Array.from(this.cache.values())
        .reduce((sum, entry) => sum + entry.size, 0),
      hitRate: totalRequests > 0 ? this.hitCount / totalRequests : 0,
      hitCount: this.hitCount,
      missCount: this.missCount,
    };
  }

  /**
   * Get a value from cache
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key);

    if (!entry) {
      this.missCount++;
      return null;
    }

    // Check if expired
    const now = Date.now();
    if (now > entry.expiresAt) {
      this.cache.delete(key);
      this.missCount++;
      return null;
    }

    // Update access statistics
    entry.lastAccessed = now;
    entry.accessCount++;
    this.hitCount++;

    return entry.value as T;
  }

  /**
   * Set a value in cache with optional TTL
   */
  set<T>(key: string, value: T, ttlMs?: number): void {
    const ttl = ttlMs ?? this.defaultTTL;
    const now = Date.now();
    
    this.cache.set(key, {
      value,
      expiresAt: now + ttl,
      accessCount: 1,
      lastAccessed: now,
      size: this.estimateSize(value),
    });

    // Trigger cleanup if thresholds might be exceeded
    this.performCleanup();
  }

  /**
   * Get or set a value - if not in cache, compute and cache it
   */
  async getOrSet<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttlMs?: number
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    const value = await fetcher();
    this.set(key, value, ttlMs);
    return value;
  }

  /**
   * Invalidate a specific key
   */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Invalidate all keys matching a pattern prefix
   */
  invalidatePrefix(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    // Update stats before returning
    this.updateStats();
    return this.stats;
  }


  /**
   * Destroy cache and cleanup resources
   */
  destroy(): void {
    if (this.cleanupTimer) {
      (globalThis as any).clearTimeout(this.cleanupTimer);
    }
    this.cache.clear();
  }
}

// Export singleton instance for app-wide use with memory limits
export const appCache = new SimpleCache(5 * 60 * 1000, {
  maxEntries: 1000,
  maxMemoryMB: 50,
  cleanupThreshold: 0.8,
});

// Cache key constants
export const CACHE_KEYS = {
  SETTINGS: 'settings:default',
  LEAVE_TYPES: 'leave_types:active',
  LEAVE_TYPES_ALL: 'leave_types:all',
  WORKSPACE_TIMEZONE: 'workspace:timezone',
} as const;

// Cache TTLs (in milliseconds)
export const CACHE_TTL = {
  SETTINGS: 5 * 60 * 1000,      // 5 minutes
  LEAVE_TYPES: 10 * 60 * 1000,  // 10 minutes (rarely changes)
} as const;
