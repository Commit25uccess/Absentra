import type { HomeView, KnownBlock } from '@slack/types';
import { formatDate, getToday } from '../utils/dates';
import { plainText, divider, section, context, button, actions } from '../utils/blocks';
import type { BalanceSummary } from '../services/balance.service';
import type { LeaveRequestWithDetails } from '../services/leave-request.service';
import { getBalanceIndicator, PAGINATION } from '../utils/constants';

export interface HomeViewData {
  userName: string;
  isAdmin: boolean;
  isManager: boolean;
  balances: BalanceSummary[];
  upcomingLeaves: LeaveRequestWithDetails[];
  pendingCount: number;
  whosOutToday: LeaveRequestWithDetails[];
}

/**
 * Build the App Home view
 */
export async function buildHomeView(data: HomeViewData): Promise<HomeView> {
  const { userName, isAdmin, isManager, balances, upcomingLeaves, pendingCount, whosOutToday } = data;
  const today = getToday();

  const blocks: KnownBlock[] = [
    // Header
    {
      type: 'header',
      text: plainText(`Hi ${userName}! 👋`),
    },
    section('Welcome to *Absentra* - your leave management assistant. Request time off, check balances, and see who\'s out.'),
    divider(),

    // Quick Actions
    section('*Quick Actions*'),
    actions([
      button('➕ Request Time Off', 'home_request_leave', { style: 'primary' }),
      button('📊 My Balances', 'home_my_balances'),
      button('📋 My Requests', 'home_my_requests'),
    ], 'home_actions_1'),

    actions([
      button("👥 Who's Out", 'home_whos_out'),
      button('📅 Upcoming', 'home_upcoming'),
      button('📜 Leave Policy', 'home_view_policy'),
      //button('🗓️ Calendar', 'home_calendar'),
    ], 'home_actions_2'),

    divider(),
  ];

  // Manager/Admin section
  if (isManager || isAdmin) {
    const pendingText = pendingCount > 0
      ? `🔔 You have *${pendingCount}* pending request${pendingCount !== 1 ? 's' : ''} to review`
      : '✅ No pending requests';

    blocks.push(
      section('*Manager Actions*'),
      section(pendingText),
      actions([
        button('⏳ Review Pending', 'home_pending_requests', pendingCount > 0 ? {
          style: 'primary'
        } : undefined),
        button('📊 All Balances', 'home_all_balances'),
        button('📋 All Requests', 'home_all_requests'),
      ], 'home_manager_actions'),
    );

    if (isAdmin) {
      blocks.push(
        actions([
          button('⚙️ Admin Settings', 'home_admin_settings'),
        ], 'home_admin_actions'),
      );
    }

    blocks.push(divider());
  }

  // Balance Summary
  if (balances.length > 0) {
    blocks.push(section('*Your Balances*'));

    const balanceLines = balances.slice(0, 4).map((b) => {
      const indicator = getBalanceIndicator(b.remaining);
      return `${b.leaveType.emoji} *${b.leaveType.name}*: ${indicator} ${b.remaining}/${b.allowance + b.adjustment} days`;
    });

    blocks.push(
      section(balanceLines.join('\n')),
      divider(),
    );
  }

  // Who's Out Today
  blocks.push(
    section(`*Who's Out Today* - ${await formatDate(today, 'EEEE, MMM d')}`),
  );

  if (whosOutToday.length === 0) {
    blocks.push(section('🎉 Everyone is in the office today!'));
  } else {
    const outList = whosOutToday.slice(0, PAGINATION.MAX_PREVIEW_ITEMS).map((r) =>
      `${r.leaveType.emoji} <@${r.requester.slackId}> - ${r.leaveType.name}`
    ).join('\n');

    blocks.push(section(outList));

    if (whosOutToday.length > PAGINATION.MAX_PREVIEW_ITEMS) {
      blocks.push(
        context([`_...and ${whosOutToday.length - PAGINATION.MAX_PREVIEW_ITEMS} more_`]),
      );
    }
  }

  blocks.push(divider());

  // Upcoming leaves this week
  const futureLeaves = upcomingLeaves.filter(r => r.startDate > today);
  if (futureLeaves.length > 0) {
    blocks.push(section('*Coming Up This Week*'));

    const upcomingList = await Promise.all(futureLeaves.slice(0, PAGINATION.MAX_PREVIEW_ITEMS).map(async (r) =>
      `${r.leaveType.emoji} <@${r.requester.slackId}> - ${await formatDate(r.startDate, 'EEE, MMM d')}`
    ));

    blocks.push(
      section(upcomingList.join('\n')),
      divider(),
    );
  }

  // Footer
  blocks.push(
    context([
      `_Last updated: ${await formatDate(new Date(), 'MMM d, yyyy h:mm a')}_ • Type \`/pto help\` for commands`,
    ]),
  );

  return {
    type: 'home',
    blocks,
  };
}
