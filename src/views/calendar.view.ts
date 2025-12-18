import type { ModalView, KnownBlock } from '@slack/types';
import { plainText, section, divider, context } from '../utils/blocks';
import type { LeaveRequestWithDetails } from '../services/leave-request.service';
import {
  format,
  isSameDay,
  isWeekend,
  isBefore,
  isAfter,
  startOfDay,
} from 'date-fns';

/**
 * Build list view of who's out (simpler, cleaner view)
 */
function buildListView(
  leaves: LeaveRequestWithDetails[],
  _year: number,
  _month: number
): KnownBlock[] {
  const blocks: KnownBlock[] = [];

  // Get unique leaves sorted by start date
  const uniqueLeaves = new Map<string, LeaveRequestWithDetails>();
  for (const leave of leaves) {
    uniqueLeaves.set(leave.id, leave);
  }

  const sortedLeaves = Array.from(uniqueLeaves.values())
    .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());

  if (sortedLeaves.length === 0) {
    return [section('_No one is scheduled to be out this month._')];
  }

  // Group by week
  const today = startOfDay(new Date());
  let currentWeekLabel = '';

  for (const leave of sortedLeaves.slice(0, 15)) {
    const startDate = new Date(leave.startDate);
    const endDate = new Date(leave.endDate);
    const weekStart = format(startDate, "'Week of' MMM d");

    // Add week header if changed
    if (weekStart !== currentWeekLabel) {
      currentWeekLabel = weekStart;
      blocks.push(context([`*${weekStart}*`]));
    }

    // Format date range
    const dateRange = isSameDay(startDate, endDate)
      ? format(startDate, 'EEE, MMM d')
      : `${format(startDate, 'EEE, MMM d')} → ${format(endDate, 'EEE, MMM d')}`;

    // Build line
    const isPast = endDate < today;
    const isCurrent = startDate <= today && endDate >= today;
    const statusIndicator = isCurrent ? '🔵' : isPast ? '⚪' : '🟢';

    blocks.push(
      section(
        `${statusIndicator} ${leave.leaveType.emoji} <@${leave.requester.slackId}>\n` +
        `      ${dateRange} _(${leave.totalDays}d)_`
      )
    );
  }

  if (sortedLeaves.length > 15) {
    blocks.push(context([`_...and ${sortedLeaves.length - 15} more_`]));
  }

  // Legend
  blocks.push(divider());
  blocks.push(context(['🟢 Upcoming  🔵 In progress  ⚪ Past']));

  return blocks;
}

/**
 * Build the calendar view modal (list-based for clarity)
 */
export function buildCalendarModal(
  leaves: LeaveRequestWithDetails[],
  year: number,
  month: number
): ModalView {
  const monthName = format(new Date(year, month), 'MMMM yyyy');

  // Count statistics
  const uniqueUsers = new Set(leaves.map(l => l.requester.slackId));
  const totalOut = uniqueUsers.size;
  const totalDays = leaves.reduce((sum, l) => sum + l.totalDays.toNumber(), 0);

  const blocks: KnownBlock[] = [
    // Navigation
    {
      type: 'actions',
      block_id: 'calendar_navigation',
      elements: [
        {
          type: 'button',
          text: plainText('◀ Prev'),
          action_id: 'calendar_prev_month',
          value: JSON.stringify({ year, month }),
        },
        {
          type: 'button',
          text: plainText(monthName),
          action_id: 'calendar_current_month',
          value: JSON.stringify({ year, month }),
        },
        {
          type: 'button',
          text: plainText('Next ▶'),
          action_id: 'calendar_next_month',
          value: JSON.stringify({ year, month }),
        },
      ],
    } as KnownBlock,

    // Summary stats
    section(
      `*${totalOut}* ${totalOut === 1 ? 'person' : 'people'} out  •  ` +
      `*${totalDays}* total days of leave`
    ),
    divider(),

    // List view
    ...buildListView(leaves, year, month),
  ];

  return {
    type: 'modal',
    callback_id: 'calendar_view',
    private_metadata: JSON.stringify({ year, month }),
    title: plainText('Calendar'),
    close: plainText('Close'),
    blocks,
  };
}

/**
 * Build a quick calendar summary for the home view
 */
export function buildCalendarSummaryBlocks(
  leaves: LeaveRequestWithDetails[],
  daysAhead: number = 7
): KnownBlock[] {
  const today = startOfDay(new Date());
  const blocks: KnownBlock[] = [];

  const upcomingDays: { date: Date; leaves: LeaveRequestWithDetails[] }[] = [];

  for (let i = 0; i < daysAhead; i++) {
    const day = new Date(today);
    day.setDate(day.getDate() + i);

    if (isWeekend(day)) continue;

    const dayLeaves = leaves.filter((leave) => {
      const leaveStart = startOfDay(new Date(leave.startDate));
      const leaveEnd = startOfDay(new Date(leave.endDate));
      return !isBefore(day, leaveStart) && !isAfter(day, leaveEnd);
    });

    if (dayLeaves.length > 0) {
      upcomingDays.push({ date: day, leaves: dayLeaves });
    }
  }

  if (upcomingDays.length === 0) {
    blocks.push(section(`_No scheduled leave in the next ${daysAhead} days._`));
    return blocks;
  }

  for (const { date, leaves: dayLeaves } of upcomingDays.slice(0, 5)) {
    const dateStr = isSameDay(date, today)
      ? 'Today'
      : format(date, 'EEE, MMM d');

    const peopleOut = dayLeaves
      .slice(0, 3)
      .map((l) => `${l.leaveType.emoji} <@${l.requester.slackId}>`)
      .join(', ');

    const extra = dayLeaves.length > 3 ? ` +${dayLeaves.length - 3} more` : '';

    blocks.push(section(`*${dateStr}:* ${peopleOut}${extra}`));
  }

  return blocks;
}
