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
import { startOfDay } from 'date-fns';
import type { LeaveRequestWithDetails } from '../services/leave-request.service';
import { PAGINATION } from '../utils/constants';

/**
 * Build "My Requests" message
 */
export async function buildMyRequestsMessage(
  requests: LeaveRequestWithDetails[],
  showAll = false
): Promise<KnownBlock[]> {
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
      blocks.push(...(await buildRequestCard(request, true)));
    }
  }

  const pastToShow = showAll ? past : past.slice(0, 3);

  if (pastToShow.length > 0) {
    blocks.push(
      section('*Past Requests*'),
      divider()
    );

    for (const request of pastToShow) {
      blocks.push(...(await buildRequestCard(request, false)));
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
async function buildRequestCard(
  request: LeaveRequestWithDetails,
  showActions: boolean
): Promise<KnownBlock[]> {
  const dateRange = await formatDateRange(request.startDate, request.endDate);
  const submittedDate = await formatDate(request.createdAt, 'MMM d, yyyy');
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
      `\n${dateRange} • ${formatDuration(request.totalDays.toNumber())}` +
      `\n${statusLine}`
    ),
  ];

  if (request.reason) {
    blocks.push(section(`_Reason: "${request.reason}"_`));
  }

  if (request.teamNotes) {
    blocks.push(section(`_Team note: "${request.teamNotes}"_`));
  }

  if ((status === 'APPROVED' || status === 'REJECTED') && request.approverNote) {
    blocks.push(section(`_Approver note: "${request.approverNote}"_`));
  }

  // Determine if the request can be cancelled
  // PENDING requests can always be cancelled
  // APPROVED requests can only be cancelled if the leave period hasn't ended yet
  const canCancel = showActions && (
    status === 'PENDING' ||
    (status === 'APPROVED' && startOfDay(new Date(request.endDate)) >= startOfDay(new Date()))
  );

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

  blocks.push(context([`Submitted ${submittedDate}`]));

  return blocks;
}

/**
 * Build pending requests for approver view
 */
export async function buildPendingRequestsMessage(
  requests: LeaveRequestWithDetails[]
): Promise<KnownBlock[]> {
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
    const dateRange = await formatDateRange(request.startDate, request.endDate);
    const submittedDate = await formatDate(request.createdAt, 'MMM d, yyyy');

    blocks.push(
      section(
        `${request.leaveType.emoji} *<@${request.requester.slackId}>* - ${request.leaveType.name}\n` +
        `${dateRange} • ${formatDuration(request.totalDays.toNumber())}`
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
      context([`Submitted ${submittedDate}`])
    );
  }

  return blocks;
}

/**
 * Build request details view
 */
export async function buildRequestDetailsMessage(
  request: LeaveRequestWithDetails
): Promise<KnownBlock[]> {
  const dateRange = await formatDateRange(request.startDate, request.endDate);
  const submittedDate = await formatDate(request.createdAt);
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
      `*Duration:*\n${formatDuration(request.totalDays.toNumber())}`,
      `*Status:*\n${emoji} ${label}`,
      `*Submitted:*\n${submittedDate}`,
    ]),
  ];

  if (request.reason) {
    blocks.push(section(`*Reason:*\n>${request.reason}`));
  }

  if (request.approver) {
    const approvedAtDate = request.approvedAt ? await formatDate(request.approvedAt) : null;
    blocks.push(
      section(
        `*${status === 'APPROVED' ? 'Approved' : 'Rejected'} by:*\n<@${request.approver.slackId}>` +
        (approvedAtDate ? ` on ${approvedAtDate}` : '')
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
export async function buildAllRequestsMessage(
  requests: LeaveRequestWithDetails[],
  page = 0
): Promise<KnownBlock[]> {
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
      const dateRange = await formatDateRange(request.startDate, request.endDate);

      blocks.push(
        section(
          `${request.leaveType.emoji} *<@${request.requester.slackId}>* - ${request.leaveType.name}\n` +
          `\`${dateRange}\` • ${formatDuration(request.totalDays.toNumber())}`
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
      const dateRange = await formatDateRange(request.startDate, request.endDate);
      const emoji = statusEmoji(request.status);
      const label = statusLabel(request.status);

      blocks.push(
        section(
          `${request.leaveType.emoji} *<@${request.requester.slackId}>*\n` +
          `\`${dateRange}\` • ${formatDuration(request.totalDays.toNumber())} • ${emoji} ${label}`
        )
      );

      if (request.reason) {
        blocks.push(context([`↳ _Reason: "${request.reason}"_`]));
      }

      if (request.teamNotes) {
        blocks.push(context([`↳ _Team: "${request.teamNotes}"_`]));
      }

      if (request.approverNote) {
        blocks.push(context([`↳ _Approver: "${request.approverNote}"_`]));
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
