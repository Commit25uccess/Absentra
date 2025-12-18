import logger from './logger';
import { buildHomeView } from '../views/home.view';
import { getOrCreateUser, isUserAdmin, isUserManager } from '../services/user.service';
import { getUserBalances } from '../services/balance.service';
import { getWhosOut, getUpcomingLeaves, getPendingRequestsForApprover } from '../services/leave-request.service';

const slackLogger = logger.child('slack-helpers');

/**
 * Refresh a user's home tab with latest data
 * Call this after any action that changes the user's leave state
 */
export async function refreshUserHomeTab(
  client: any,
  userSlackId: string
): Promise<void> {
  const startTime = Date.now();

  // Get user info from Slack
  const userInfo = await client.users.info({ user: userSlackId });
  if (!userInfo.user) {
    throw new Error(`User not found in Slack: ${userSlackId}`);
  }

  // Ensure user exists in our database
  const user = await getOrCreateUser(userInfo.user as any);

  // Fetch all data needed for the home view
  const [balances, whosOutToday, upcomingLeaves, isAdmin, isManager] = await Promise.all([
    getUserBalances(userSlackId),
    getWhosOut(),
    getUpcomingLeaves(7),
    isUserAdmin(userSlackId),
    isUserManager(userSlackId),
  ]);

  // Get pending count for managers
  let pendingCount = 0;
  if (isAdmin || isManager) {
    const pendingRequests = await getPendingRequestsForApprover(userSlackId);
    pendingCount = pendingRequests.length;
  }

  // Build and publish the home view
  const homeView = await buildHomeView({
    userName: user.displayName,
    isAdmin,
    isManager,
    balances,
    upcomingLeaves,
    pendingCount,
    whosOutToday,
  });

  await client.views.publish({
    user_id: userSlackId,
    view: homeView,
  });

  const duration = Date.now() - startTime;
  slackLogger.debug({ event: 'home_tab_refreshed', userSlackId, duration });
}

/**
 * Safely open or push a Slack view with expired trigger ID handling
 * Returns true if successful, false if failed (including expired trigger)
 */
export async function safeViewOpen(
  client: any,
  options: {
    trigger_id: string;
    view: any;
    method?: 'open' | 'push';
  },
  fallback?: {
    channel: string;
    user: string;
    message: string;
  }
): Promise<boolean> {
  const { trigger_id, view, method = 'open' } = options;

  try {
    if (method === 'push') {
      await client.views.push({ trigger_id, view });
    } else {
      await client.views.open({ trigger_id, view });
    }

    slackLogger.debug({ event: 'view_opened', method, callbackId: view.callback_id });
    return true;
  } catch (error) {
    // Handle expired trigger_id gracefully
    if (isExpiredTriggerError(error)) {
      slackLogger.warn({ event: 'view_open_failed', reason: 'expired_trigger', method });

      if (fallback) {
        try {
          await client.chat.postEphemeral({
            channel: fallback.channel,
            user: fallback.user,
            text: fallback.message || EXPIRED_TRIGGER_MESSAGE,
          });
        } catch (ephemeralError) {
          slackLogger.debug({
            event: 'expired_trigger_fallback_failed',
            error: ephemeralError instanceof Error ? ephemeralError.message : 'Unknown',
          });
        }
      }
      return false;
    }

    // Log and re-throw other errors
    slackLogger.error({ event: 'view_open_failed', method }, error);
    throw error;
  }
}

/**
 * Default expired trigger ID message
 */
export const EXPIRED_TRIGGER_MESSAGE = '⏰ This action has expired. Please try again or use the Home tab to access this feature.';

/**
 * Create a standard fallback config for expired triggers
 */
export function createExpiredTriggerFallback(
  userId: string,
  channelId?: string,
  customMessage?: string
): { channel: string; user: string; message: string } {
  return {
    channel: channelId || userId,
    user: userId,
    message: customMessage || EXPIRED_TRIGGER_MESSAGE,
  };
}

/**
 * Check if an error is an expired trigger ID error
 */
export function isExpiredTriggerError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes('expired_trigger_id');
  }
  if (typeof error === 'object' && error !== null) {
    const anyError = error as any;
    if (anyError.data?.error === 'expired_trigger_id') {
      return true;
    }
  }
  return false;
}

/**
 * Extract a user-friendly error message from a Slack API error
 */
export function getSlackErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null) {
    const anyError = error as any;
    if (anyError.data?.error) {
      return anyError.data.error;
    }
  }
  return 'Unknown error';
}

/**
 * Handle expired trigger ID in a catch block
 * Returns true if it was an expired trigger error (handled), false otherwise
 */
export async function handleExpiredTrigger(
  client: any,
  error: unknown,
  userId: string,
  channelId?: string,
  customMessage?: string
): Promise<boolean> {
  if (!isExpiredTriggerError(error)) {
    return false;
  }

  slackLogger.warn({ event: 'expired_trigger_handling', userId });

  try {
    await client.chat.postEphemeral({
      channel: channelId || userId,
      user: userId,
      text: customMessage || EXPIRED_TRIGGER_MESSAGE,
    });
  } catch (ephemeralError) {
    slackLogger.debug({
      event: 'expired_trigger_message_failed',
      userId,
      error: ephemeralError instanceof Error ? ephemeralError.message : 'Unknown',
    });
  }

  return true;
}

/**
 * Send an ephemeral message to a user
 */
export async function sendEphemeral(
  client: any,
  options: {
    channel: string;
    user: string;
    text: string;
    blocks?: any[];
  }
): Promise<boolean> {
  try {
    await client.chat.postEphemeral(options);
    return true;
  } catch (error) {
    slackLogger.error({
      event: 'ephemeral_message_failed',
      userId: options.user,
      channelId: options.channel,
    }, error);
    return false;
  }
}
