import type { KnownBlock } from '@slack/types';
import {
  section,
  sectionWithFields,
  context,
  divider,
  header,
  actions,
  button,
  statusEmoji,
  statusLabel,
  formatDuration,
} from '../utils/blocks';
import { paginate, buildPaginationBlocks } from '../utils/pagination';
import { formatDateRange, formatDate, isCurrentlyOnLeave } from '../utils/dates';
import type { LeaveRequestWithDetails } from '../services/leave-request.service';
import { PAGINATION } from '../utils/constants';

/**
 * Build "My Requests" message
 */
export function buildMyRequestsMessage(
  requests: LeaveRequestWithDetails[],
  showAll = false
): KnownBlock[] {
  if (requests.length === 0) {
    return [
      header('📋 My Leave Requests'),
      section("You don't have any leave requests yet."),
      context(['_Use `/pto request` to submit a new request._']),
    ];
  }

  const now = new Date();
  const currentAndUpcoming = requests.filter((r) => r.endDate >= now);
  const past = requests.filter((r) => r.endDate < now);

  const blocks: KnownBlock[] = [header('📋 My Leave Requests')];

  if (currentAndUpcoming.length > 0) {
    blocks.push(
      section('*Current & Upcoming*'),
      divider()
    );

    for (const request of currentAndUpcoming) {
      blocks.push(...buildRequestCard(request, true));
    }
  }

  const pastToShow = showAll ? past : past.slice(0, 3);

  if (pastToShow.length > 0) {
    blocks.push(
      section('*Past Requests*'),
      divider()
    );

    for (const request of pastToShow) {
      blocks.push(...buildRequestCard(request, false));
    }

    if (!showAll && past.length > 3) {
      blocks.push(
        context([`_Showing 3 of ${past.length} past requests. Use \`/pto history\` to see all._`])
      );
    }
  }

  blocks.push(
    divider(),
    context(['_Use `/pto request` to submit a new request._'])
  );

  return blocks;
}

/**
 * Build a single request card
 */
function buildRequestCard(
  request: LeaveRequestWithDetails,
  showActions: boolean
): KnownBlock[] {
  const dateRange = formatDateRange(request.startDate, request.endDate);
  const status = request.status;
  const emoji = statusEmoji(status);
  const label = statusLabel(status);

  const isOnLeave = isCurrentlyOnLeave(request.startDate, request.endDate) && status === 'APPROVED';

  let statusLine = `${emoji} ${label}`;
  if ((status === 'APPROVED' || status === 'REJECTED') && request.approver) {
    statusLine += ` by <@${request.approver.slackId}>`;
  }

  const blocks: KnownBlock[] = [
    section(
      `${request.leaveType.emoji} *${request.leaveType.name}*` +
      (isOnLeave ? ' 🟢 _Currently active_' : '') +
      `\n${dateRange} • ${formatDuration(request.totalDays)}` +
      `\n${statusLine}`
    ),
  ];

  if ((status === 'APPROVED' || status === 'REJECTED') && request.approverNote) {
    blocks.push(section(`_Note: "${request.approverNote}"_`));
  }

  const canCancel =
    showActions &&
    (status === 'PENDING' || (status === 'APPROVED' && request.startDate > new Date()));

  if (canCancel) {
    blocks.push(
      actions(
        [
          button('Cancel Request', 'cancel_request', {
            value: request.id,
            style: 'danger',
            confirm: {
              title: 'Cancel Request',
              text: 'Are you sure you want to cancel this leave request?',
              confirm: 'Yes, cancel it',
              deny: 'No, keep it',
            },
          }),
        ],
        `cancel_${request.id}`
      )
    );
  }

  blocks.push(context([`Submitted ${formatDate(request.createdAt, 'MMM d, yyyy')}`]));

  return blocks;
}

/**
 * Build pending requests for approver view
 */
export function buildPendingRequestsMessage(
  requests: LeaveRequestWithDetails[]
): KnownBlock[] {
  if (requests.length === 0) {
    return [
      header('⏳ Pending Approvals'),
      section('✅ No pending requests to review.'),
      context(['_All caught up!_']),
    ];
  }

  const blocks: KnownBlock[] = [
    header('⏳ Pending Approvals'),
    section(`You have *${requests.length}* request${requests.length !== 1 ? 's' : ''} waiting for your review:`),
    divider(),
  ];

  for (const request of requests) {
    const dateRange = formatDateRange(request.startDate, request.endDate);

    blocks.push(
      section(
        `${request.leaveType.emoji} *<@${request.requester.slackId}>* - ${request.leaveType.name}\n` +
        `${dateRange} • ${formatDuration(request.totalDays)}`
      ),
      actions(
        [
          button('Approve', 'approve_leave', {
            value: request.id,
            style: 'primary',
          }),
          button('Reject', 'reject_leave', {
            value: request.id,
            style: 'danger',
          }),
        ],
        `pending_${request.id}`
      ),
      context([`Submitted ${formatDate(request.createdAt, 'MMM d, yyyy')}`])
    );
  }

  return blocks;
}

/**
 * Build request details view
 */
export function buildRequestDetailsMessage(
  request: LeaveRequestWithDetails
): KnownBlock[] {
  const dateRange = formatDateRange(request.startDate, request.endDate);
  const status = request.status;
  const emoji = statusEmoji(status);
  const label = statusLabel(status);

  const blocks: KnownBlock[] = [
    header('📋 Request Details'),
    divider(),
    sectionWithFields([
      `*Requester:*\n<@${request.requester.slackId}>`,
      `*Type:*\n${request.leaveType.emoji} ${request.leaveType.name}`,
      `*Dates:*\n${dateRange}`,
      `*Duration:*\n${formatDuration(request.totalDays)}`,
      `*Status:*\n${emoji} ${label}`,
      `*Submitted:*\n${formatDate(request.createdAt)}`,
    ]),
  ];

  if (request.reason) {
    blocks.push(section(`*Reason:*\n>${request.reason}`));
  }

  if (request.approver) {
    blocks.push(
      section(
        `*${status === 'APPROVED' ? 'Approved' : 'Rejected'} by:*\n<@${request.approver.slackId}>` +
        (request.approvedAt ? ` on ${formatDate(request.approvedAt)}` : '')
      )
    );
  }

  if (request.approverNote) {
    blocks.push(section(`*Approver Note:*\n>${request.approverNote}`));
  }

  blocks.push(context([`Request ID: \`${request.id}\``]));

  return blocks;
}

/**
 * Build all requests message (for admin/managers) - with table format and pagination
 */
export function buildAllRequestsMessage(
  requests: LeaveRequestWithDetails[],
  page = 0
): KnownBlock[] {
  const blocks: KnownBlock[] = [
    header('📋 All Leave Requests'),
    divider(),
  ];

  if (requests.length === 0) {
    blocks.push(section('_No requests found._'));
    return blocks;
  }

  const pending = requests.filter(r => r.status === 'PENDING');
  const others = requests.filter(r => r.status !== 'PENDING');

  // Show pending requests first (always show all pending, no pagination)
  if (pending.length > 0 && page === 0) {
    blocks.push(section(`*⏳ Pending (${pending.length})*`));
    blocks.push(divider());

    for (const request of pending.slice(0, PAGINATION.MAX_PREVIEW_ITEMS)) {
      const dateRange = formatDateRange(request.startDate, request.endDate);

      blocks.push(
        section(
          `${request.leaveType.emoji} *<@${request.requester.slackId}>* - ${request.leaveType.name}\n` +
          `\`${dateRange}\` • ${formatDuration(request.totalDays)}`
        ),
        actions(
          [
            button('Approve', 'approve_leave', { value: request.id, style: 'primary' }),
            button('Reject', 'reject_leave', { value: request.id, style: 'danger' }),
          ],
          `all_req_${request.id}`
        )
      );
    }

    if (pending.length > PAGINATION.MAX_PREVIEW_ITEMS) {
      blocks.push(context([`_...and ${pending.length - PAGINATION.MAX_PREVIEW_ITEMS} more pending_`]));
    }
    blocks.push(divider());
  }

  // Paginated history section
  if (others.length > 0) {
    const { items: historyToShow } = paginate(others, page, PAGINATION.REQUESTS_PAGE_SIZE);

    blocks.push(section('*📜 Request History*'));
    blocks.push(divider());

    for (const request of historyToShow) {
      const dateRange = formatDateRange(request.startDate, request.endDate);
      const emoji = statusEmoji(request.status);
      const label = statusLabel(request.status);

      blocks.push(
        section(
          `${request.leaveType.emoji} *<@${request.requester.slackId}>*\n` +
          `\`${dateRange}\` • ${formatDuration(request.totalDays)} • ${emoji} ${label}`
        )
      );

      if (request.approverNote) {
        blocks.push(context([`↳ _"${request.approverNote}"_`]));
      }
    }

    blocks.push(
      ...buildPaginationBlocks({
        page,
        pageSize: PAGINATION.REQUESTS_PAGE_SIZE,
        totalItems: others.length,
        actionPrefix: 'requests',
      })
    );
  }

  blocks.push(
    divider(),
    context(['_Requests sorted by most recent_'])
  );

  return blocks;
}
