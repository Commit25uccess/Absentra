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
import { scheduleReminderJob, stopAllJobs } from './jobs/scheduler';
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

// Global error handler for Bolt app
app.error(async (error) => {
  const errorMessage = error.original?.message || error.message || 'Unknown error';

  // Handle expired trigger ID specifically
  if (errorMessage.includes('expired_trigger_id')) {
    appLogger.warn({ event: 'expired_trigger_id', code: 'expired_trigger_id' });
    return;
  }

  appLogger.error({ event: 'slack_app_error', code: error.code }, error.original || error);
});

// Register command handlers
registerLeaveCommand(app);

/**
 * Fetch and store workspace timezone from Slack API
 * This runs once on app startup to get the timezone from the workspace
 * Note: Slack workspaces don't have a single timezone, so we fetch the first admin user's timezone
 */
async function syncWorkspaceTimezone(): Promise<void> {
  try {
    // Get a list of all users in the workspace
    const usersList = await app.client.users.list({});

    // Find the first real human user (not a bot) with isAdmin=true
    const adminUser = usersList.members?.find(user =>
      user.is_admin &&           // Must be an admin
      !user.is_bot &&            // Not a bot
      !user.deleted &&           // Not deleted
      user.tz                   // Has a timezone set
    );

    if (adminUser?.tz) {
      const userTimezone = adminUser.tz;

      // Update settings with the timezone from the admin user
      await prisma.settings.upsert({
        where: { id: 'default' },
        update: { timezone: userTimezone },
        create: { id: 'default', timezone: userTimezone },
      });

      appLogger.info({
        event: 'workspace_timezone_synced',
        timezone: userTimezone,
        user: adminUser.id,
        userName: adminUser.real_name || adminUser.name,
      });
    } else {
      appLogger.warn({ event: 'admin_user_timezone_not_found' });
    }
  } catch (error) {
    appLogger.error({ event: 'workspace_timezone_sync_failed' }, error);
    // Don't throw - allow app to start even if sync fails
  }
}

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
      appLogger.warn({ event: 'user_info_fetch_failed', userId });
      return;
    }

    // Fetch all home view data via service
    const homeData = await getHomeViewData(userInfo.user as any);

    // Build and publish the home view
    const homeView = await buildHomeView(homeData);

    await client.views.publish({
      user_id: userId,
      view: homeView,
    });

    appLogger.debug({ event: 'home_tab_published', userId });
  } catch (error) {
    appLogger.error({ event: 'home_tab_publish_failed', userId }, error);
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

      appLogger.debug({
        event: 'health_check',
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

        appLogger.debug({
          event: 'readiness_check',
          endpoint: '/ready',
          status: 200,
          database: 'connected',
          duration: Date.now() - startTime,
        });
      } catch (error) {
        res.writeHead(503);
        res.end(JSON.stringify({ status: 'not ready', database: 'disconnected' }));

        appLogger.warn({
          event: 'readiness_check_failed',
          endpoint: '/ready',
          status: 503,
          database: 'disconnected',
          duration: Date.now() - startTime,
        });
      }
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));

      appLogger.debug({
        event: 'unknown_endpoint',
        endpoint: req.url,
        method: req.method,
        status: 404,
      });
    }
  });

  server.listen(port);
  appLogger.info({ event: 'health_server_started', port });
}

// Start the app
async function start(): Promise<void> {
  try {
    // Initialize database
    await initializeDatabase();
    appLogger.info({ event: 'database_initialized' });

    // Sync workspace timezone from Slack API
    await syncWorkspaceTimezone();

    // Setup scheduled jobs (daily digest, etc.) - now properly awaited
    await scheduleReminderJob(app);
    appLogger.info({ event: 'scheduled_jobs_configured' });

    // Start health check HTTP server
    createHealthServer(config.app.port);

    // Start the Bolt app (Socket Mode)
    await app.start();
    appLogger.info({
      event: 'app_started',
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
    appLogger.error({ event: 'app_start_failed' }, error);
    process.exit(1);
  }
}

// Handle graceful shutdown
async function shutdown(signal: string): Promise<void> {
  appLogger.info({ event: 'shutdown_initiated', signal });

  try {
    // Stop all scheduled jobs
    stopAllJobs();

    // Disconnect from database
    await prisma.$disconnect();

    appLogger.info({ event: 'graceful_shutdown_completed' });
    process.exit(0);
  } catch (error) {
    appLogger.error({ event: 'shutdown_failed' }, error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  appLogger.error({ event: 'uncaught_exception' }, error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  appLogger.error({ event: 'unhandled_rejection' }, reason instanceof Error ? reason : new Error(String(reason)));
});

// Start the application
start();
