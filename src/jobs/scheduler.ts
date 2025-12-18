import cron, { ScheduledTask } from 'node-cron';
import { prisma } from '../db/client';
import { config } from '../config';
import { getWhosOut, getUpcomingLeaves } from '../services/leave-request.service';
import { buildDailyDigestMessage } from '../views/whos-out.message';
import logger, { generateRequestId, runWithContextAsync } from '../utils/logger';

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */
// Using `any` for SlackClient to avoid type conflicts with WebClient
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SlackClient = any;

interface DigestSettings {
  enabled: boolean;
  hour: number;
  minute: number;
  weekdaysOnly: boolean;
  channelId: string | null;
}

/* ------------------------------------------------------------------ */
/* Module state                                                       */
/* ------------------------------------------------------------------ */
const scheduledJobs: Map<string, ScheduledTask> = new Map();
const jobLogger = logger.child('scheduler');

/* ------------------------------------------------------------------ */
/* Get digest settings from database                                  */
/* ------------------------------------------------------------------ */
async function getDigestSettings(): Promise<DigestSettings> {
  const settings = await prisma.settings.findUnique({
    where: { id: 'default' },
  });

  const result: DigestSettings = {
    enabled: settings?.digestEnabled ?? true,
    hour: settings?.digestHour ?? 9,
    minute: settings?.digestMinute ?? 0,
    weekdaysOnly: settings?.digestWeekdaysOnly ?? true,
    channelId: settings?.notificationChannelId ?? null,
  };

  jobLogger.debug('Fetched digest settings', {
    enabled: result.enabled,
    hour: result.hour,
    minute: result.minute,
    weekdaysOnly: result.weekdaysOnly,
    hasChannel: !!result.channelId,
  });

  return result;
}

/* ------------------------------------------------------------------ */
/* Build cron expression from settings                                */
/* ------------------------------------------------------------------ */
function buildCronExpression(settings: DigestSettings): string {
  const weekdays = settings.weekdaysOnly ? '1-5' : '*';
  return `${settings.minute} ${settings.hour} * * ${weekdays}`;
}

/* ------------------------------------------------------------------ */
/* Send daily digest to configured channel                            */
/* ------------------------------------------------------------------ */
async function sendDailyDigest(client: SlackClient): Promise<void> {
  const requestId = generateRequestId();

  await runWithContextAsync(
    { requestId, type: 'job', name: 'daily_digest' },
    async () => {
      jobLogger.job('daily_digest', 'started');
      const startTime = Date.now();

      try {
        // Fetch settings
        const settings = await prisma.settings.findUnique({
          where: { id: 'default' },
        });

        if (!settings?.notificationChannelId) {
          jobLogger.warn('Daily digest skipped: no notification channel configured');
          jobLogger.job('daily_digest', 'completed', { skipped: true, reason: 'no_channel' });
          return;
        }

        // Fetch leave data
        const [todayRequests, upcomingRequests] = await Promise.all([
          getWhosOut(),
          getUpcomingLeaves(7),
        ]);

        jobLogger.debug('Fetched leave data for digest', {
          todayCount: todayRequests.length,
          upcomingCount: upcomingRequests.length,
        });

        // Skip if nothing to report
        if (todayRequests.length === 0) { //&& upcomingRequests.length === 0) {
          jobLogger.info('Daily digest skipped: no leaves to report');
          jobLogger.job('daily_digest', 'completed', { skipped: true, reason: 'no_leaves' });
          return;
        }

        // Build message
        const blocks = buildDailyDigestMessage(todayRequests, upcomingRequests);

        // Send to Slack
        const currentHour = new Date().getHours();
        const greeting = getTimeBasedGreeting(currentHour);

        await client.chat.postMessage({
          channel: settings.notificationChannelId,
          text: `${greeting}! Here's today's leave digest`,
          blocks,
        });

        const duration = Date.now() - startTime;
        jobLogger.job('daily_digest', 'completed', {
          duration,
          todayCount: todayRequests.length,
          upcomingCount: upcomingRequests.length,
          channelId: settings.notificationChannelId,
        });
      } catch (error) {
        const duration = Date.now() - startTime;
        jobLogger.error('Daily digest failed', error, { duration });
        jobLogger.job('daily_digest', 'failed', {
          duration,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
  );
}

/**
 * Update Slack statuses for users currently on leave
 *
 * TODO: This job currently doesn't update statuses because it requires user OAuth tokens
 * with `users.profile:write` scope. Implement proper OAuth flow to enable this feature.
 * For now, the job logs who is on leave but doesn't modify Slack profiles.
 *
 * @param client - Slack WebClient instance
 */
async function updateLeaveStatuses(client: SlackClient): Promise<void> {
  const requestId = generateRequestId();

  await runWithContextAsync(
    { requestId, type: 'job', name: 'update_leave_statuses' },
    async () => {
      jobLogger.job('update_leave_statuses', 'started');
      const startTime = Date.now();

      try {
        const onLeave = await getWhosOut();
        jobLogger.debug('Fetched users on leave', { count: onLeave.length });

        // TODO: Implement OAuth flow to obtain user tokens with users.profile:write scope
        // Once implemented, uncomment and update the status-setting logic below:
        //
        // for (const request of onLeave) {
        //   await client.users.profile.set({
        //     user: request.requester.slackId,
        //     profile: {
        //       status_text: `${request.leaveType.emoji} ${request.leaveType.name}`,
        //       status_emoji: request.leaveType.emoji,
        //     },
        //   });
        // }

        const duration = Date.now() - startTime;
        jobLogger.job('update_leave_statuses', 'completed', {
          duration,
          totalUsers: onLeave.length,
          note: 'Status updates disabled - requires user OAuth tokens',
        });
      } catch (error) {
        const duration = Date.now() - startTime;
        jobLogger.error('Failed to update leave statuses', error, { duration });
        jobLogger.job('update_leave_statuses', 'failed', {
          duration,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
  );
}

/* ------------------------------------------------------------------ */
/* Schedule a job with error handling wrapper                         */
/* ------------------------------------------------------------------ */
function scheduleJob(
  name: string,
  cronExpression: string,
  handler: () => Promise<void>
): ScheduledTask {
  const task = cron.schedule(cronExpression, async () => {
    try {
      await handler();
    } catch (error) {
      // Error is already logged in the handler, but we catch here
      // to prevent unhandled promise rejection
      jobLogger.error(`Unhandled error in job: ${name}`, error);
    }
  }, {
    timezone: config.app.timezone,
  });

  scheduledJobs.set(name, task);
  jobLogger.info(`Scheduled job: ${name}`, { cronExpression });

  return task;
}

/* ------------------------------------------------------------------ */
/* Stop a scheduled job                                               */
/* ------------------------------------------------------------------ */
export function stopJob(name: string): boolean {
  const task = scheduledJobs.get(name);
  if (task) {
    task.stop();
    scheduledJobs.delete(name);
    jobLogger.info(`Stopped job: ${name}`);
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Stop all scheduled jobs                                            */
/* ------------------------------------------------------------------ */
export function stopAllJobs(): void {
  for (const [name, task] of scheduledJobs) {
    task.stop();
    jobLogger.info(`Stopped job: ${name}`);
  }
  scheduledJobs.clear();
  jobLogger.info('All scheduled jobs stopped');
}

/* ------------------------------------------------------------------ */
/* Reschedule digest job (call after settings change)                 */
/* ------------------------------------------------------------------ */
export async function rescheduleDigestJob(client: SlackClient): Promise<void> {
  // Stop existing digest job if any
  stopJob('daily_digest');

  // Get current settings and reschedule
  const settings = await getDigestSettings();

  if (!settings.enabled) {
    jobLogger.info('Digest disabled in settings, not scheduling');
    return;
  }

  if (!settings.channelId) {
    jobLogger.warn('No notification channel configured, not scheduling digest');
    return;
  }

  const cronExpr = buildCronExpression(settings);
  scheduleJob('daily_digest', cronExpr, () => sendDailyDigest(client));

  jobLogger.info('Daily digest rescheduled', {
    hour: settings.hour,
    minute: settings.minute,
    weekdaysOnly: settings.weekdaysOnly,
    cronExpression: cronExpr,
  });
}

/* ------------------------------------------------------------------ */
/* Setup all scheduled jobs                                           */
/* ------------------------------------------------------------------ */
export async function setupScheduledJobs(client: SlackClient): Promise<void> {
  jobLogger.info('Initializing scheduled jobs');

  try {
    // Schedule daily digest based on settings
    const settings = await getDigestSettings();

    if (!settings.enabled) {
      jobLogger.info('Digest disabled in settings, not scheduling');
    } else if (!settings.channelId) {
      jobLogger.warn('No notification channel configured, not scheduling digest');
    } else {
      const cronExpr = buildCronExpression(settings);
      scheduleJob('daily_digest', cronExpr, () => sendDailyDigest(client));

      jobLogger.info('Daily digest scheduled', {
        hour: settings.hour,
        minute: settings.minute,
        weekdaysOnly: settings.weekdaysOnly,
        cronExpression: cronExpr,
      });
    }

    // Schedule hourly status updates
    scheduleJob('update_leave_statuses', '0 * * * *', () =>
      updateLeaveStatuses(client)
    );

    jobLogger.info('Scheduled jobs initialized', {
      jobs: Array.from(scheduledJobs.keys()),
    });
  } catch (error) {
    jobLogger.error('Failed to initialize scheduled jobs', error);
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Manual trigger for daily digest (for testing or admin use)         */
/* ------------------------------------------------------------------ */
export async function triggerDailyDigest(client: SlackClient): Promise<void> {
  jobLogger.info('Manually triggering daily digest');
  try {
    await sendDailyDigest(client);
    jobLogger.info('Manual daily digest trigger completed successfully');
  } catch (error) {
    jobLogger.error('Manual daily digest trigger failed', error);
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Get status of all scheduled jobs                                   */
/* ------------------------------------------------------------------ */
export function getJobsStatus(): { name: string; running: boolean }[] {
  return Array.from(scheduledJobs.entries()).map(([name]) => ({
    name,
    // node-cron tasks don't expose a status property directly
    // If the task is in the map, it's scheduled
    running: scheduledJobs.has(name),
  }));
}

/* ------------------------------------------------------------------ */
/* Get time based greeting                                            */
/* ------------------------------------------------------------------ */
function getTimeBasedGreeting(hour: number): string {
  if (hour < 12) return '☀️ Good morning';
  if (hour < 17) return '👋 Good afternoon';
  return '🌙 Good evening';
}
