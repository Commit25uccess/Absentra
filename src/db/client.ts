import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import logger from '../utils/logger';

const dbLogger = logger.child('database');

// Global Prisma client instance
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  isConnecting: boolean;
};

const dbPath = process.env.DATABASE_PATH || './data/pto.db';
const adapter = new PrismaBetterSqlite3({ url: dbPath });

/**
 * Retry configuration for database operations
 */
const RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelay: 1000, // 1 second
  maxDelay: 10000, // 10 seconds
  backoffMultiplier: 2,
} as const;

/**
 * Calculate exponential backoff delay with jitter
 */
function calculateDelay(attempt: number): number {
  const exponentialDelay = RETRY_CONFIG.baseDelay * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt - 1);
  const jitter = Math.random() * 0.1 * exponentialDelay; // Add 10% jitter
  return Math.min(exponentialDelay + jitter, RETRY_CONFIG.maxDelay);
}

/**
 * Execute a database operation with retry logic
 */
export async function executeWithRetry<T>(
  operation: () => Promise<T>,
  operationName: string = 'database operation'
): Promise<T> {
  let lastError: Error;
  
  for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Don't retry on certain errors
      if (isNonRetryableError(lastError)) {
        dbLogger.error({ event: 'database_error_non_retryable', operationName }, lastError);
        throw lastError;
      }
      
      if (attempt === RETRY_CONFIG.maxAttempts) {
        dbLogger.error({
          event: 'database_operation_failed_all_retries',
          operationName,
          attempt,
          totalAttempts: RETRY_CONFIG.maxAttempts,
        }, lastError);
        throw lastError;
      }
      
      const delay = calculateDelay(attempt);
      dbLogger.warn({
        event: 'database_operation_retrying',
        operationName,
        attempt,
        totalAttempts: RETRY_CONFIG.maxAttempts,
        delayMs: delay,
        error: lastError.message,
      });
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  // This should never be reached, but TypeScript needs it
  throw lastError!;
}

/**
 * Check if an error should not be retried
 */
function isNonRetryableError(error: Error): boolean {
  const nonRetryablePatterns = [
    'SQLITE_CONSTRAINT',
    'UNIQUE constraint failed',
    'FOREIGN KEY constraint failed',
    'NOT NULL constraint failed',
  ];
  
  return nonRetryablePatterns.some(pattern => 
    error.message.includes(pattern) || 
    error.name.includes('Constraint')
  );
}

/**
 * Initialize Prisma client with enhanced error handling
 */
function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development'
      ? ['query', 'error', 'warn']
      : ['error'],
    errorFormat: 'pretty',
  });

  // Enhanced error handling for connection issues
  client.$on('error', (e: any) => {
      dbLogger.error({ event: 'prisma_client_error', error: e.message, target: e.target });
  });

  client.$on('warn', (e: any) => {
    dbLogger.warn({ event: 'prisma_client_warning', target: e.target, message: e.message });
  });

  return client;
}

/**
 * Get or create Prisma client with connection retry
 */
export const prisma =
  globalForPrisma.prisma ??
  createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// Track connection state
globalForPrisma.isConnecting = false;

/**
 * Test database connection with retry
 */
export async function testConnection(): Promise<boolean> {
  try {
    await executeWithRetry(
      () => prisma.$queryRaw`SELECT 1 as test`,
      'connection test'
    );
    dbLogger.debug({ event: 'database_connection_test_successful' });
    return true;
  } catch (error) {
    dbLogger.error({ event: 'database_connection_test_failed' }, error);
    return false;
  }
}

/**
 * Gracefully disconnect from database
 */
export async function disconnectDatabase(): Promise<void> {
  try {
    await prisma.$disconnect();
    dbLogger.info({ event: 'database_disconnected' });
  } catch (error) {
    dbLogger.error({ event: 'database_disconnect_error' }, error);
    throw error;
  }
}

// Initialize default data with retry logic
export async function initializeDatabase(): Promise<void> {
  dbLogger.debug({ event: 'database_initializing' });

  try {
    // Test connection first
    const isConnected = await testConnection();
    if (!isConnected) {
      throw new Error('Database connection test failed during initialization');
    }

    // Create default settings if not exists
    const settings = await executeWithRetry(
      () => prisma.settings.findUnique({
        where: { id: 'default' },
      }),
      'find default settings'
    );

    if (!settings) {
      await executeWithRetry(
        () => prisma.settings.create({
          data: {
            id: 'default',
            defaultAllowance: 20,
            requireApproval: true,
            allowNegativeBalance: false,
            timezone: 'UTC',
          },
        }),
        'create default settings'
      );
      dbLogger.info({ event: 'settings_created_default' });
    }

    // Create default leave types if none exist
    const leaveTypeCount = await executeWithRetry(
      () => prisma.leaveType.count(),
      'count leave types'
    );

    if (leaveTypeCount === 0) {
      const defaultLeaveTypes = [
        { name: 'Sick Leave', emoji: '🤒', color: '#E01E5A', defaultAllowance: 10, requiresApproval: true, affectsBalance: true, order: 1 },
        { name: 'Work From Home', emoji: '🏠', color: '#2EB67D', defaultAllowance: 10, requiresApproval: true, affectsBalance: true, order: 2 },
        { name: 'Casual', emoji: '🖐️', color: '#ECB22E', defaultAllowance: 5, requiresApproval: true, affectsBalance: true, order: 3 },
      ];

      await executeWithRetry(
        () => prisma.leaveType.createMany({
          data: defaultLeaveTypes,
        }),
        'create default leave types'
      );
      dbLogger.info({ event: 'leave_types_created_default', count: defaultLeaveTypes.length });
    }

    dbLogger.debug({ event: 'database_initialization_complete' });
  } catch (error) {
    dbLogger.error({ event: 'database_initialization_failed' }, error);
    throw error;
  }
}

export default prisma;
