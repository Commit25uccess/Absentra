import type { App } from '@slack/bolt';
import { buildLeaveRequestModal } from '../views/leave-request.modal';
import { buildBalanceMessage, buildAllBalancesMessage } from '../views/balance.message';
import { buildMyRequestsMessage, buildPendingRequestsMessage, buildAllRequestsMessage } from '../views/my-requests.message';
import { buildWhosOutTodayMessage, buildUpcomingLeavesMessage } from '../views/whos-out.message';
import { buildViewPolicyModal } from '../views/leave-policy.modal';
//import { buildCalendarModal } from '../views/calendar.view';
import { getUserBalances, getAllUsersBalances } from '../services/balance.service';
import {
  getUserLeaveRequests,
  getWhosOut,
  getUpcomingLeaves,
  getPendingRequestsForApprover,
  getAllLeaveRequests,
} from '../services/leave-request.service';
import { isUserAdmin, isUserManager } from '../services/user.service';
import { getLeavePolicy } from '../services/leave-policy.service';
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
  buildBlocks: (data: T, page: number) => any[] | Promise<any[]>
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
          blocks: await buildBlocks(data, page),
        },
      });
    } catch (error) {
      logger.error({ event: 'pagination_update_failed', modal: modalConfig.callbackId, userId }, error);
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
      logger.error({ event: 'leave_request_modal_open_failed', userId }, error);
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
      logger.error({ event: 'balances_modal_open_failed', userId }, error);
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
          blocks: await buildMyRequestsMessage(requests),
        },
      });
    } catch (error) {
      if (await handleExpiredTrigger(client, error, userId)) return;
      logger.error({ event: 'requests_modal_open_failed', userId }, error);
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
      logger.error({ event: 'whos_out_modal_open_failed', userId }, error);
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
          blocks: await buildUpcomingLeavesMessage(requests, 14),
        },
      });
    } catch (error) {
      if (await handleExpiredTrigger(client, error, userId)) return;
      logger.error({ event: 'upcoming_modal_open_failed', userId }, error);
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
          blocks: await buildPendingRequestsMessage(requests),
        },
      });
    } catch (error) {
      if (await handleExpiredTrigger(client, error, userId)) return;
      logger.error({ event: 'pending_requests_modal_open_failed', userId }, error);
    }
  });

  // All Balances button (managers/admins)
  app.action('home_all_balances', async ({ ack, body, client }) => {
    await ack();
    const userId = body.user.id;

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
      logger.error({ event: 'all_balances_modal_open_failed', userId }, error);
    }
  });

  // All Requests button (managers/admins)
  app.action('home_all_requests', async ({ ack, body, client }) => {
    await ack();
    const userId = body.user.id;

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
          blocks: await buildAllRequestsMessage(requests, 0),
        },
      });
    } catch (error) {
      if (await handleExpiredTrigger(client, error, userId)) return;
      logger.error({ event: 'all_requests_modal_open_failed', userId }, error);
    }
  });

  // View Leave Policy button (all users)
  app.action('home_view_policy', async ({ ack, body, client }) => {
    await ack();
    const userId = body.user.id;

    try {
      const isAdmin = await isUserAdmin(userId);
      const policy = await getLeavePolicy();
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: buildViewPolicyModal(policy.content, isAdmin),
      });
    } catch (error) {
      if (await handleExpiredTrigger(client, error, userId)) return;
      logger.error({ event: 'leave_policy_modal_open_failed', userId }, error);
    }
  });

  // Edit Policy button in view modal (admin only)
  app.action('view_policy_edit', async ({ ack, body, client }) => {
    await ack();
    const userId = body.user.id;

    // Verify admin
    if (!await isUserAdmin(userId)) {
      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: '❌ You do not have permission to edit the leave policy.',
      });
      return;
    }

    try {
      const policy = await getLeavePolicy();
      const { buildEditPolicyModal } = await import('../views/leave-policy.modal');
      const editView = buildEditPolicyModal(policy.content);

      logger.info({
        event: 'updating_edit_modal',
        userId,
        viewId: (body as any).view.id,
        editViewTitle: editView.title,
        blocksCount: editView.blocks?.length,
      });

      await client.views.update({
        view_id: (body as any).view.id,
        view: editView,
      });

      logger.info({ event: 'edit_modal_updated', userId });
    } catch (error: any) {
      logger.error({ event: 'edit_policy_modal_open_failed', userId }, error);
      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: `❌ Error: ${error instanceof Error ? error.message : 'Could not open edit modal'}`,
      });
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

  // Calendar View button
  //app.action('home_calendar', async ({ ack, body, client }) => {
  //  await ack();
  //  const userId = body.user.id;

  //  try {
  //    const today = new Date();
  //    const year = today.getFullYear();
  //    const month = today.getMonth();

  //    const leaves = await getLeaveRequestsForMonth(year, month);
  //    await client.views.open({
  //      trigger_id: (body as any).trigger_id,
  //      view: buildCalendarModal(leaves, year, month),
  //    });
  //  } catch (error) {
  //    if (await handleExpiredTrigger(client, error, userId)) return;
  //    logger.error('Error showing calendar', error, { userId });
  //  }
  //});

  //// Calendar navigation - previous month
  //app.action('calendar_prev_month', async ({ ack, body, client }) => {
  //  await ack();
  //  const userId = body.user.id;

  //  try {
  //    const metadata = JSON.parse((body as any).actions?.[0]?.value || '{}');
  //    let { year, month } = metadata;

  //    // Go to previous month
  //    month--;
  //    if (month < 0) {
  //      month = 11;
  //      year--;
  //    }

  //    const leaves = await getLeaveRequestsForMonth(year, month);
  //    await client.views.update({
  //      view_id: (body as any).view?.id,
  //      view: buildCalendarModal(leaves, year, month),
  //    });
  //  } catch (error) {
  //    logger.error('Error navigating calendar', error, { userId });
  //  }
  //});

  //// Calendar navigation - next month
  //app.action('calendar_next_month', async ({ ack, body, client }) => {
  //  await ack();
  //  const userId = body.user.id;

  //  try {
  //    const metadata = JSON.parse((body as any).actions?.[0]?.value || '{}');
  //    let { year, month } = metadata;

  //    // Go to next month
  //    month++;
  //    if (month > 11) {
  //      month = 0;
  //      year++;
  //    }

  //    const leaves = await getLeaveRequestsForMonth(year, month);
  //    await client.views.update({
  //      view_id: (body as any).view?.id,
  //      view: buildCalendarModal(leaves, year, month),
  //    });
  //  } catch (error) {
  //    logger.error('Error navigating calendar', error, { userId });
  //  }
  //});

  //// Calendar current month button (no-op, just for display)
  //app.action('calendar_current_month', noopHandler);
}
