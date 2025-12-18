import type { KnownBlock, ModalView } from '@slack/types';
import { formatDateRange, formatDate } from '../utils/dates';
import {
  section,
  sectionWithFields,
  context,
  divider,
  actions,
  button,
  plainText,
  mrkdwn,
  statusEmoji,
  statusLabel,
  formatDuration,
} from '../utils/blocks';
import type { LeaveRequestWithDetails } from '../services/leave-request.service';

/**
 * Build approval request message blocks (sent to managers)
 */
export function buildApprovalRequestMessage(
  request: LeaveRequestWithDetails
): KnownBlock[] {
  const dateRange = formatDateRange(request.startDate, request.endDate);

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: '📋 Leave Request Pending Approval',
        emoji: true,
      },
    },
    divider(),
    section(
      `*<@${request.requester.slackId}>* has requested time off and needs your approval.`
    ),
    sectionWithFields([
      `*Type:*\n${request.leaveType.emoji} ${request.leaveType.name}`,
      `*Duration:*\n${formatDuration(request.totalDays)}`,
      `*Dates:*\n${dateRange}`,
      `*Submitted:*\n${formatDate(request.createdAt)}`,
    ]),
    ...(request.reason
      ? [section(`*Reason:*\n>${request.reason}`)]
      : []),
    divider(),
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
        button('View Details', 'view_request_details', {
          value: request.id,
        }),
      ],
      'approval_actions'
    ),
    context([
      `Request ID: \`${request.id.slice(0, 8)}\` • Use \`/pto pending\` to see all pending requests`,
    ]),
  ];
}

/**
 * Build updated message after approval/rejection
 */
export function buildApprovalResultMessage(
  request: LeaveRequestWithDetails,
  actionBy: string
): KnownBlock[] {
  const dateRange = formatDateRange(request.startDate, request.endDate);
  const status = request.status;
  const emoji = statusEmoji(status);
  const label = statusLabel(status);

  const headerText =
    status === 'APPROVED'
      ? '✅ Leave Request Approved'
      : '❌ Leave Request Rejected';

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: headerText,
        emoji: true,
      },
    },
    divider(),
    section(
      `*<@${request.requester.slackId}>*'s leave request has been *${label.toLowerCase()}*.`
    ),
    sectionWithFields([
      `*Type:*\n${request.leaveType.emoji} ${request.leaveType.name}`,
      `*Duration:*\n${formatDuration(request.totalDays)}`,
      `*Dates:*\n${dateRange}`,
      `*Status:*\n${emoji} ${label}`,
    ]),
    ...(request.approverNote
      ? [section(`*Note from approver:*\n>${request.approverNote}`)]
      : []),
    context([
      `${status === 'APPROVED' ? 'Approved' : 'Rejected'} by <@${actionBy}> on ${formatDate(new Date())}`,
    ]),
  ];
}

/**
 * Build the approval modal with optional remarks
 */
export function buildApproveReasonModal(requestId: string): ModalView {
  return {
    type: 'modal',
    callback_id: 'approve_reason_submit',
    private_metadata: requestId,
    title: plainText('Approve Request'),
    submit: plainText('Approve'),
    close: plainText('Cancel'),
    blocks: [
      section('You are about to approve this leave request.'),
      {
        type: 'input',
        block_id: 'note_block',
        optional: true,
        label: plainText('Add a note (optional)'),
        element: {
          type: 'plain_text_input',
          action_id: 'approval_note',
          placeholder: plainText('e.g., "Enjoy your vacation!" or any remarks'),
          multiline: true,
          max_length: 500,
        },
      },
    ],
  };
}

/**
 * Build the rejection reason modal
 */
export function buildRejectReasonModal(requestId: string): ModalView {
  return {
    type: 'modal',
    callback_id: 'reject_reason_submit',
    private_metadata: requestId,
    title: plainText('Reject Request'),
    submit: plainText('Reject'),
    close: plainText('Cancel'),
    blocks: [
      section('Are you sure you want to reject this leave request?'),
      {
        type: 'input',
        block_id: 'reason_block',
        optional: true,
        label: plainText('Reason for rejection (optional)'),
        element: {
          type: 'plain_text_input',
          action_id: 'rejection_reason',
          placeholder: plainText('Enter a reason (will be shared with the requester)'),
          multiline: true,
          max_length: 500,
        },
      },
    ],
  };
}

/**
 * Build notification message sent to requester
 */
export function buildRequesterNotification(
  request: LeaveRequestWithDetails
): KnownBlock[] {
  const dateRange = formatDateRange(request.startDate, request.endDate);
  const status = request.status;
  const emoji = statusEmoji(status);
  const label = statusLabel(status);

  const headerText =
    status === 'APPROVED'
      ? '🎉 Your Leave Request was Approved!'
      : '😔 Your Leave Request was Rejected';

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: headerText,
        emoji: true,
      },
    },
    sectionWithFields([
      `*Type:*\n${request.leaveType.emoji} ${request.leaveType.name}`,
      `*Duration:*\n${formatDuration(request.totalDays)}`,
      `*Dates:*\n${dateRange}`,
      `*Status:*\n${emoji} ${label}`,
    ]),
    ...(request.approver
      ? [context([`${status === 'APPROVED' ? 'Approved' : 'Rejected'} by <@${request.approver.slackId}>`])]
      : []),
    ...(request.approverNote
      ? [section(`*Note:*\n>${request.approverNote}`)]
      : []),
  ];
}
