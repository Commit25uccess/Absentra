import { config } from '../config';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import logger from '../utils/logger';

const dbLogger = logger.child('database');

// Global Prisma client instance
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const dbPath = config.database.url || './data/pto.db';
const adapter = new PrismaBetterSqlite3({ url: dbPath });

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: config.app.nodeEnv === 'development'
      ? ['query', 'error', 'warn']
      : ['error'],
  });

if (config.app.nodeEnv !== 'production') {
  globalForPrisma.prisma = prisma;
}

// Initialize default data
export async function initializeDatabase(): Promise<void> {
  dbLogger.debug('Initializing database');

  try {
    // Create default settings if not exists
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
    });

    if (!settings) {
      await prisma.settings.create({
        data: {
          id: 'default',
          defaultAllowance: 20,
          requireApproval: true,
          allowNegativeBalance: false,
          timezone: 'UTC',
        },
      });
      dbLogger.info('Created default settings');
    }

    // Create default leave types if none exist
    const leaveTypeCount = await prisma.leaveType.count();

    if (leaveTypeCount === 0) {
      const defaultLeaveTypes = [
        { name: 'Sick Leave', emoji: '🤒', color: '#E01E5A', defaultAllowance: 10, requiresApproval: true, affectsBalance: true, order: 1 },
        { name: 'Work From Home', emoji: '🏠', color: '#2EB67D', defaultAllowance: 10, requiresApproval: true, affectsBalance: true, order: 2 },
        { name: 'Casual', emoji: '🖐️', color: '#ECB22E', defaultAllowance: 5, requiresApproval: true, affectsBalance: true, order: 3 },
      ];

      await prisma.leaveType.createMany({
        data: defaultLeaveTypes,
      });
      dbLogger.info('Created default leave types', { count: defaultLeaveTypes.length });
    }

    dbLogger.debug('Database initialization complete');
  } catch (error) {
    dbLogger.error('Failed to initialize database', error);
    throw error;
  }
}

export default prisma;
