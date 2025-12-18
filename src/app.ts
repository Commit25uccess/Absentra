import { App, LogLevel } from '@slack/bolt';
import { createServer } from 'http';
import { config, validateConfig } from './config';
import { prisma, initializeDatabase } from './db/client';
import { registerLeaveCommand } from './commands/pto.command';
import {
  registerLeaveRequestActions,
  registerApprovalActions,
  registerAdminActions,
  registerHomeActions,
} from './actions';
import { setupScheduledJobs, stopAllJobs } from './jobs/scheduler';
import { registerLoggingMiddleware } from './middleware';
import { buildHomeView } from './views/home.view';
import { getHomeViewData } from './services/home.service';
import logger from './utils/logger';

// Create a child logger for the app module
const appLogger = logger.child('app');

// Validate environment variables
validateConfig();

// Initialize Slack App with Socket Mode
const app = new App({
  token: config.slack.botToken,
  signingSecret: config.slack.signingSecret,
  socketMode: true,
  appToken: config.slack.appToken,
  logLevel: config.app.nodeEnv === 'development' ? LogLevel.DEBUG : LogLevel.INFO,
});

// Register logging middleware first (before other handlers)
registerLoggingMiddleware(app);

// Global error handler for the Bolt app
app.error(async (error) => {
  const errorMessage = error.original?.message || error.message || 'Unknown error';

  // Handle expired trigger ID specifically
  if (errorMessage.includes('expired_trigger_id')) {
    appLogger.warn('Expired trigger ID - user action took too long', {
      code: 'expired_trigger_id',
    });
    return;
  }

  appLogger.error('Slack app error', error.original || error, {
    code: error.code,
  });
});

// Register command handlers
registerLeaveCommand(app);

// Register action handlers
registerLeaveRequestActions(app);
registerApprovalActions(app);
registerAdminActions(app);
registerHomeActions(app);

// App Home tab
app.event('app_home_opened', async ({ event, client }) => {
  const userId = event.user;

  try {
    // Get user info from Slack
    const userInfo = await client.users.info({ user: userId });
    if (!userInfo.user) {
      appLogger.warn('Could not fetch user info for home tab', { userId });
      return;
    }

    // Fetch all home view data via service
    const homeData = await getHomeViewData(userInfo.user as any);

    // Build and publish the home view
    const homeView = buildHomeView(homeData);

    await client.views.publish({
      user_id: userId,
      view: homeView,
    });

    appLogger.debug('Published home tab', { userId });
  } catch (error) {
    appLogger.error('Error publishing home tab', error, { userId });
  }
});

/**
 * Create a simple HTTP server for health checks
 * This runs alongside Socket Mode for container orchestration
 */
function createHealthServer(port: number): void {
  const server = createServer(async (req, res) => {
    const startTime = Date.now();

    // Set CORS and content type
    res.setHeader('Content-Type', 'application/json');

    if (req.url === '/health' && req.method === 'GET') {
      // Basic health check - app is running
      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      }));

      appLogger.debug('Health check', {
        endpoint: '/health',
        status: 200,
        duration: Date.now() - startTime,
      });
    } else if (req.url === '/ready' && req.method === 'GET') {
      // Readiness check - includes DB connectivity
      try {
        await prisma.$queryRaw`SELECT 1`;
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ready', database: 'connected' }));

        appLogger.debug('Readiness check', {
          endpoint: '/ready',
          status: 200,
          database: 'connected',
          duration: Date.now() - startTime,
        });
      } catch (error) {
        res.writeHead(503);
        res.end(JSON.stringify({ status: 'not ready', database: 'disconnected' }));

        appLogger.warn('Readiness check failed', {
          endpoint: '/ready',
          status: 503,
          database: 'disconnected',
          duration: Date.now() - startTime,
        });
      }
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));

      appLogger.debug('Unknown endpoint', {
        endpoint: req.url,
        method: req.method,
        status: 404,
      });
    }
  });

  server.listen(port);
  appLogger.info('Health check server started', { port });
}

// Start the app
async function start(): Promise<void> {
  try {
    // Initialize database
    await initializeDatabase();
    appLogger.info('Database initialized');

    // Setup scheduled jobs (daily digest, etc.) - now properly awaited
    await setupScheduledJobs(app.client);
    appLogger.info('Scheduled jobs configured');

    // Start health check HTTP server
    createHealthServer(config.app.port);

    // Start the Bolt app (Socket Mode)
    await app.start();
    appLogger.info('Absentra started successfully', {
      socketMode: true,
      port: config.app.port,
      environment: config.app.nodeEnv,
    });

    // Startup banner (intentionally console.log for user visibility)
    console.log('\n⚡️ Absentra is running!');
    console.log(`   Health check: http://localhost:${config.app.port}/health`);
    console.log('\nAvailable commands:');
    console.log('  /pto request  - Request time off');
    console.log('  /pto balance  - Check your balance');
    console.log('  /pto my       - View your requests');
    console.log("  /pto who      - See who's out");
    console.log('  /pto help     - Show all commands\n');
  } catch (error) {
    appLogger.error('Failed to start app', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
async function shutdown(signal: string): Promise<void> {
  appLogger.info(`${signal} received, shutting down...`);

  try {
    // Stop all scheduled jobs
    stopAllJobs();

    // Disconnect from database
    await prisma.$disconnect();

    appLogger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    appLogger.error('Error during shutdown', error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  appLogger.error('Uncaught exception', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  appLogger.error('Unhandled rejection', reason instanceof Error ? reason : new Error(String(reason)));
});

// Start the application
start();
