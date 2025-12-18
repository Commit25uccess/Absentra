import { App } from '@slack/bolt';
import cron from 'node-cron';
import { prisma } from '../db/client';
import { isWeekday, formatDate } from '../utils/dates';
import { DEFAULT_REMINDER_MESSAGES } from '../utils/constants';
import logger from '../utils/logger';

// ============================================
// Reminder Message Processing
// ============================================

/**
 * Format reminder message using template variables
 */
function formatReminderMessage(
  template: string | undefined,
  variables: {
    userName: string;
    leaveType: string;
    emoji: string;
    startDate: string;
    endDate: string;
    totalDays: number;
  }
): string {
  if (!template) {
    // Use default message based on leave type
    return DEFAULT_REMINDER_MESSAGES.DURING_LEAVE(variables.leaveType);
  }

  return template
    .replace(/\{userName\}/g, variables.userName)
    .replace(/\{leaveType\}/g, variables.leaveType)
    .replace(/\{emoji\}/g, variables.emoji)
    .replace(/\{startDate\}/g, variables.startDate)
    .replace(/\{endDate\}/g, variables.endDate)
    .replace(/\{totalDays\}/g, variables.totalDays.toString());
}

// ============================================
// Main Reminder Job
// ============================================

/**
 * Process all pending leave reminders
 */
async function processLeaveReminders(app: App): Promise<void> {
  try {
    logger.debug({ event: 'processing_reminders' });

    // Get all approved leave requests that might need reminders
    const leaveRequests = await prisma.leaveRequest.findMany({
      where: {
        status: 'APPROVED',
        OR: [
          // Leave starting in the next 24 hours
          {
            startDate: {
              lte: new Date(Date.now() + 24 * 60 * 60 * 1000),
              gte: new Date(),
            },
          },
          // Leave currently in progress
          {
            startDate: { lte: new Date() },
            endDate: { gte: new Date() },
          },
        ],
      },
      include: {
        requester: true,
        leaveType: true,
      },
    });

    // Group by leave type to check settings once per type
    const requestsByLeaveType = new Map();
    for (const request of leaveRequests) {
      if (!requestsByLeaveType.has(request.leaveTypeId)) {
        requestsByLeaveType.set(request.leaveTypeId, []);
      }
      requestsByLeaveType.get(request.leaveTypeId).push(request);
    }

    // Process reminders for each leave type
    for (const [_leaveTypeId, requests] of requestsByLeaveType) {
      const leaveType = requests[0].leaveType; // All requests have same leave type
      
      // Check if reminders are enabled for this leave type
      if (!leaveType.reminderEnabled) {
        logger.debug({ event: 'reminders_disabled', leaveType: leaveType.name });
        continue;
      }

      // Check time-based restrictions
      const now = new Date();
      const currentHour = now.getHours();
      const currentMinute = now.getMinutes();

      // Check if current time matches the scheduled time (within 30-minute window)
      const scheduledTime = `${leaveType.reminderHour.toString().padStart(2, '0')}:${leaveType.reminderMinute.toString().padStart(2, '0')}`;
      const currentTime = `${currentHour.toString().padStart(2, '0')}:${currentMinute.toString().padStart(2, '0')}`;
      
      // Simple time matching (within 30 minutes of scheduled time)
      const [scheduledHour, scheduledMin] = scheduledTime.split(':').map(Number);
      const [currentHourNum, currentMinNum] = currentTime.split(':').map(Number);

      const scheduledTotalMinutes = (scheduledHour ?? 0) * 60 + (scheduledMin ?? 0);
      const currentTotalMinutes = (currentHourNum ?? 0) * 60 + (currentMinNum ?? 0);
      
      const timeDiff = Math.abs(currentTotalMinutes - scheduledTotalMinutes);
      if (timeDiff > 30) {
        logger.debug({ event: 'reminders_not_scheduled_time', leaveType: leaveType.name, scheduledTime, currentTime });
        continue;
      }

      // Check weekdays-only restriction
      if (leaveType.reminderWeekdaysOnly && !isWeekday(now)) {
        logger.debug({ event: 'reminders_weekdays_only', leaveType: leaveType.name });
        continue;
      }

      // Process each request for this leave type
      for (const request of requests) {
        const start = new Date(request.startDate);
        const end = new Date(request.endDate);
        const today = new Date();

        // Pre-leave reminder (day before)
        if (leaveType.preLeaveReminderEnabled) {
          const dayBefore = new Date(start);
          dayBefore.setDate(dayBefore.getDate() - 1);

          if (dayBefore.toDateString() === today.toDateString() && start > today) {
            const variables = {
              userName: request.requester.displayName || request.requester.slackId,
              leaveType: leaveType.name,
              emoji: leaveType.emoji,
              startDate: await formatDate(start),
              endDate: await formatDate(end),
              totalDays: request.totalDays.toNumber(),
            };

            const message = formatReminderMessage(
              leaveType.customReminderMessage || DEFAULT_REMINDER_MESSAGES.BEFORE_LEAVE(leaveType.name),
              variables
            );

            await app.client.chat.postMessage({
              channel: request.requester.slackId,
              text: message,
            });

            logger.info({ event: 'pre_leave_reminder_sent', userId: request.requester.slackId, leaveType: leaveType.name });
          }
        }

        // During-leave reminder (multi-day leaves)
        if (leaveType.midLeaveReminderEnabled) {
          const daysDiff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
          
          if (daysDiff >= 3 && today >= start && today <= end) {
            const variables = {
              userName: request.requester.displayName || request.requester.slackId,
              leaveType: leaveType.name,
              emoji: leaveType.emoji,
              startDate: await formatDate(start),
              endDate: await formatDate(end),
              totalDays: request.totalDays.toNumber(),
            };

            const message = formatReminderMessage(
              leaveType.customReminderMessage || DEFAULT_REMINDER_MESSAGES.DURING_LEAVE(leaveType.name),
              variables
            );

            await app.client.chat.postMessage({
              channel: request.requester.slackId,
              text: message,
            });

            logger.info({ event: 'during_leave_reminder_sent', userId: request.requester.slackId, leaveType: leaveType.name });
          }
        }
      }
    }

    logger.debug({ event: 'reminders_processing_completed' });
  } catch (error) {
    logger.error({ event: 'reminder_processing_failed' }, error);
  }
}

/**
 * Schedule the reminder job based on leave type settings
 */
export function scheduleReminderJob(app: App): void {
  // Schedule to run every 30 minutes to check for reminders
  cron.schedule('*/30 * * * *', () => {
    processLeaveReminders(app);
  });

  logger.info({ event: 'reminder_job_scheduled', interval: '30_minutes' });
}

/**
 * Reschedule the reminder job (called when settings change)
 */
export function rescheduleReminderJob(_app: App): void {
  // Since we're using a fixed schedule (every 30 minutes),
  // we don't need to reschedule. The next run will pick up new settings.
  logger.info({ event: 'reminder_job_reschedule_noted' });
}

/**
 * Stop all scheduled jobs (for graceful shutdown)
 */
export function stopAllJobs(): void {
  // In a real implementation, you might want to track all scheduled jobs
  // and stop them individually. For now, this is a placeholder.
  logger.info({ event: 'scheduled_jobs_stopped' });
}

/**
 * Get the next reminder time for a leave type
 */
export function getNextReminderTime(leaveType: {
  reminderHour: number;
  reminderMinute: number;
  reminderWeekdaysOnly: boolean;
}): Date {
  const now = new Date();
  const nextReminder = new Date();
  
  nextReminder.setHours(leaveType.reminderHour, leaveType.reminderMinute, 0, 0);
  
  // If the scheduled time has passed today, schedule for tomorrow
  if (nextReminder <= now) {
    nextReminder.setDate(nextReminder.getDate() + 1);
  }
  
  // If weekdays-only and next reminder is on weekend, skip to Monday
  if (leaveType.reminderWeekdaysOnly) {
    const dayOfWeek = nextReminder.getDay();
    if (dayOfWeek === 0) { // Sunday
      nextReminder.setDate(nextReminder.getDate() + 1);
    } else if (dayOfWeek === 6) { // Saturday
      nextReminder.setDate(nextReminder.getDate() + 2);
    }
  }
  
  return nextReminder;
}
