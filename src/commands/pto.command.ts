import type { App, RespondFn } from '@slack/bolt';
import { getOrCreateUser, isUserAdmin, isUserManager } from '../services/user.service';
import { getUserBalances } from '../services/balance.service';
import {
  getUserLeaveRequests,
  getWhosOut,
  getUpcomingLeaves,
  getPendingRequestsForApprover,
} from '../services/leave-request.service';
import {
  buildLeaveRequestModal,
} from '../views/leave-request.modal';
import { buildBalanceMessage } from '../views/balance.message';
import { buildMyRequestsMessage, buildPendingRequestsMessage } from '../views/my-requests.message';
import { buildWhosOutTodayMessage, buildUpcomingLeavesMessage } from '../views/whos-out.message';
import { buildAdminHelpMessage } from '../views/admin.modal';
import { section, context } from '../utils/blocks';
import logger from '../utils/logger';
import { isExpiredTriggerError, EXPIRED_TRIGGER_MESSAGE } from '../utils/slack-helpers';

const cmdLogger = logger.child('command');

/**
 * Register the /pto command and all its subcommands
 */
export function registerLeaveCommand(app: App): void {
  app.command('/pto', async ({ command, ack, client, respond }) => {
    await ack();

    const userId = command.user_id;
    const args = command.text.trim().split(/\s+/);
    const subcommand = args[0]?.toLowerCase() || 'help';
    const startTime = Date.now();

    cmdLogger.debug({
      event: 'command_processing',
      command: '/pto',
      userId,
      subcommand,
      fullText: command.text,
      channelId: command.channel_id,
    });

    try {
      // Ensure user exists in our database
      const userInfo = await client.users.info({ user: userId });
      if (userInfo.user) {
        await getOrCreateUser(userInfo.user as any);
      }

      switch (subcommand) {
        case 'request':
        case 'new':
          await handleRequest(client, userId, command.trigger_id, respond);
          break;

        case 'balance':
        case 'balances':
          await handleBalance(respond, userId);
          break;

        case 'my':
        case 'requests':
        case 'mine':
          await handleMyRequests(respond, userId);
          break;

        case 'history':
          await handleHistory(respond, userId);
          break;

        case 'who':
        case 'out':
          await handleWhosOut(respond, args[1]);
          break;

        case 'pending':
        case 'approve':
          await handlePending(respond, userId);
          break;

        case 'admin':
          await handleAdmin(respond, userId, args.slice(1));
          break;

        case 'help':
        default:
          await handleHelp(respond, userId);
          break;
      }

      const duration = Date.now() - startTime;
      cmdLogger.info({
        event: 'command_completed',
        command: '/pto',
        subcommand,
        userId,
        duration,
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      cmdLogger.error({
        event: 'command_failed',
        command: '/pto',
        subcommand,
        userId,
        duration,
      }, error);

      await respond({
        response_type: 'ephemeral',
        text: `❌ An error occurred: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  });

  cmdLogger.info({ event: 'command_registered', command: '/pto' });
}

/**
 * Handle /pto request - Open the leave request modal
 */
async function handleRequest(
  client: any,
  userId: string,
  triggerId: string,
  respond: RespondFn
): Promise<void> {
  try {
    const modal = await buildLeaveRequestModal(userId);

    await client.views.open({
      trigger_id: triggerId,
      view: modal,
    });

    cmdLogger.debug({ event: 'modal_opened', modal: 'leave_request', userId });
  } catch (error) {
    if (isExpiredTriggerError(error)) {
      cmdLogger.warn({ event: 'modal_open_failed', reason: 'expired_trigger', modal: 'leave_request', userId });
      await respond({
        response_type: 'ephemeral',
        text: EXPIRED_TRIGGER_MESSAGE,
      });
      return;
    }
    throw error;
  }
}

/**
 * Handle /pto balance - Show user's leave balances
 */
async function handleBalance(respond: RespondFn, userId: string): Promise<void> {
  const balances = await getUserBalances(userId);

  cmdLogger.debug({
    event: 'balances_fetched',
    userId,
    balanceCount: balances.length,
  });

  await respond({
    response_type: 'ephemeral',
    blocks: buildBalanceMessage(balances, 'you'),
  });
}

/**
 * Handle /pto my - Show user's leave requests
 */
async function handleMyRequests(respond: RespondFn, userId: string): Promise<void> {
  const requests = await getUserLeaveRequests(userId, {
    limit: 10,
  });

  cmdLogger.debug({
    event: 'requests_fetched',
    userId,
    requestCount: requests.length,
  });

  await respond({
    response_type: 'ephemeral',
    blocks: await buildMyRequestsMessage(requests),
  });
}

/**
 * Handle /pto history - Show all past requests
 */
async function handleHistory(respond: RespondFn, userId: string): Promise<void> {
  const requests = await getUserLeaveRequests(userId);

  cmdLogger.debug({
    event: 'history_fetched',
    userId,
    requestCount: requests.length,
  });

  await respond({
    response_type: 'ephemeral',
    blocks: await buildMyRequestsMessage(requests, true),
  });
}

/**
 * Handle /pto who - Show who's out
 */
async function handleWhosOut(respond: RespondFn, period?: string): Promise<void> {
  if (period === 'week' || period === 'upcoming') {
    const requests = await getUpcomingLeaves(7);

    cmdLogger.debug({
      event: 'leaves_fetched',
      period: 'week',
      count: requests.length,
    });

    await respond({
      response_type: 'ephemeral',
      blocks: await buildUpcomingLeavesMessage(requests, 7),
    });
  } else {
    const requests = await getWhosOut();

    cmdLogger.debug({
      event: 'leaves_fetched',
      period: 'today',
      count: requests.length,
    });

    await respond({
      response_type: 'ephemeral',
      blocks: buildWhosOutTodayMessage(requests),
    });
  }
}

/**
 * Handle /pto pending - Show pending requests for approvers
 */
async function handlePending(respond: RespondFn, userId: string): Promise<void> {
  const isManager = await isUserManager(userId);
  const isAdmin = await isUserAdmin(userId);

  if (!isManager && !isAdmin) {
    cmdLogger.debug({ event: 'pending_requests_denied', reason: 'not_manager_or_admin', userId });

    await respond({
      response_type: 'ephemeral',
      text: '⚠️ You are not a manager or admin. No pending requests to review.',
    });
    return;
  }

  const requests = await getPendingRequestsForApprover(userId);

  cmdLogger.debug({
    event: 'pending_requests_fetched',
    userId,
    isManager,
    isAdmin,
    pendingCount: requests.length,
  });

  await respond({
    response_type: 'ephemeral',
    blocks: await buildPendingRequestsMessage(requests),
  });
}

/**
 * Handle /pto admin - Admin commands
 */
async function handleAdmin(respond: RespondFn, userId: string, args: string[]): Promise<void> {
  const isAdmin = await isUserAdmin(userId);

  if (!isAdmin) {
    cmdLogger.debug({ event: 'admin_command_denied', reason: 'not_admin', userId });

    await respond({
      response_type: 'ephemeral',
      text: '⚠️ You need to be an admin to use admin commands.',
    });
    return;
  }

  cmdLogger.debug({ event: 'admin_help_shown', userId, args });

  // For now, just show help
  await respond({
    response_type: 'ephemeral',
    blocks: buildAdminHelpMessage(),
  });
}

/**
 * Handle /pto help - Show help message
 */
async function handleHelp(respond: RespondFn, userId: string): Promise<void> {
  const isManager = await isUserManager(userId);
  const isAdmin = await isUserAdmin(userId);

  cmdLogger.debug({ event: 'help_shown', userId, isManager, isAdmin });

  const blocks = [
    {
      type: 'header' as const,
      text: { type: 'plain_text' as const, text: '🏖️ Absentra - Leave Management', emoji: true },
    },
    {
      type: 'divider' as const,
    },
    section(
      '*📋 Basic Commands*\n' +
      '`/pto request` - Request time off\n' +
      '`/pto balance` - Check your leave balances\n' +
      '`/pto my` - View your leave requests\n' +
      '`/pto history` - View all past requests\n' +
      "`/pto who` - See who's out today\n" +
      "`/pto who week` - See who's out this week"
    ),
  ];

  if (isManager || isAdmin) {
    blocks.push(
      section(
        '*👔 Manager Commands*\n' +
        '`/pto pending` - View requests pending your approval'
      )
    );
  }

  if (isAdmin) {
    blocks.push(
      section(
        '*⚙️ Admin Commands*\n' +
        '`/pto admin` - View admin commands'
      )
    );
  }

  blocks.push(
    {
      type: 'divider' as const,
    },
    context(['💡 _Start with `/pto request` to submit your first leave request!_'])
  );

  await respond({
    response_type: 'ephemeral',
    blocks,
  });
}
