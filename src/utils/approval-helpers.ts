// src/utils/approval-helpers.ts
import { getLeaveRequestById } from '../services/leave-request.service';
import { canApproveFor } from '../services/user.service';
import { REQUEST_STATUS, ERROR_MESSAGES, getRequestStatusMessage } from './constants';

export async function validateApprovalAction(
  client: any,
  approverId: string,
  requestId: string,
  channelId?: string
): Promise<{ request: any; valid: boolean }> {
  const request = await getLeaveRequestById(requestId);
  
  if (!request) {
    await client.chat.postEphemeral({
      channel: channelId || approverId,
      user: approverId,
      text: ERROR_MESSAGES.REQUEST_NOT_FOUND,
    });
    return { request: null, valid: false };
  }

  if (request.status !== REQUEST_STATUS.PENDING) {
    await client.chat.postEphemeral({
      channel: channelId || approverId,
      user: approverId,
      text: getRequestStatusMessage(request.status),
    });
    return { request, valid: false };
  }

  const canApprove = await canApproveFor(approverId, request.requester.slackId);
  if (!canApprove) {
    await client.chat.postEphemeral({
      channel: channelId || approverId,
      user: approverId,
      text: ERROR_MESSAGES.NOT_AUTHORIZED,
    });
    return { request, valid: false };
  }

  return { request, valid: true };
}
