import type { App } from '@slack/bolt';
import {
  format,
  differenceInDays,
  addDays,
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
        recipientId,
      },
    });
  } catch (error) {
    logger.warn('Failed to store message reference', { error, requestId, messageType });
  }
}

/**
 * Send approval request to managers
 */
export async function sendApprovalRequest(
  client: SlackClient,
  request: LeaveRequestWithDetails
): Promise<void> {
  const approvers = await getApproversForUser(request.requester.slackId);

  if (approvers.length === 0) {
    logger.warn('No approvers found for user', { userId: request.requester.slackId });
    return;
  }

  const blocks = buildApprovalRequestMessage(request);

  for (const approver of approvers) {
    try {
      const dmResult = await client.conversations.open({
        users: approver.slackId,
      });

      if (dmResult.channel?.id) {
        const messageResult = await client.chat.postMessage({
          channel: dmResult.channel.id,
          text: `📋 New leave request from <@${request.requester.slackId}> needs your approval`,
          blocks,
        });

        // Store message reference for later updates
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
      }
    } catch (error) {
      logger.error('Failed to send approval request', error, {
        approverId: approver.slackId,
        requestId: request.id,
      });
    }
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
      blocks: buildApprovalResultMessage(request, approverId),
    });
    logger.slack('Updated approval message', { channelId, messageTs });
    return true;
  } catch (error) {
    logger.warn('Could not update approval message', { error, channelId, messageTs });
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

    logger.action('approve_leave', approverId, { requestId });

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
      logger.error('Error opening approve modal', error, { approverId, requestId });
    }
  });

  // Handle approval modal submission
  app.view('approve_reason_submit', async ({ ack, body, view, client }) => {
    const approverId = body.user.id;
    const requestId = view.private_metadata;
    const note = view.state.values.note_block?.approval_note?.value ?? undefined;

    logger.view('approve_reason_submit', approverId, { requestId });

    try {
      const updatedRequest = await approveLeaveRequest(requestId, approverId, note);

      logger.request('approved', requestId, approverId, {
        requester: updatedRequest.requester.slackId,
        leaveType: updatedRequest.leaveType.name,
      });

      await ack({ response_action: 'clear' });

      await client.chat.postEphemeral({
        channel: approverId,
        user: approverId,
        text: `✅ Leave request approved successfully! <@${updatedRequest.requester.slackId}> has been notified.`,
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
      ]).catch(err => logger.warn('Error refreshing home tabs', { error: err }));
    } catch (error) {
      logger.error('Error approving request', error, { requestId, approverId });
      await ack({
        response_action: 'errors',
        errors: {
          note_block: error instanceof Error ? error.message : 'Could not approve request',
        },
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

    logger.action('reject_leave', approverId, { requestId });

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
      logger.error('Error opening reject modal', error, { approverId, requestId });
    }
  });

  // Handle rejection modal submission
  app.view('reject_reason_submit', async ({ ack, body, view, client }) => {
    const approverId = body.user.id;
    const requestId = view.private_metadata;
    const reason = view.state.values.reason_block?.rejection_reason?.value ?? undefined;

    logger.view('reject_reason_submit', approverId, { requestId });

    try {
      const updatedRequest = await rejectLeaveRequest(requestId, approverId, reason);

      logger.request('rejected', requestId, approverId, {
        requester: updatedRequest.requester.slackId,
        leaveType: updatedRequest.leaveType.name,
        reason,
      });

      await ack({ response_action: 'clear' });

      await client.chat.postEphemeral({
        channel: approverId,
        user: approverId,
        text: `❌ Leave request rejected. <@${updatedRequest.requester.slackId}> has been notified.`,
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
      ]).catch(err => logger.warn('Error refreshing home tabs', { error: err }));
    } catch (error) {
      logger.error('Error rejecting request', error, { requestId, approverId });
      await ack({
        response_action: 'errors',
        errors: {
          reason_block: error instanceof Error ? error.message : 'Could not reject request',
        },
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
          blocks: buildRequestDetailsMessage(request),
        },
      });
    } catch (error) {
      logger.error('Error viewing request details', error, { userId, requestId });
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
        blocks: buildRequesterNotification(request),
      });
    }
  } catch (error) {
    logger.error('Failed to notify requester', error, { requestId: request.id });
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
    logger.error('Failed to notify channel', error, { requestId: request.id });
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
