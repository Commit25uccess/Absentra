import type { App } from '@slack/bolt';
import { getOrCreateUser } from '../services/user.service';
import { createLeaveRequest, cancelLeaveRequest, getLeaveRequestById } from '../services/leave-request.service';
import { hasSufficientBalance } from '../services/balance.service';
import { getLeaveTypeById } from '../services/leave-type.service';
import { parseSlackDate, formatDate } from '../utils/dates';
import {
  buildLeaveRequestConfirmation,
  buildLeaveRequestModal,
  calculateLeaveWarnings,
  type LeaveDuration,
  type LeaveModalState,
} from '../views/leave-request.modal';
import { sendApprovalRequest } from './approval.actions';
import { refreshUserHomeTab } from '../utils/slack-helpers';
import logger from '../utils/logger';
import { prisma } from '../db/client';

/**
 * Register leave request related actions and view submissions
 */
export function registerLeaveRequestActions(app: App): void {
  /**
   * Helper to extract current modal state from view values
   */
  function extractModalState(values: any): LeaveModalState {
    return {
      duration: values.duration_block?.leave_duration?.selected_option?.value as LeaveDuration || 'one_day',
      startDate: values.start_date_block?.start_date?.selected_date,
      endDate: values.end_date_block?.end_date?.selected_date,
      leaveTypeId: values.leave_type_block?.leave_type?.selected_option?.value,
      halfDayPeriod: values.half_day_period_block?.half_day_period?.selected_option?.value,
    };
  }

  /**
   * Helper to update modal with current state and warnings
   */
  async function updateModalWithWarnings(
    client: any,
    viewId: string,
    userId: string,
    state: LeaveModalState
  ): Promise<void> {
    // Get workspace settings to check allowNegativeBalance
    const settings = await prisma.settings.findUnique({ where: { id: 'default' } });
    const allowNegativeBalance = settings?.allowNegativeBalance ?? false;

    // Calculate warnings based on current state
    const warnings = await calculateLeaveWarnings(userId, state, allowNegativeBalance);

    // Build and update modal
    const updatedModal = await buildLeaveRequestModal(userId, state, warnings);
    await client.views.update({
      view_id: viewId,
      view: updatedModal,
    });
  }

  // Handle duration selector change - update modal dynamically
  app.action('leave_duration', async ({ ack, body, client }) => {
    await ack();

    const userId = body.user.id;
    const view = (body as any).view;
    const values = view.state.values;

    // Extract current form values
    const state = extractModalState(values);
    // Ensure end date defaults to start date if not set
    if (!state.endDate) {
      state.endDate = state.startDate;
    }

    try {
      await updateModalWithWarnings(client, view.id, userId, state);
    } catch (error) {
      logger.error('Error updating leave request modal', error, { userId });
    }
  });

  // Handle leave type change - validate balance
  app.action('leave_type', async ({ ack, body, client }) => {
    await ack();

    const userId = body.user.id;
    const view = (body as any).view;
    const values = view.state.values;

    const state = extractModalState(values);

    try {
      await updateModalWithWarnings(client, view.id, userId, state);
    } catch (error) {
      logger.error('Error updating leave request modal on type change', error, { userId });
    }
  });

  // Handle start date change - validate dates and balance
  app.action('start_date', async ({ ack, body, client }) => {
    await ack();

    const userId = body.user.id;
    const view = (body as any).view;
    const values = view.state.values;

    const state = extractModalState(values);
    // For single day/half day, sync end date with start date
    if (state.duration !== 'multiple_days') {
      state.endDate = state.startDate;
    }

    try {
      await updateModalWithWarnings(client, view.id, userId, state);
    } catch (error) {
      logger.error('Error updating leave request modal on start date change', error, { userId });
    }
  });

  // Handle end date change - validate dates and balance
  app.action('end_date', async ({ ack, body, client }) => {
    await ack();

    const userId = body.user.id;
    const view = (body as any).view;
    const values = view.state.values;

    const state = extractModalState(values);

    try {
      await updateModalWithWarnings(client, view.id, userId, state);
    } catch (error) {
      logger.error('Error updating leave request modal on end date change', error, { userId });
    }
  });

  // Handle leave request modal submission
  app.view('leave_request_submit', async ({ ack, body, view, client }) => {
    const userId = body.user.id;
    const values = view.state.values;

    try {
      // Extract form values
      const leaveTypeId = values.leave_type_block?.leave_type?.selected_option?.value;
      const duration = values.duration_block?.leave_duration?.selected_option?.value as LeaveDuration || 'one_day';
      const startDateStr = values.start_date_block?.start_date?.selected_date;
      const endDateStr = values.end_date_block?.end_date?.selected_date;
      const halfDayPeriod = values.half_day_period_block?.half_day_period?.selected_option?.value;
      const reason = values.reason_block?.reason?.value;
      const teamNotes = values.team_notes_block?.team_notes?.value;

      // Validate required fields
      const errors: Record<string, string> = {};

      if (!leaveTypeId) {
        errors.leave_type_block = 'Please select a leave type';
      }
      if (!startDateStr) {
        errors.start_date_block = 'Please select a date';
      }
      if (duration === 'multiple_days' && !endDateStr) {
        errors.end_date_block = 'Please select an end date';
      }
      if (duration === 'half_day' && !halfDayPeriod) {
        errors.half_day_period_block = 'Please select morning or afternoon';
      }
      if (!reason) {
        errors.reason_block = 'Please provide a reason for your leave request';
      }

      if (Object.keys(errors).length > 0) {
        await ack({
          response_action: 'errors',
          errors,
        });
        return;
      }

      const startDate = parseSlackDate(startDateStr!);
      // For one day or half day, end date is same as start date
      const endDate = duration === 'multiple_days' && endDateStr
        ? parseSlackDate(endDateStr)
        : startDate;

      // Check if dates are in the past
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (startDate < today) {
        await ack({
          response_action: 'errors',
          errors: {
            start_date_block: 'This date is in the past. Please select today or a future date.',
          },
        });
        return;
      }

      // Validate date range for multiple days
      if (duration === 'multiple_days') {
        if (endDate < startDate) {
          await ack({
            response_action: 'errors',
            errors: {
              end_date_block: 'End date must be on or after the start date.',
            },
          });
          return;
        }

        // Also check if end date is somehow in the past (shouldn't happen if start is valid, but safety check)
        if (endDate < today) {
          await ack({
            response_action: 'errors',
            errors: {
              end_date_block: 'This date is in the past. Please select today or a future date.',
            },
          });
          return;
        }
      }

      // Get leave type to check if it affects balance
      const leaveType = await getLeaveTypeById(leaveTypeId!);
      if (!leaveType) {
        await ack({
          response_action: 'errors',
          errors: {
            leave_type_block: 'Invalid leave type selected',
          },
        });
        return;
      }

      // Check balance if needed
      const isHalfDay = duration === 'half_day';
      if (leaveType.affectsBalance) {
        // Rough estimate - actual calculation happens in service
        const estimatedDays = isHalfDay ? 0.5 : Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;

        const { sufficient, remaining, allowNegative } = await hasSufficientBalance(
          userId,
          leaveTypeId!,
          estimatedDays
        );

        if (!sufficient && !allowNegative) {
          await ack({
            response_action: 'errors',
            errors: {
              leave_type_block: `Insufficient balance. You have ${remaining} days remaining.`,
            },
          });
          return;
        }
      }

      // Create the leave request
      const request = await createLeaveRequest({
        requesterSlackId: userId,
        leaveTypeId: leaveTypeId!,
        startDate,
        endDate,
        isHalfDay,
        halfDayPeriod: isHalfDay ? (halfDayPeriod as 'morning' | 'afternoon') : undefined,
        reason: reason!,
        teamNotes: teamNotes || undefined,
      });

      logger.request('created', request.id, userId, {
        leaveType: request.leaveType.name,
        startDate: formatDate(request.startDate),
        endDate: formatDate(request.endDate),
        totalDays: request.totalDays,
        status: request.status,
      });

      // If requires approval, send to approvers
      const requiresApproval = request.status === 'PENDING';
      if (requiresApproval) {
        await sendApprovalRequest(client, request);
      }

      // Show confirmation
      await ack({
        response_action: 'update',
        view: buildLeaveRequestConfirmation(
          request.leaveType.name,
          request.leaveType.emoji,
          request.startDate,
          request.endDate,
          request.totalDays,
          request.status,
          requiresApproval
        ),
      });

      // Refresh user's home tab (non-blocking)
      refreshUserHomeTab(client, userId).catch(err =>
        logger.warn('Error refreshing home tab after leave request', { error: err })
      );
    } catch (error) {
      logger.error('Error submitting leave request', error, { userId });
      await ack({
        response_action: 'errors',
        errors: {
          leave_type_block: error instanceof Error ? error.message : 'An error occurred',
        },
      });
    }
  });

  // Handle cancel request action
  app.action('cancel_request', async ({ ack, body, client, action }) => {
    await ack();

    const userId = body.user.id;
    const requestId = (action as any).value;

    logger.action('cancel_request', userId, { requestId });

    try {
      const request = await cancelLeaveRequest(requestId, userId);

      logger.request('cancelled', requestId, userId, {
        leaveType: request.leaveType.name,
      });

      // Send confirmation message
      await client.chat.postEphemeral({
        channel: (body as any).channel?.id || userId,
        user: userId,
        text: `✅ Your ${request.leaveType.emoji} ${request.leaveType.name} request has been cancelled.`,
      });

      // Update the original message if possible
      if ((body as any).message?.ts && (body as any).channel?.id) {
        await client.chat.update({
          channel: (body as any).channel.id,
          ts: (body as any).message.ts,
          text: 'Request cancelled',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `🚫 This leave request has been cancelled.`,
              },
            },
          ],
        });
      }

      // Refresh user's home tab (non-blocking)
      refreshUserHomeTab(client, userId).catch(err =>
        logger.warn('Error refreshing home tab after cancellation', { error: err })
      );
    } catch (error) {
      logger.error('Error cancelling request', error, { userId, requestId });
      await client.chat.postEphemeral({
        channel: (body as any).channel?.id || userId,
        user: userId,
        text: `❌ Error: ${error instanceof Error ? error.message : 'Could not cancel request'}`,
      });
    }
  });
}
