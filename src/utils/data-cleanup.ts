/**
 * Orphaned Data Cleanup Utility
 * Handles cleanup of incomplete operations and orphaned data records
 */

import { prisma, executeWithRetry } from '../db/client';
import logger, { generateRequestId, runWithContextAsync } from './logger';

/* ------------------------------------------------------------------ */
/* Types and Interfaces                                                  */
/* ------------------------------------------------------------------ */

interface CleanupStats {
  totalProcessed: number;
  deletedRecords: number;
  failedDeletions: number;
  errors: string[];
  duration: number;
}

interface CleanupOperation {
  name: string;
  description: string;
  execute: () => Promise<CleanupStats>;
  enabled: boolean;
}

interface CleanupConfig {
  orphanedLeaveRequests: boolean;
  expiredBalances: boolean;
  invalidApprovals: boolean;
  staleCacheEntries: boolean;
  cleanupInterval: number; // minutes
  batchSize: number;
  maxRetries: number;
}

/* ------------------------------------------------------------------ */
/* Cleanup Configuration                                                 */
/* ------------------------------------------------------------------ */

const DEFAULT_CONFIG: CleanupConfig = {
  orphanedLeaveRequests: true,
  expiredBalances: true,
  invalidApprovals: true,
  staleCacheEntries: true,
  cleanupInterval: 60, // 1 hour
  batchSize: 100,
  maxRetries: 3,
};

/* ------------------------------------------------------------------ */
/* Cleanup Operations                                                    */
/* ------------------------------------------------------------------ */

/**
 * Cleanup orphaned leave requests (requests without valid users or leave types)
 */
async function cleanupOrphanedLeaveRequests(): Promise<CleanupStats> {
  const startTime = Date.now();
  const stats: CleanupStats = {
    totalProcessed: 0,
    deletedRecords: 0,
    failedDeletions: 0,
    errors: [],
    duration: 0,
  };

  try {
    // Get all valid user IDs and leave type IDs
    const validUserIds = (await prisma.user.findMany({ select: { id: true } })).map((u: { id: string }) => u.id);
    const validLeaveTypeIds = (await prisma.leaveType.findMany({ select: { id: true } })).map((t: { id: string }) => t.id);

    // Find leave requests with invalid user references
    const invalidUserRequests = await executeWithRetry(
      () => prisma.leaveRequest.findMany({
        where: {
          NOT: {
            requesterId: {
              in: validUserIds
            }
          }
        },
        select: { id: true },
      }),
      'cleanup_orphaned_requests_users'
    ) as Array<{ id: string }>;

    // Find leave requests with invalid leave type references
    const invalidTypeRequests = await executeWithRetry(
      () => prisma.leaveRequest.findMany({
        where: {
          NOT: {
            leaveTypeId: {
              in: validLeaveTypeIds
            }
          }
        },
        select: { id: true },
      }),
      'cleanup_orphaned_requests_types'
    ) as Array<{ id: string }>;

    const orphanedIds = [
      ...invalidUserRequests.map((r: { id: string }) => r.id),
      ...invalidTypeRequests.map((r: { id: string }) => r.id),
    ];

    // Remove duplicates
    const uniqueOrphanedIds = [...new Set(orphanedIds)];
    stats.totalProcessed = uniqueOrphanedIds.length;

    // Delete in batches to avoid overwhelming database
    for (let i = 0; i < uniqueOrphanedIds.length; i += DEFAULT_CONFIG.batchSize) {
      const batch = uniqueOrphanedIds.slice(i, i + DEFAULT_CONFIG.batchSize);
      
      try {
        await executeWithRetry(
          () => prisma.leaveRequest.deleteMany({
            where: {
              id: { in: batch },
            },
          }),
          'cleanup_orphaned_requests_delete'
        );

        stats.deletedRecords += batch.length;
        logger.debug({
          event: 'orphaned_requests_batch_deleted',
          batchSize: batch.length,
          totalDeleted: stats.deletedRecords,
        });
      } catch (error) {
        stats.failedDeletions += batch.length;
        const errorMessage = `Failed to delete batch ${Math.floor(i / DEFAULT_CONFIG.batchSize) + 1}: ${error instanceof Error ? error.message : String(error)}`;
        stats.errors.push(errorMessage);
        logger.error({ event: 'batch_deletion_failed', batchIndex: Math.floor(i / DEFAULT_CONFIG.batchSize) + 1 }, error);
      }
    }

    logger.info({
      event: 'orphaned_requests_cleanup_completed',
      totalProcessed: stats.totalProcessed,
      deletedRecords: stats.deletedRecords,
      failedDeletions: stats.failedDeletions,
      errorCount: stats.errors.length,
    });

  } catch (error) {
    const errorMessage = `Orphaned leave requests cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    stats.errors.push(errorMessage);
    logger.error({ event: 'orphaned_requests_cleanup_failed' }, error);
  }

  stats.duration = Date.now() - startTime;
  return stats;
}

/**
 * Cleanup expired leave balance records
 */
async function cleanupExpiredBalances(): Promise<CleanupStats> {
  const startTime = Date.now();
  const stats: CleanupStats = {
    totalProcessed: 0,
    deletedRecords: 0,
    failedDeletions: 0,
    errors: [],
    duration: 0,
  };

  try {
    // Find expired balances (older than 2 years and with zero balance)
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

    // Get all valid user IDs
    const validUserIds = (await prisma.user.findMany({ select: { id: true } })).map((u: { id: string }) => u.id);

    const expiredBalances = await executeWithRetry(
      () => prisma.leaveBalance.findMany({
        where: {
          AND: [
            { updatedAt: { lt: twoYearsAgo } },
            { 
              OR: [
                { allowance: 0 },
                { allowance: 0.0 },
              ]
            },
            {
              NOT: {
                userId: {
                  in: validUserIds
                }
              }
            },
          ],
        },
        select: { id: true },
      }),
      'cleanup_expired_balances'
    ) as Array<{ id: string }>;

    stats.totalProcessed = expiredBalances.length;

    // Delete in batches
    for (let i = 0; i < expiredBalances.length; i += DEFAULT_CONFIG.batchSize) {
      const batch = expiredBalances.slice(i, i + DEFAULT_CONFIG.batchSize);
      
      try {
        await executeWithRetry(
          () => prisma.leaveBalance.deleteMany({
            where: {
              id: { in: batch.map((b: { id: string }) => b.id) },
            },
          }),
          'cleanup_expired_balances_delete'
        );

        stats.deletedRecords += batch.length;
        logger.debug({
          event: 'expired_balances_batch_deleted',
          batchSize: batch.length,
          totalDeleted: stats.deletedRecords,
        });
      } catch (error) {
        stats.failedDeletions += batch.length;
        const errorMessage = `Failed to delete balance batch ${Math.floor(i / DEFAULT_CONFIG.batchSize) + 1}: ${error instanceof Error ? error.message : String(error)}`;
        stats.errors.push(errorMessage);
        logger.error({ event: 'balance_batch_deletion_failed', batchIndex: Math.floor(i / DEFAULT_CONFIG.batchSize) + 1 }, error);
      }
    }

    logger.info({
      event: 'expired_balances_cleanup_completed',
      totalProcessed: stats.totalProcessed,
      deletedRecords: stats.deletedRecords,
      failedDeletions: stats.failedDeletions,
      errorCount: stats.errors.length,
    });

  } catch (error) {
    const errorMessage = `Expired balances cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    stats.errors.push(errorMessage);
    logger.error({ event: 'expired_balances_cleanup_failed' }, error);
  }

  stats.duration = Date.now() - startTime;
  return stats;
}

/**
 * Cleanup invalid approval records (messages for non-existent leave requests)
 */
async function cleanupInvalidApprovals(): Promise<CleanupStats> {
  const startTime = Date.now();
  const stats: CleanupStats = {
    totalProcessed: 0,
    deletedRecords: 0,
    failedDeletions: 0,
    errors: [],
    duration: 0,
  };

  try {
    // Get all valid leave request IDs
    const validLeaveRequestIds = (await prisma.leaveRequest.findMany({ select: { id: true } })).map((r: { id: string }) => r.id);

    // Find message records for non-existent leave requests
    const invalidApprovals = await executeWithRetry(
      () => prisma.leaveRequestMessage.findMany({
        where: {
          NOT: {
            leaveRequestId: {
              in: validLeaveRequestIds
            }
          }
        },
        select: { id: true },
      }),
      'cleanup_invalid_approvals'
    ) as Array<{ id: string }>;

    stats.totalProcessed = invalidApprovals.length;

    // Delete in batches
    for (let i = 0; i < invalidApprovals.length; i += DEFAULT_CONFIG.batchSize) {
      const batch = invalidApprovals.slice(i, i + DEFAULT_CONFIG.batchSize);
      
      try {
        await executeWithRetry(
          () => prisma.leaveRequestMessage.deleteMany({
            where: {
              id: { in: batch.map((a: { id: string }) => a.id) },
            },
          }),
          'cleanup_invalid_approvals_delete'
        );

        stats.deletedRecords += batch.length;
        logger.debug({
          event: 'invalid_messages_batch_deleted',
          batchSize: batch.length,
          totalDeleted: stats.deletedRecords,
        });
      } catch (error) {
        stats.failedDeletions += batch.length;
        const errorMessage = `Failed to delete message batch ${Math.floor(i / DEFAULT_CONFIG.batchSize) + 1}: ${error instanceof Error ? error.message : String(error)}`;
        stats.errors.push(errorMessage);
        logger.error({ event: 'message_batch_deletion_failed', batchIndex: Math.floor(i / DEFAULT_CONFIG.batchSize) + 1 }, error);
      }
    }

    logger.info({
      event: 'invalid_messages_cleanup_completed',
      totalProcessed: stats.totalProcessed,
      deletedRecords: stats.deletedRecords,
      failedDeletions: stats.failedDeletions,
      errorCount: stats.errors.length,
    });

  } catch (error) {
    const errorMessage = `Invalid message records cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    stats.errors.push(errorMessage);
    logger.error({ event: 'invalid_messages_cleanup_failed' }, error);
  }

  stats.duration = Date.now() - startTime;
  return stats;
}

/**
 * Cleanup stale cache entries (handled by cache system, but we can trigger cleanup)
 */
async function cleanupStaleCacheEntries(): Promise<CleanupStats> {
  const startTime = Date.now();
  const stats: CleanupStats = {
    totalProcessed: 1, // Cache cleanup is a single operation
    deletedRecords: 0,
    failedDeletions: 0,
    errors: [],
    duration: 0,
  };

  try {
    // Import here to avoid circular dependencies
    const { appCache } = await import('./cache');
    
    // Trigger cache cleanup
    appCache.clear(); // This will trigger cleanup of expired entries

    stats.deletedRecords = 1; // Clear operation performed

    logger.info({
      event: 'stale_cache_cleanup_completed',
      operation: 'cache_clear',
    });

  } catch (error) {
    const errorMessage = `Cache cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    stats.errors.push(errorMessage);
    stats.failedDeletions = 1;
    logger.error({ event: 'cache_cleanup_failed' }, error);
  }

  stats.duration = Date.now() - startTime;
  return stats;
}

/* ------------------------------------------------------------------ */
/* Cleanup Manager                                                       */
/* ------------------------------------------------------------------ */

class DataCleanupManager {
  private config: CleanupConfig;
  private cleanupTimer?: any;
  private isRunning = false;

  constructor(config: Partial<CleanupConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get all available cleanup operations
   */
  private getCleanupOperations(): CleanupOperation[] {
    return [
      {
        name: 'orphaned_leave_requests',
        description: 'Remove leave requests with invalid user or leave type references',
        execute: cleanupOrphanedLeaveRequests,
        enabled: this.config.orphanedLeaveRequests,
      },
      {
        name: 'expired_balances',
        description: 'Remove expired leave balance records',
        execute: cleanupExpiredBalances,
        enabled: this.config.expiredBalances,
      },
      {
        name: 'invalid_approvals',
        description: 'Remove message records for non-existent leave requests',
        execute: cleanupInvalidApprovals,
        enabled: this.config.invalidApprovals,
      },
      {
        name: 'stale_cache_entries',
        description: 'Clear stale cache entries',
        execute: cleanupStaleCacheEntries,
        enabled: this.config.staleCacheEntries,
      },
    ];
  }

  /**
   * Execute all enabled cleanup operations
   */
  async executeCleanup(): Promise<void> {
    if (this.isRunning) {
      logger.warn({ event: 'cleanup_already_running' });
      return;
    }

    const requestId = generateRequestId();
    
    await runWithContextAsync(
      { requestId, type: 'job' as any, name: 'data_cleanup' }, // Use 'job' type for cleanup operations
      async () => {
        this.isRunning = true;
        const startTime = Date.now();

        logger.info({
          event: 'data_cleanup_started',
          enabledOperations: this.getCleanupOperations().filter(op => op.enabled).map(op => op.name),
        });

        const operations = this.getCleanupOperations().filter(op => op.enabled);
        const results: Array<{ operation: string; stats: CleanupStats }> = [];

        for (const operation of operations) {
          try {
            logger.info({
              event: 'cleanup_operation_started',
              operation: operation.name,
              description: operation.description,
            });

            const stats = await operation.execute();
            results.push({ operation: operation.name, stats });

            logger.info({
              event: 'cleanup_operation_completed',
              operation: operation.name,
              duration: stats.duration,
              deletedRecords: stats.deletedRecords,
              errors: stats.errors.length,
            });

          } catch (error) {
            logger.error({ event: 'cleanup_operation_failed', operation: operation.name }, error);
            results.push({
              operation: operation.name,
              stats: {
                totalProcessed: 0,
                deletedRecords: 0,
                failedDeletions: 0,
                errors: [error instanceof Error ? error.message : String(error)],
                duration: 0,
              },
            });
          }
        }

        const totalDuration = Date.now() - startTime;
        const totalDeleted = results.reduce((sum, r) => sum + r.stats.deletedRecords, 0);
        const totalErrors = results.reduce((sum, r) => sum + r.stats.errors.length, 0);

        logger.info({
          event: 'data_cleanup_completed',
          totalDuration,
          operationsCompleted: results.length,
          totalDeleted,
          totalErrors,
          operationResults: results.map(r => ({
            operation: r.operation,
            deletedRecords: r.stats.deletedRecords,
            errors: r.stats.errors.length,
            duration: r.stats.duration,
          })),
        });

        this.isRunning = false;
      }
    );
  }

  /**
   * Start periodic cleanup
   */
  startPeriodicCleanup(): void {
    if (this.cleanupTimer) {
      (globalThis as any).clearInterval(this.cleanupTimer);
    }

    this.cleanupTimer = (globalThis as any).setInterval(() => {
      this.executeCleanup().catch(error => {
        logger.error({ event: 'periodic_cleanup_failed' }, error);
      });
    }, this.config.cleanupInterval * 60 * 1000);

    logger.info({
      event: 'periodic_cleanup_started',
      interval: this.config.cleanupInterval,
      intervalUnit: 'minutes',
    });
  }

  /**
   * Stop periodic cleanup
   */
  stopPeriodicCleanup(): void {
    if (this.cleanupTimer) {
      (globalThis as any).clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
      logger.info({ event: 'periodic_cleanup_stopped' });
    }
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<CleanupConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.info({ event: 'cleanup_config_updated', ...newConfig });
  }

  /**
   * Get current configuration
   */
  getConfig(): CleanupConfig {
    return { ...this.config };
  }
}

/* ------------------------------------------------------------------ */
/* Exports                                                               */
/* ------------------------------------------------------------------ */

// Create singleton instance
export const dataCleanupManager = new DataCleanupManager();

// Export individual cleanup functions for manual execution
export {
  cleanupOrphanedLeaveRequests,
  cleanupExpiredBalances,
  cleanupInvalidApprovals,
  cleanupStaleCacheEntries,
};

export type { CleanupConfig, CleanupStats, CleanupOperation };
