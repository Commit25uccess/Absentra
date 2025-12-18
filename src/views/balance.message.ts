import type { KnownBlock } from '@slack/types';
import { section, mrkdwn, context, divider, header } from '../utils/blocks';
import { paginate, buildPaginationBlocks } from '../utils/pagination';
import type { BalanceSummary } from '../services/balance.service';
import { getCurrentYear } from '../utils/dates';
import {
  getBalanceIndicator,
  PAGINATION,
} from '../utils/constants';

/**
 * Build balance overview message
 */
export function buildBalanceMessage(
  balances: BalanceSummary[],
  userName: string,
  year?: number
): KnownBlock[] {
  const targetYear = year ?? getCurrentYear();

  if (balances.length === 0) {
    return [
      section(`No leave balances found for ${targetYear}.`),
      context(['_Contact your administrator to set up leave allowances._']),
    ];
  }

  const blocks: KnownBlock[] = [
    header(`📊 Leave Balance - ${targetYear}`),
    section(`Here's your leave balance overview, *${userName}*:`),
    divider(),
  ];

  // Create a visual balance display for each leave type
  for (const balance of balances) {
    const { leaveType, allowance, used, adjustment, remaining } = balance;
    const total = allowance + adjustment;

    // Calculate percentage used
    const percentUsed = total > 0 ? Math.round((used / total) * 100) : 0;

    // Create a visual progress bar
    const barLength = 10;
    const filledBars = Math.round((percentUsed / 100) * barLength);
    const emptyBars = barLength - filledBars;
    const progressBar = '█'.repeat(filledBars) + '░'.repeat(emptyBars);

    // Color the remaining based on how much is left
    const remainingIndicator = getBalanceIndicator(remaining);

    blocks.push(
      section(
        `${leaveType.emoji} *${leaveType.name}*\n` +
        `\`${progressBar}\` ${percentUsed}% used\n` +
        `${remainingIndicator} *${remaining}* days remaining` +
        (adjustment !== 0 ? ` _(includes ${adjustment > 0 ? '+' : ''}${adjustment} adjustment)_` : '')
      )
    );

    blocks.push(
      context([
        `Allowance: ${allowance} • Used: ${used} • Remaining: ${remaining}`,
      ])
    );
  }

  blocks.push(
    divider(),
    context([
      `_Use \`/pto request\` to submit a new leave request._`,
    ])
  );

  return blocks;
}

/**
 * Build a compact balance summary (for use in modals or inline)
 */
export function buildCompactBalanceSummary(balances: BalanceSummary[]): string {
  if (balances.length === 0) {
    return '_No balances configured_';
  }

  return balances
    .map((b) => {
      const indicator = getBalanceIndicator(b.remaining);
      return `${b.leaveType.emoji} ${b.leaveType.name}: ${indicator} *${b.remaining}* days`;
    })
    .join('\n');
}

/**
 * Build team balance overview (for managers)
 */
export function buildTeamBalanceMessage(
  teamName: string,
  memberBalances: Array<{ user: { slackId: string; displayName: string }; balances: BalanceSummary[] }>,
  year?: number
): KnownBlock[] {
  const targetYear = year ?? getCurrentYear();

  const blocks: KnownBlock[] = [
    header(`📊 Team Balance - ${teamName}`),
    section(`Leave balance overview for ${targetYear}:`),
    divider(),
  ];

  for (const { user, balances } of memberBalances) {
    const summaryParts = balances.map((b) => {
      const indicator = getBalanceIndicator(b.remaining);
      return `${b.leaveType.emoji} ${indicator}${b.remaining}`;
    });

    blocks.push(
      section(`*<@${user.slackId}>*\n${summaryParts.join(' • ')}`)
    );
  }

  blocks.push(
    divider(),
    context(['_Green: Good • Yellow: Low • Red: None remaining_'])
  );

  return blocks;
}

/**
 * Options for building balance blocks
 */
export interface BalanceBlocksOptions {
  page?: number;
  pageSize?: number;
  showActions?: boolean;
  actionPrefix?: string;
}

/**
 * Build balance table blocks with pagination (shared between message and modal)
 */
export function buildBalanceBlocks(
  usersWithBalances: Array<{ user: { slackId: string; displayName: string }; balances: BalanceSummary[] }>,
  options: BalanceBlocksOptions = {}
): KnownBlock[] {
  const {
    page = 0,
    pageSize = PAGINATION.BALANCES_PAGE_SIZE,
    showActions = true,
    actionPrefix = 'balances'
  } = options;

  const blocks: KnownBlock[] = [];

  // Add quick action buttons
  if (showActions) {
    blocks.push({
      type: 'actions',
      block_id: `${actionPrefix}_quick_actions`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '➕ Adjust Balance', emoji: true },
          action_id: 'admin_adjust_balance_modal',
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '📝 Set Allowance', emoji: true },
          action_id: 'admin_set_allowance_modal',
        },
      ],
    } as KnownBlock);
  }

  blocks.push(divider());

  if (usersWithBalances.length === 0) {
    blocks.push(section('_No users found._'));
    return blocks;
  }

  // Paginate users
  const { items: usersToShow } = paginate(usersWithBalances, page, pageSize);

  // Build user rows
  for (const { user, balances } of usersToShow) {
    const balanceText = balances
      .map((b) => {
        const indicator = getBalanceIndicator(b.remaining);
        return `${b.leaveType.emoji} ${indicator} \`${b.remaining}/${b.allowance + b.adjustment}\``;
      })
      .join('  ');

    blocks.push(
      section(`*<@${user.slackId}>*\n${balanceText || '_No balances_'}`)
    );
  }

  // Pagination controls
  blocks.push(
    ...buildPaginationBlocks({
      page,
      pageSize,
      totalItems: usersWithBalances.length,
      actionPrefix,
    })
  );

  blocks.push(
    divider(),
    context(['_Format: remaining/total • 🟢 Good • 🟡 Low • 🔴 None_'])
  );

  return blocks;
}

/**
 * Build all users balance overview (for admin/managers) - with table format and pagination
 */
export function buildAllBalancesMessage(
  usersWithBalances: Array<{ user: { slackId: string; displayName: string }; balances: BalanceSummary[] }>,
  year?: number,
  showActions = true,
  page = 0
): KnownBlock[] {
  //const targetYear = year ?? getCurrentYear();

  return [
    //header(`📊 All Balances - ${targetYear}`),
    {
      type: 'section',
      text: mrkdwn('*Balance Management*\n\nView and adjust user leave balances.'),
    },
    ...buildBalanceBlocks(usersWithBalances, {
      page,
      showActions,
      actionPrefix: 'balances',
    }),
  ];
}
