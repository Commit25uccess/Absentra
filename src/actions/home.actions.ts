import type { App, BlockAction, SlackAction } from '@slack/bolt';
import { buildLeaveRequestModal } from '../views/leave-request.modal';
import { buildBalanceMessage, buildAllBalancesMessage } from '../views/balance.message';
import { buildMyRequestsMessage, buildPendingRequestsMessage, buildAllRequestsMessage } from '../views/my-requests.message';
import { buildWhosOutTodayMessage, buildUpcomingLeavesMessage } from '../views/whos-out.message';
import { getUserBalances, getAllUsersBalances } from '../services/balance.service';
import {
  getUserLeaveRequests,
  getWhosOut,
  getUpcomingLeaves,
  getPendingRequestsForApprover,
  getAllLeaveRequests,
} from '../services/leave-request.service';
import { isUserAdmin, isUserManager } from '../services/user.service';
import logger from '../utils/logger';
import { handleExpiredTrigger } from '../utils/slack-helpers';

type SlackClient = any;
//type ActionBody = BlockAction<SlackAction>;

/**
 * Check if user has manager or admin privileges
 */
async function requireManagerOrAdmin(
  client: SlackClient,
  userId: string,
  action: string
): Promise<boolean> {
  const [isAdmin, isManager] = await Promise.all([
    isUserAdmin(userId),
    isUserManager(userId),
  ]);

  if (!isAdmin && !isManager) {
    await client.chat.postEphemeral({
      channel: userId,
      user: userId,
      text: `⚠️ You are not authorized to ${action}.`,
    });
    return false;
  }
  return true;
}

/**
 * Generic pagination handler factory
 */
function createPaginationHandler<T>(
  modalConfig: {
    callbackId: string;
    title: string;
  },
  fetchData: () => Promise<T>,
  buildBlocks: (data: T, page: number) => any[]
) {
  return async ({ ack, body, client }: any) => {
    await ack();
    const userId = body.user.id;
    const page = parseInt(body.actions[0]?.value || '0', 10);

    try {
      const data = await fetchData();
      await client.views.update({
        view_id: body.view.id,
        view: {
          type: 'modal',
          callback_id: modalConfig.callbackId,
          private_metadata: JSON.stringify({ page }),
          title: { type: 'plain_text', text: modalConfig.title },
          close: { type: 'plain_text', text: 'Close' },
          blocks: buildBlocks(data, page),
        },
      });
    } catch (error) {
      logger.error(`Error updating ${modalConfig.callbackId} pagination`, error, { userId });
    }
  };
}

/**
 * Register Home tab action handlers
 */
export function registerHomeActions(app: App): void {
  // Request Time Off button
  app.action('home_request_leave', async ({ ack, body, client }) => {
    await ack();
    const userId = body.user.id;

    try {
      const modal = await buildLeaveRequestModal(userId);
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: modal,
      });
    } catch (error) {
      if (await handleExpiredTrigger(client, error, userId)) return;
      logger.error('Error opening leave request modal', error, { userId });
    }
  });

  // My Balances button
  app.action('home_my_balances', async ({ ack, body, client }) => {
    await ack();
    const userId = body.user.id;

    try {
      const balances = await getUserBalances(userId);
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          title: { type: 'plain_text', text: 'My Balances' },
          close: { type: 'plain_text', text: 'Close' },
          blocks: buildBalanceMessage(balances, 'you'),
        },
      });
    } catch (error) {
      if (await handleExpiredTrigger(client, error, userId)) return;
      logger.error('Error showing balances', error, { userId });
    }
  });

  // My Requests button
  app.action('home_my_requests', async ({ ack, body, client }) => {
    await ack();
    const userId = body.user.id;

    try {
      const requests = await getUserLeaveRequests(userId, { limit: 15 });
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          title: { type: 'plain_text', text: 'My Requests' },
          close: { type: 'plain_text', text: 'Close' },
          blocks: buildMyRequestsMessage(requests),
        },
      });
    } catch (error) {
      if (await handleExpiredTrigger(client, error, userId)) return;
      logger.error('Error showing requests', error, { userId });
    }
  });

  // Who's Out button
  app.action('home_whos_out', async ({ ack, body, client }) => {
    await ack();
    const userId = body.user.id;

    try {
      const requests = await getWhosOut();
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          title: { type: 'plain_text', text: "Who's Out Today" },
          close: { type: 'plain_text', text: 'Close' },
          blocks: buildWhosOutTodayMessage(requests),
        },
      });
    } catch (error) {
      if (await handleExpiredTrigger(client, error, userId)) return;
      logger.error('Error showing who is out', error, { userId });
    }
  });

  // Upcoming button
  app.action('home_upcoming', async ({ ack, body, client }) => {
    await ack();
    const userId = body.user.id;

    try {
      const requests = await getUpcomingLeaves(14);
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          title: { type: 'plain_text', text: 'Upcoming Time Off' },
          close: { type: 'plain_text', text: 'Close' },
          blocks: buildUpcomingLeavesMessage(requests, 14),
        },
      });
    } catch (error) {
      if (await handleExpiredTrigger(client, error, userId)) return;
      logger.error('Error showing upcoming leaves', error, { userId });
    }
  });

  // Pending Requests button (managers)
  app.action('home_pending_requests', async ({ ack, body, client }) => {
    await ack();
    const userId = body.user.id;

    try {
      if (!await requireManagerOrAdmin(client, userId, 'view pending requests')) return;

      const requests = await getPendingRequestsForApprover(userId);
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          title: { type: 'plain_text', text: 'Pending Approvals' },
          close: { type: 'plain_text', text: 'Close' },
          blocks: buildPendingRequestsMessage(requests),
        },
      });
    } catch (error) {
      if (await handleExpiredTrigger(client, error, userId)) return;
      logger.error('Error showing pending requests', error, { userId });
    }
  });

  // All Balances button (managers/admins)
  app.action('home_all_balances', async ({ ack, body, client }) => {
    await ack();
    const userId = body.user.id;

    logger.action('home_all_balances', userId);

    try {
      if (!await requireManagerOrAdmin(client, userId, 'view all balances')) return;

      const usersWithBalances = await getAllUsersBalances();
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'all_balances_modal',
          private_metadata: JSON.stringify({ page: 0 }),
          title: { type: 'plain_text', text: 'All Balances' },
          close: { type: 'plain_text', text: 'Close' },
          blocks: buildAllBalancesMessage(usersWithBalances, undefined, true, 0),
        },
      });
    } catch (error) {
      if (await handleExpiredTrigger(client, error, userId)) return;
      logger.error('Error showing all balances', error, { userId });
    }
  });

  // All Requests button (managers/admins)
  app.action('home_all_requests', async ({ ack, body, client }) => {
    await ack();
    const userId = body.user.id;

    logger.action('home_all_requests', userId);

    try {
      if (!await requireManagerOrAdmin(client, userId, 'view all requests')) return;

      const requests = await getAllLeaveRequests({ limit: 100 });
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'all_requests_modal',
          private_metadata: JSON.stringify({ page: 0 }),
          title: { type: 'plain_text', text: 'All Requests' },
          close: { type: 'plain_text', text: 'Close' },
          blocks: buildAllRequestsMessage(requests, 0),
        },
      });
    } catch (error) {
      if (await handleExpiredTrigger(client, error, userId)) return;
      logger.error('Error showing all requests', error, { userId });
    }
  });

  // Balances pagination handlers (consolidated)
  const balancesPaginationHandler = createPaginationHandler(
    { callbackId: 'all_balances_modal', title: 'All Balances' },
    getAllUsersBalances,
    (data, page) => buildAllBalancesMessage(data, undefined, true, page)
  );
  app.action('balances_prev_page', balancesPaginationHandler);
  app.action('balances_next_page', balancesPaginationHandler);

  // Requests pagination handlers (consolidated)
  const requestsPaginationHandler = createPaginationHandler(
    { callbackId: 'all_requests_modal', title: 'All Requests' },
    () => getAllLeaveRequests({ limit: 100 }),
    (data, page) => buildAllRequestsMessage(data, page)
  );
  app.action('requests_prev_page', requestsPaginationHandler);
  app.action('requests_next_page', requestsPaginationHandler);

  // Disabled pagination buttons - just acknowledge
  const noopHandler = async ({ ack }: { ack: () => Promise<void> }) => { await ack(); };
  app.action('balances_prev_disabled', noopHandler);
  app.action('balances_next_disabled', noopHandler);
  app.action('requests_prev_disabled', noopHandler);
  app.action('requests_next_disabled', noopHandler);
}
