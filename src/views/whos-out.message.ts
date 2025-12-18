import type { KnownBlock } from '@slack/types';
import { section, context, divider, header } from '../utils/blocks';
import { formatDateRange, formatDate, getRelativeDateLabel, isCurrentlyOnLeave } from '../utils/dates';
import type { LeaveRequestWithDetails } from '../services/leave-request.service';
import { addDays, startOfDay, endOfDay, isSameDay } from 'date-fns';
import { PAGINATION } from '../utils/constants';

/**
 * Helper to format a single leave entry
 */
function formatLeaveEntry(
  request: LeaveRequestWithDetails,
  options: {
    includeDate?: boolean;
    includeName?: boolean;
    includeNotes?: boolean;
    bullet?: string;
  } = {}
): string {
  const {
    includeDate = false,
    includeName = true,
    includeNotes = true,
    bullet = ''
  } = options;

  let text = `${bullet}${request.leaveType.emoji} <@${request.requester.slackId}>`;

  if (includeName) {
    text += ` - ${request.leaveType.name}`;
  }

  if (includeDate) {
    const dateRange = formatDateRange(request.startDate, request.endDate);
    const isSingleDay = isSameDay(request.startDate, request.endDate);
    text += isSingleDay ? ` on ${formatDate(request.startDate)}` : ` • ${dateRange}`;
  }

  if (includeNotes && request.teamNotes) {
    text += ` _("${request.teamNotes}")_`;
  }

  return text;
}

/**
 * Build "Who's Out" message for today
 */
export function buildWhosOutTodayMessage(
  requests: LeaveRequestWithDetails[]
): KnownBlock[] {
  const today = startOfDay(new Date());

  if (requests.length === 0) {
    return [
      header("👥 Who's Out Today"),
      section('🎉 *Everyone is in the office today!*'),
      context([`_${formatDate(today, 'EEEE, MMMM d, yyyy')}_`]),
    ];
  }

  const blocks: KnownBlock[] = [
    header("👥 Who's Out Today"),
    section(`*${requests.length}* team member${requests.length !== 1 ? 's' : ''} out today:`),
    divider(),
  ];

  for (const request of requests) {
    const text = `*${formatLeaveEntry(request, { includeDate: true })}*`;
    blocks.push(section(text));
  }

  blocks.push(
    divider(),
    context([
      `_${formatDate(today, 'EEEE, MMMM d, yyyy')}_ • Use \`/pto who\` to check who's out`,
    ])
  );

  return blocks;
}

/**
 * Build upcoming leaves message
 */
export function buildUpcomingLeavesMessage(
  requests: LeaveRequestWithDetails[],
  days = 7
): KnownBlock[] {
  const today = startOfDay(new Date());

  if (requests.length === 0) {
    return [
      header('📅 Upcoming Time Off'),
      section(`No scheduled time off in the next ${days} days.`),
      context(['_Use `/pto request` to request time off._']),
    ];
  }

  // Group by date
  const byDate = new Map<string, LeaveRequestWithDetails[]>();

  for (let i = 0; i <= days; i++) {
    const date = addDays(today, i);
    const dateKey = formatDate(date, 'yyyy-MM-dd');
    const dayRequests = requests.filter((r) => {
      const start = startOfDay(r.startDate);
      const end = endOfDay(r.endDate);
      return date >= start && date <= end;
    });

    if (dayRequests.length > 0) {
      byDate.set(dateKey, dayRequests);
    }
  }

  const blocks: KnownBlock[] = [
    header('📅 Upcoming Time Off'),
    section(`Time off scheduled for the next ${days} days:`),
    divider(),
  ];

  for (const [dateKey, dayRequests] of byDate) {
    const date = new Date(dateKey);
    const dateLabel = getRelativeDateLabel(date);

    const peopleOut = dayRequests
      .map((r) => formatLeaveEntry(r, { includeName: false, includeNotes: false }))
      .join(', ');

    blocks.push(section(`*${dateLabel}*\n${peopleOut}`));
  }

  blocks.push(
    divider(),
    context([`_Showing ${days} days from today_`])
  );

  return blocks;
}

/**
 * Build daily digest message (for scheduled channel posts)
 */
export function buildDailyDigestMessage(
  todayRequests: LeaveRequestWithDetails[],
  upcomingRequests: LeaveRequestWithDetails[]
): KnownBlock[] {
  const today = startOfDay(new Date());
  const blocks: KnownBlock[] = [
    header('☀️ Good morning! Daily Leave Digest'),
    context([`_${formatDate(today, 'EEEE, MMMM d, yyyy')}_`]),
    divider(),
  ];

  // Today's absences
  if (todayRequests.length === 0) {
    blocks.push(section('✅ *Today:* Everyone is in!'));
  } else {
    const todayList = todayRequests
      .map((r) => formatLeaveEntry(r, { bullet: '• ' }))
      .join('\n');

    blocks.push(section(`📆 *Out Today (${todayRequests.length}):*\n${todayList}`));
  }

  // Upcoming this week
  const futureRequests = upcomingRequests.filter(
    (r) => !isCurrentlyOnLeave(r.startDate, r.endDate) || r.startDate > today
  );

  if (futureRequests.length > 0) {
    const upcomingList = futureRequests
      .slice(0, PAGINATION.MAX_PREVIEW_ITEMS)
      .map((r) => formatLeaveEntry(r, { includeDate: true, includeName: false, includeNotes: false, bullet: '• ' }))
      .join('\n');

    blocks.push(
      divider(),
      section(`📅 *Coming Up:*\n${upcomingList}`)
    );

    if (futureRequests.length > PAGINATION.MAX_PREVIEW_ITEMS) {
      blocks.push(
        context([`_...and ${futureRequests.length - PAGINATION.MAX_PREVIEW_ITEMS} more. Use \`/pto who week\` to see all._`])
      );
    }
  }

  blocks.push(
    divider(),
    context([
      '💡 _Use `/pto request` to request time off • `/pto balance` to check your balance_',
    ])
  );

  return blocks;
}
