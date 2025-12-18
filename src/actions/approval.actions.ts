import type { App } from '@slack/bolt';
import {
  format,
  differenceInDays,
  isSameDay,
  startOfDay,
} from 'date-fns';
import {
  approveLeaveRequest,
  rejectLeaveRequest,
  getLeaveRequestById,
  updateRequestMessageRef,
  type LeaveRequestWithDetails,
} from '../services/leave-request.service';
import { getApproversForUser, canApproveFor } from '../services/user.service';
import { prisma } from '../db/client';
import { formatDate } from '../utils/dates';
import logger from '../utils/logger';
import { refreshUserHomeTab } from '../utils/slack-helpers';
import {
  executeParallelSlackCalls,
} from '../utils/slack-rate-limiter';
import {
  REQUEST_STATUS,
  ERROR_MESSAGES,
  getRequestStatusMessage,
} from '../utils/constants';
import {
  buildApprovalRequestMessage,
  buildApprovalResultMessage,
  buildApproveReasonModal,
  buildRejectReasonModal,
  buildRequesterNotification,
} from '../views/approval.message';
import { buildRequestDetailsMessage } from '../views/my-requests.message';
import { buildSuccessModal, buildErrorModal } from '../views/modal-result.view';

type SlackClient = any;

/**
 * Store a message reference for a leave request
 */
async function storeMessageReference(
  requestId: string,
  messageType: 'approval' | 'requester_notification' | 'channel_notification',
  channelId: string,
  messageTs: string,
  recipientId?: string
): Promise<void> {
  try {
    await prisma.leaveRequestMessage.upsert({
      where: {
        leaveRequestId_slackChannelId_slackMessageTs: {
          leaveRequestId: requestId,
          slackChannelId: channelId,
          slackMessageTs: messageTs,
        },
      },
      update: {},
      create: {
        leaveRequestId: requestId,
        messageType,
        slackChannelId: channelId,
        slackMessageTs: messageTs,
        recipientId: recipientId ?? null,
      },
    });
  } catch (error) {
    logger.warn({ event: 'message_reference_store_failed', requestId, messageType });
  }
}

/**
 * Send approval request to managers with enhanced rate limiting and partial failure handling
 */
export async function sendApprovalRequest(
  client: SlackClient,
  request: LeaveRequestWithDetails
): Promise<void> {
  const approvers = await getApproversForUser(request.requester.slackId);

  if (approvers.length === 0) {
    logger.warn({ event: 'no_approvers_found', userId: request.requester.slackId });
    return;
  }

  const blocks = await buildApprovalRequestMessage(request);

  // Create API calls for each approver
  const approvalCalls = approvers.map((approver) => async () => {
    // Open DM conversation
    const dmResult = await client.conversations.open({
      users: approver.slackId,
    });

    if (!dmResult.channel?.id) {
      throw new Error(`Failed to open DM channel for approver ${approver.slackId}`);
    }

    // Send approval message
    const messageResult = await client.chat.postMessage({
      channel: dmResult.channel.id,
      text: `📋 New leave request from <@${request.requester.slackId}> needs your approval`,
      blocks,
    });

    // Store message references for later updates
    if (messageResult.ts) {
      // Legacy: keep updating the single reference for backward compatibility
      await updateRequestMessageRef(request.id, dmResult.channel.id, messageResult.ts);
      // New: store in dedicated table
      await storeMessageReference(
        request.id,
        'approval',
        dmResult.channel.id,
        messageResult.ts,
        approver.slackId
      );
    }

    logger.slack('Sent approval request', {
      requestId: request.id,
      approverId: approver.slackId,
    });

    return {
      approverId: approver.slackId,
      channelId: dmResult.channel.id,
      messageTs: messageResult.ts,
    };
  });

  // Execute calls in parallel with rate limiting
  const results = await executeParallelSlackCalls(
    approvalCalls,
    'send approval requests',
    3 // Limit concurrency to avoid overwhelming Slack API
  );

  // Log results and handle partial failures
  const successCount = results.filter(r => r.success).length;
  const failureCount = results.length - successCount;

  if (failureCount > 0) {
    const failedResults = results.map((r, i) => ({ ...r, approver: approvers[i] })).filter(r => !r.success);
    logger.warn({
      event: 'approval_requests_partial_failure',
      requestId: request.id,
      totalApprovers: approvers.length,
      successCount,
      failureCount,
      failedRequests: failedResults.map(r => ({
        approverId: r.approver?.slackId ?? 'unknown',
        error: r.error,
      })),
    });
  }

  if (successCount === 0) {
    throw new Error(`Failed to send approval request to all ${approvers.length} approvers`);
  }
}

/**
 * Update a single Slack message with approval result
 */
async function updateSingleMessage(
  client: SlackClient,
  channelId: string,
  messageTs: string,
  request: LeaveRequestWithDetails,
  approverId: string
): Promise<boolean> {
  try {
    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text: `Leave request ${request.status.toLowerCase()}`,
      blocks: await buildApprovalResultMessage(request, approverId),
    });
    logger.slack('Updated approval message', { channelId, messageTs });
    return true;
  } catch (error) {
    logger.warn({ event: 'approval_message_update_failed', channelId, messageTs });
    return false;
  }
}

/**
 * Update ALL stored approval messages for a request
 */
async function updateAllApprovalMessages(
  client: SlackClient,
  request: LeaveRequestWithDetails,
  approverId: string
): Promise<void> {
  // Get all stored message references for this request
  const messages = await prisma.leaveRequestMessage.findMany({
    where: {
      leaveRequestId: request.id,
      messageType: 'approval',
    },
  });

  // Update each message in parallel
  const updatePromises = messages.map((msg: { slackChannelId: string; slackMessageTs: string }) =>
    updateSingleMessage(client, msg.slackChannelId, msg.slackMessageTs, request, approverId)
  );

  await Promise.allSettled(updatePromises);

  logger.slack('Updated all approval messages', {
    requestId: request.id,
    messageCount: messages.length,
  });
}

/**
 * Register approval-related actions
 */
export function registerApprovalActions(app: App): void {
  // Handle approve button
  app.action('approve_leave', async ({ ack, body, client, action }) => {
    await ack();

    const approverId = body.user.id;
    const requestId = (action as any).value;
    const channelId = (body as any).channel?.id;
    const messageTs = (body as any).message?.ts;

    try {
      const request = await getLeaveRequestById(requestId);
      if (!request) {
        await client.chat.postEphemeral({
          channel: channelId || approverId,
          user: approverId,
          text: ERROR_MESSAGES.REQUEST_NOT_FOUND,
        });
        return;
      }

      if (request.status !== REQUEST_STATUS.PENDING) {
        await client.chat.postEphemeral({
          channel: channelId || approverId,
          user: approverId,
          text: getRequestStatusMessage(request.status),
        });
        return;
      }

      const canApprove = await canApproveFor(approverId, request.requester.slackId);
      if (!canApprove) {
        await client.chat.postEphemeral({
          channel: channelId || approverId,
          user: approverId,
          text: ERROR_MESSAGES.NOT_AUTHORIZED,
        });
        return;
      }

      // Store the clicked message reference for later update
      if (channelId && messageTs) {
        await updateRequestMessageRef(requestId, channelId, messageTs);
      }

      const viewMethod = (body as any).view ? 'push' : 'open';
      await client.views[viewMethod]({
        trigger_id: (body as any).trigger_id,
        view: buildApproveReasonModal(requestId),
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      if (errorMsg.includes('expired_trigger_id')) {
        await client.chat.postEphemeral({
          channel: channelId || approverId,
          user: approverId,
          text: ERROR_MESSAGES.EXPIRED_TRIGGER,
        });
        return;
      }
      logger.error({ event: 'approve_modal_open_failed', approverId, requestId }, error);
    }
  });

  // Handle approval modal submission
  app.view('approve_reason_submit', async ({ ack, body, view, client }) => {
    const approverId = body.user.id;
    const requestId = view.private_metadata;
    const note = view.state.values.note_block?.approval_note?.value ?? undefined;

    try {
      const updatedRequest = await approveLeaveRequest(requestId, approverId, note);

      const details = [
        `Requester: <@${updatedRequest.requester.slackId}>`,
        `Leave Type: ${updatedRequest.leaveType.emoji} ${updatedRequest.leaveType.name}`,
        `Dates: ${formatDate(updatedRequest.startDate)} - ${formatDate(updatedRequest.endDate)}`,
        note ? `Note: ${note}` : undefined,
      ].filter(Boolean) as string[];

      await ack({
        response_action: 'update',
        view: buildSuccessModal(
          'Request Approved',
          `The leave request has been approved successfully. <@${updatedRequest.requester.slackId}> has been notified.`,
          details
        ),
      });

      // Update ALL stored approval messages (sent to all approvers)
      await updateAllApprovalMessages(client, updatedRequest, approverId);

      // Also update legacy single message reference for backward compatibility
      if (updatedRequest.slackChannelId && updatedRequest.slackMessageTs) {
        await updateSingleMessage(
          client,
          updatedRequest.slackChannelId,
          updatedRequest.slackMessageTs,
          updatedRequest,
          approverId
        );
      }

      await notifyRequester(client, updatedRequest);
      await notifyChannelOnApproval(client, updatedRequest);

      // Refresh home tabs (non-blocking)
      Promise.all([
        refreshUserHomeTab(client, approverId),
        refreshUserHomeTab(client, updatedRequest.requester.slackId),
      ]).catch(_err => logger.warn({ event: 'home_tab_refresh_failed' }));
    } catch (error) {
      logger.error({ event: 'request_approval_failed', requestId, approverId }, error);
      await ack({
        response_action: 'update',
        view: buildErrorModal(
          'Approval Failed',
          error instanceof Error ? error.message : 'Could not approve request',
          ['Please try again or contact support if the issue persists.']
        ),
      });
    }
  });

  // Handle reject button
  app.action('reject_leave', async ({ ack, body, client, action }) => {
    await ack();

    const approverId = body.user.id;
    const requestId = (action as any).value;
    const channelId = (body as any).channel?.id;
    const messageTs = (body as any).message?.ts;

    try {
      const request = await getLeaveRequestById(requestId);
      if (!request) {
        await client.chat.postEphemeral({
          channel: channelId || approverId,
          user: approverId,
          text: ERROR_MESSAGES.REQUEST_NOT_FOUND,
        });
        return;
      }

      if (request.status !== REQUEST_STATUS.PENDING) {
        await client.chat.postEphemeral({
          channel: channelId || approverId,
          user: approverId,
          text: getRequestStatusMessage(request.status),
        });
        return;
      }

      const canApprove = await canApproveFor(approverId, request.requester.slackId);
      if (!canApprove) {
        await client.chat.postEphemeral({
          channel: channelId || approverId,
          user: approverId,
          text: ERROR_MESSAGES.NOT_AUTHORIZED,
        });
        return;
      }

      // Store the clicked message reference for later update
      if (channelId && messageTs) {
        await updateRequestMessageRef(requestId, channelId, messageTs);
      }

      const viewMethod = (body as any).view ? 'push' : 'open';
      await client.views[viewMethod]({
        trigger_id: (body as any).trigger_id,
        view: buildRejectReasonModal(requestId),
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      if (errorMsg.includes('expired_trigger_id')) {
        await client.chat.postEphemeral({
          channel: channelId || approverId,
          user: approverId,
          text: ERROR_MESSAGES.EXPIRED_TRIGGER,
        });
        return;
      }
      logger.error({ event: 'reject_modal_open_failed', approverId, requestId }, error);
    }
  });

  // Handle rejection modal submission
  app.view('reject_reason_submit', async ({ ack, body, view, client }) => {
    const approverId = body.user.id;
    const requestId = view.private_metadata;
    const reason = view.state.values.reason_block?.rejection_reason?.value ?? undefined;

    try {
      const updatedRequest = await rejectLeaveRequest(requestId, approverId, reason);

      const details = [
        `Requester: <@${updatedRequest.requester.slackId}>`,
        `Leave Type: ${updatedRequest.leaveType.emoji} ${updatedRequest.leaveType.name}`,
        `Dates: ${formatDate(updatedRequest.startDate)} - ${formatDate(updatedRequest.endDate)}`,
        reason ? `Reason: ${reason}` : undefined,
      ].filter(Boolean) as string[];

      await ack({
        response_action: 'update',
        view: buildSuccessModal(
          'Request Rejected',
          `The leave request has been rejected. <@${updatedRequest.requester.slackId}> has been notified.`,
          details
        ),
      });

      // Update ALL stored approval messages (sent to all approvers)
      await updateAllApprovalMessages(client, updatedRequest, approverId);

      // Also update legacy single message reference for backward compatibility
      if (updatedRequest.slackChannelId && updatedRequest.slackMessageTs) {
        await updateSingleMessage(
          client,
          updatedRequest.slackChannelId,
          updatedRequest.slackMessageTs,
          updatedRequest,
          approverId
        );
      }

      await notifyRequester(client, updatedRequest);

      // Refresh home tabs (non-blocking)
      Promise.all([
        refreshUserHomeTab(client, approverId),
        refreshUserHomeTab(client, updatedRequest.requester.slackId),
      ]).catch(_err => logger.warn({ event: 'home_tab_refresh_failed' }));
    } catch (error) {
      logger.error({ event: 'request_rejection_failed', requestId, approverId }, error);
      await ack({
        response_action: 'update',
        view: buildErrorModal(
          'Rejection Failed',
          error instanceof Error ? error.message : 'Could not reject request',
          ['Please try again or contact support if the issue persists.']
        ),
      });
    }
  });

  // Handle view details button
  app.action('view_request_details', async ({ ack, body, client, action }) => {
    await ack();

    const userId = body.user.id;
    const requestId = (action as any).value;

    try {
      const request = await getLeaveRequestById(requestId);
      if (!request) {
        throw new Error('Request not found');
      }

      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          title: { type: 'plain_text', text: 'Request Details' },
          close: { type: 'plain_text', text: 'Close' },
          blocks: await buildRequestDetailsMessage(request),
        },
      });
    } catch (error) {
      logger.error({ event: 'view_request_details_failed', userId, requestId }, error);
    }
  });
}

/**
 * Notify the requester about the decision
 */
async function notifyRequester(
  client: SlackClient,
  request: LeaveRequestWithDetails
): Promise<void> {
  try {
    const dmResult = await client.conversations.open({
      users: request.requester.slackId,
    });

    if (dmResult.channel?.id) {
      await client.chat.postMessage({
        channel: dmResult.channel.id,
        text: request.status === REQUEST_STATUS.APPROVED
          ? '🎉 Your leave request has been approved!'
          : '😔 Your leave request has been rejected.',
        blocks: await buildRequesterNotification(request),
      });
    }
  } catch (error) {
    logger.error({ event: 'requester_notification_failed', requestId: request.id }, error);
  }
}

/**
 * Notify the configured channel when a leave is approved
 * Simple message: who's out, when, and any notes for colleagues
 */
async function notifyChannelOnApproval(
  client: SlackClient,
  request: LeaveRequestWithDetails
): Promise<void> {
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
    });

    if (!settings?.notificationChannelId) {
      return;
    }

    //const dateRange = formatDateRange(request.startDate, request.endDate);

    // Simple, clean message
    let messageText = buildLeaveMessage(request);

    await client.chat.postMessage({
      channel: settings.notificationChannelId,
      text: messageText,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: messageText,
          },
        },
      ],
    });

    logger.slack('Sent channel notification', {
      requestId: request.id,
      channelId: settings.notificationChannelId,
    });
  } catch (error) {
    logger.error({ event: 'channel_notification_failed', requestId: request.id }, error);
  }
}

function buildLeaveMessage(request: LeaveRequestWithDetails): string {
  const { leaveType, requester, startDate, endDate, teamNotes, isHalfDay } = request;
  const today = startOfDay(new Date());
  const start = formatDate(startDate);
  const end = formatDate(endDate);

  const daysDiff = differenceInDays(startDate, today);
  const duration = differenceInDays(endDate, startDate) + 1;

  let whenPhrase = "";
  if (daysDiff === 0) {
    whenPhrase = "today";
  } else if (daysDiff === 1) {
    whenPhrase = "tomorrow";
  } else if (daysDiff > 1 && daysDiff <= 7) {
    whenPhrase = `next ${format(startDate, 'EEEE')}`;
  }

  let message = `${leaveType.emoji} <@${requester.slackId}> is on `;

  if (isHalfDay) {
    message += "half-day ";
  }

  message += "leave "; //`${leaveType.name} `;

  if (isHalfDay || isSameDay(startDate, endDate)) {
    message += `${whenPhrase || `on ${start}`}`;
  } else {
    message += `for ${duration} days, `;
    if (whenPhrase) {
      message += `starting ${whenPhrase}`;
    } else {
      message += `from ${start} to ${end}`;
    }
  }

  if (teamNotes) {
    message += `\n💬 _${teamNotes}_`;
  }

  return message;
}
