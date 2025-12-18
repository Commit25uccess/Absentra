import type { ModalView, KnownBlock } from '@slack/types';
import { getAllLeaveTypes } from '../services/leave-type.service';
import { getUserBalances, getBalance } from '../services/balance.service';
import { toSlackDateFormat, getToday, formatDate, parseSlackDate } from '../utils/dates';
import { plainText, mrkdwn, formatDuration } from '../utils/blocks';

export type LeaveDuration = 'one_day' | 'half_day' | 'multiple_days';

export interface LeaveModalState {
  duration: LeaveDuration;
  startDate?: string;
  endDate?: string;
  leaveTypeId?: string;
  halfDayPeriod?: string;
}

export interface LeaveModalWarning {
  type: 'balance' | 'date' | 'info';
  severity: 'error' | 'warning' | 'info';
  message: string;
}

/** Duration options for leave request */
const DURATION_OPTIONS: Record<LeaveDuration, { label: string; value: LeaveDuration }> = {
  one_day: { label: 'One day', value: 'one_day' },
  half_day: { label: 'Half day', value: 'half_day' },
  multiple_days: { label: 'Multiple days', value: 'multiple_days' },
};

/**
 * Get the option object for a duration value
 */
function getDurationOption(duration: LeaveDuration) {
  const opt = DURATION_OPTIONS[duration];
  return { text: plainText(opt.label), value: opt.value };
}

/**
 * Get all duration options for select
 */
function getAllDurationOptions() {
  return Object.values(DURATION_OPTIONS).map((opt) => ({
    text: plainText(opt.label),
    value: opt.value,
  }));
}

/**
 * Build the leave request modal
 */
export async function buildLeaveRequestModal(
  userSlackId: string,
  state?: LeaveModalState,
  warnings?: LeaveModalWarning[]
): Promise<ModalView> {
  const leaveTypes = await getAllLeaveTypes();
  const balances = await getUserBalances(userSlackId);
  const today = toSlackDateFormat(getToday());

  const currentState: LeaveModalState = state || {
    duration: 'one_day',
    startDate: today,
    endDate: today,
  };

  const balanceInfo = balances
    .map((b) => `${b.leaveType.emoji} ${b.leaveType.name}: *${b.remaining}* days remaining`)
    .join('\n');

  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: mrkdwn('📅 *Request Time Off*\n\nFill out the form below to submit your leave request.'),
    },
    { type: 'divider' },
    {
      type: 'section',
      text: mrkdwn('*Your Current Balances:*\n' + balanceInfo),
    },
    { type: 'divider' },
    {
      type: 'input',
      block_id: 'leave_type_block',
      label: plainText('Leave Type'),
      element: {
        type: 'static_select',
        action_id: 'leave_type',
        placeholder: plainText('Select leave type'),
        options: leaveTypes.map((lt) => ({
          text: plainText(`${lt.emoji} ${lt.name}`),
          value: lt.id,
        })),
        ...(currentState.leaveTypeId ? (() => {
          const lt = leaveTypes.find((t) => t.id === currentState.leaveTypeId);
          return lt ? { initial_option: { text: plainText(`${lt.emoji} ${lt.name}`), value: lt.id } as const } : {};
        })() : ({} as Record<string, never>)),
      },
      dispatch_action: true,
    },
    {
      type: 'input',
      block_id: 'duration_block',
      label: plainText('Leave Duration'),
      element: {
        type: 'static_select',
        action_id: 'leave_duration',
        placeholder: plainText('Select duration'),
        options: getAllDurationOptions(),
        initial_option: getDurationOption(currentState.duration),
      },
      dispatch_action: true,
    },
  ];

  // Date field - label changes based on duration
  const dateLabel = currentState.duration === 'multiple_days' ? 'Start Date' : 'Date';
  blocks.push({
    type: 'input',
    block_id: 'start_date_block',
    label: plainText(dateLabel),
    element: {
      type: 'datepicker',
      action_id: 'start_date',
      placeholder: plainText('Select date'),
      initial_date: currentState.startDate || today,
    },
    dispatch_action: true,
  });

  // Show end date only for multiple days
  if (currentState.duration === 'multiple_days') {
    blocks.push({
      type: 'input',
      block_id: 'end_date_block',
      label: plainText('End Date'),
      element: {
        type: 'datepicker',
        action_id: 'end_date',
        placeholder: plainText('Select end date'),
        initial_date: currentState.endDate || currentState.startDate || today,
      },
      dispatch_action: true,
    });
  }

  // Show warnings/errors if any
  if (warnings && warnings.length > 0) {
    const errors = warnings.filter((w) => w.severity === 'error');
    const warningsOnly = warnings.filter((w) => w.severity !== 'error');

    if (errors.length > 0) {
      blocks.push({
        type: 'section',
        block_id: 'validation_errors',
        text: mrkdwn(
          '🚫 *Cannot submit this request:*\n' +
          errors.map((e) => `• ${e.message}`).join('\n')
        ),
      });
    }

    for (const warning of warningsOnly) {
      const emoji = warning.severity === 'warning' ? '⚠️' : 'ℹ️';
      blocks.push({
        type: 'context',
        block_id: `warning_${warning.type}`,
        elements: [mrkdwn(`${emoji} ${warning.message}`)],
      });
    }
  }

  // Show half day period selector
  if (currentState.duration === 'half_day') {
    blocks.push({
      type: 'input',
      block_id: 'half_day_period_block',
      label: plainText('Which half?'),
      element: {
        type: 'static_select',
        action_id: 'half_day_period',
        placeholder: plainText('Select morning or afternoon'),
        options: [
          { text: plainText('Morning'), value: 'morning' },
          { text: plainText('Afternoon'), value: 'afternoon' },
        ],
        ...(currentState.halfDayPeriod ? {
          initial_option: {
            text: plainText(currentState.halfDayPeriod === 'morning' ? 'Morning' : 'Afternoon'),
            value: currentState.halfDayPeriod,
          },
        } : ({} as Record<string, never>)),
      },
    });
  }

  // Reason field
  blocks.push({
    type: 'input',
    block_id: 'reason_block',
    label: plainText('Reason (private)'),
    element: {
      type: 'plain_text_input',
      action_id: 'reason',
      placeholder: plainText('e.g., Medical appointment, Family event'),
      multiline: true,
      max_length: 500,
    },
    hint: plainText('Only visible to your manager and admins'),
  });

  // Team notes field
  blocks.push({
    type: 'input',
    block_id: 'team_notes_block',
    label: plainText('Notes for colleagues'),
    optional: true,
    element: {
      type: 'plain_text_input',
      action_id: 'team_notes',
      placeholder: plainText('e.g., Contact John for urgent matters'),
      multiline: true,
      max_length: 500,
    },
    hint: plainText("Visible to everyone viewing who's out (optional)"),
  });

  // Context
  blocks.push({
    type: 'context',
    elements: [
      mrkdwn('💡 _Weekends and public holidays are automatically excluded from your leave days._'),
    ],
  });

  return {
    type: 'modal',
    callback_id: 'leave_request_submit',
    private_metadata: JSON.stringify(currentState),
    title: plainText('Request Time Off'),
    submit: plainText('Submit Request'),
    close: plainText('Cancel'),
    blocks,
  };
}

/**
 * Calculate warnings and errors for the current state
 */
export async function calculateLeaveWarnings(
  userSlackId: string,
  state: LeaveModalState,
  allowNegativeBalance = false
): Promise<LeaveModalWarning[]> {
  const warnings: LeaveModalWarning[] = [];
  const today = getToday();
  today.setHours(0, 0, 0, 0);

  const startDate = state.startDate ? parseSlackDate(state.startDate) : null;
  const endDate = state.endDate ? parseSlackDate(state.endDate) : null;

  // Check if start date is in the past
  if (startDate && startDate < today) {
    warnings.push({
      type: 'date',
      severity: 'error',
      message: 'Start date is in the past. Please select today or a future date.',
    });
  }

  // Check if end date is before start date (for multiple days)
  if (state.duration === 'multiple_days' && startDate && endDate) {
    if (endDate < startDate) {
      warnings.push({
        type: 'date',
        severity: 'error',
        message: 'End date must be on or after the start date.',
      });
    } else if (endDate < today) {
      warnings.push({
        type: 'date',
        severity: 'error',
        message: 'End date is in the past. Please select today or a future date.',
      });
    }
  }

  // Check balance if leave type is selected
  if (state.leaveTypeId && startDate) {
    const balance = await getBalance(userSlackId, state.leaveTypeId);

    if (balance && balance.leaveType.affectsBalance) {
      let estimatedDays = 1;

      if (state.duration === 'half_day') {
        estimatedDays = 0.5;
      } else if (state.duration === 'multiple_days' && endDate) {
        const calendarDays =
          Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
        estimatedDays = Math.ceil((calendarDays * 5) / 7);
      }

      if (estimatedDays > balance.remaining) {
        const severity = allowNegativeBalance ? 'warning' : 'error';
        warnings.push({
          type: 'balance',
          severity,
          message: `Insufficient balance. You have ${balance.remaining} days remaining for ${balance.leaveType.name}, but this request needs ~${estimatedDays} working days.`,
        });
      }
    }
  }

  return warnings;
}

/**
 * Build a confirmation view after submission
 */
export async function buildLeaveRequestConfirmation(
  leaveTypeName: string,
  leaveTypeEmoji: string,
  startDate: Date,
  endDate: Date,
  totalDays: number,
  status: string,
  requiresApproval: boolean
): Promise<ModalView> {
  const dateRange =
    startDate.getTime() === endDate.getTime()
      ? await formatDate(startDate)
      : `${await formatDate(startDate)} - ${await formatDate(endDate)}`;

  const statusMessage = requiresApproval
    ? '⏳ Your request has been submitted and is *pending approval*.'
    : '✅ Your request has been *automatically approved*.';

  return {
    type: 'modal',
    title: plainText('Request Submitted'),
    close: plainText('Done'),
    blocks: [
      {
        type: 'section',
        text: mrkdwn(`${statusMessage}\n\n*Details:*`),
      },
      {
        type: 'section',
        fields: [
          mrkdwn(`*Type:*\n${leaveTypeEmoji} ${leaveTypeName}`),
          mrkdwn(`*Duration:*\n${formatDuration(totalDays)}`),
          mrkdwn(`*Dates:*\n${dateRange}`),
          mrkdwn(`*Status:*\n${status}`),
        ],
      },
      {
        type: 'context',
        elements: [
          mrkdwn(
            requiresApproval
              ? '_Your manager will be notified and can approve or reject this request._'
              : '_This leave type does not require approval._'
          ),
        ],
      },
    ],
  };
}
