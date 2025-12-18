import type { ModalView, KnownBlock } from '@slack/types';
import { buildBalanceBlocks } from './balance.message';
import type { BalanceSummary } from '../services/balance.service';
import { plainText, mrkdwn, section, header, context } from '../utils/blocks';
import type { TeamWithMembers } from '../services/team.service';
import type { LeaveType, User } from '@prisma/client';

// ============================================
// Shared Helpers
// ============================================

/**
 * Build a boolean Yes/No select element
 */
function buildBooleanSelect(
  actionId: string,
  currentValue: boolean,
  options?: { yesLabel?: string; noLabel?: string }
) {
  const yesLabel = options?.yesLabel ?? 'Yes';
  const noLabel = options?.noLabel ?? 'No';

  return {
    type: 'static_select' as const,
    action_id: actionId,
    initial_option: {
      text: plainText(currentValue ? yesLabel : noLabel),
      value: currentValue ? 'true' : 'false',
    },
    options: [
      { text: plainText(yesLabel), value: 'true' },
      { text: plainText(noLabel), value: 'false' },
    ],
  };
}

/**
 * Build leave type options for select (filters to balance-affecting types)
 */
function buildLeaveTypeOptions(leaveTypes: LeaveType[]) {
  return leaveTypes
    .filter((lt) => lt.affectsBalance)
    .map((lt) => ({
      text: plainText(`${lt.emoji} ${lt.name}`),
      value: lt.id,
    }));
}

/**
 * Build time options for digest selector (6 AM - 6 PM, 30 min intervals)
 */
function buildTimeOptions() {
  const options = [];
  for (let hour = 6; hour <= 18; hour++) {
    for (const minute of [0, 30]) {
      const h = hour.toString().padStart(2, '0');
      const m = minute.toString().padStart(2, '0');
      const label =
        hour < 12
          ? `${hour}:${m} AM`
          : hour === 12
            ? `12:${m} PM`
            : `${hour - 12}:${m} PM`;
      options.push({
        text: plainText(label),
        value: `${h}:${m}`,
      });
    }
  }
  return options;
}

// ============================================
// Admin Settings
// ============================================

/**
 * Build main Admin Settings modal with interactive buttons
 */
export function buildAdminSettingsModal(): ModalView {
  return {
    type: 'modal',
    callback_id: 'admin_settings_main',
    title: plainText('Admin Settings'),
    close: plainText('Close'),
    blocks: [
      {
        type: 'header',
        text: plainText('⚙️ Admin Dashboard'),
      },
      {
        type: 'section',
        text: mrkdwn('Manage your Absentra workspace settings, teams, and users.'),
      },
      { type: 'divider' },

      // Team Management Section
      {
        type: 'section',
        text: mrkdwn('*👥 Team Management*\nCreate and manage teams, assign managers'),
        accessory: {
          type: 'button',
          text: plainText('Manage Teams'),
          action_id: 'admin_manage_teams',
          style: 'primary',
        },
      },

      // User Management Section
      {
        type: 'section',
        text: mrkdwn('*👤 User Management*\nAssign users to teams, manage roles'),
        accessory: {
          type: 'button',
          text: plainText('Manage Users'),
          action_id: 'admin_manage_users',
        },
      },


      // Leave Types Section
      {
        type: 'section',
        text: mrkdwn('*📋 Leave Types*\nConfigure leave categories, approval rules, and reminder messages'),
        accessory: {
          type: 'button',
          text: plainText('Leave Types'),
          action_id: 'admin_leave_types',
          style: 'primary',
        },
      },

      // Settings Section
      {
        type: 'section',
        text: mrkdwn('*🔧 Workspace Settings*\nConfigure notifications and preferences'),
        accessory: {
          type: 'button',
          text: plainText('Settings'),
          action_id: 'admin_workspace_settings',
        },
      },

      { type: 'divider' },
      {
        type: 'context',
        elements: [mrkdwn('_Only workspace admins can access these settings._')],
      },
    ],
  };
}

// ============================================
// Team Management
// ============================================

/**
 * Build team management modal
 */
export function buildTeamManagementModal(teams: TeamWithMembers[]): ModalView {
  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: mrkdwn(
        '*Team Management*\n\nTeams help organize leave approvals. Managers can approve requests from their team members.'
      ),
    },
    { type: 'divider' },
  ];

  if (teams.length === 0) {
    blocks.push({
      type: 'section',
      text: mrkdwn('_No teams created yet. Create your first team to get started._'),
    });
  } else {
    for (const team of teams) {
      const managers = team.managers.map((m) => `<@${m.slackId}>`).join(', ') || '_None_';
      const memberCount = team.members.length;

      blocks.push(
        {
          type: 'section',
          text: mrkdwn(
            `*${(team as any).name}*\n` +
              `${(team as any).description || '_No description_'}\n\n` +
              `👔 Managers: ${managers}\n` +
              `👥 Members: ${memberCount}`
          ),
        },
        {
          type: 'actions',
          block_id: `team_actions_${(team as any).id}`,
          elements: [
            {
              type: 'button',
              text: plainText('Edit'),
              action_id: 'edit_team',
              value: (team as any).id,
            },
            {
              type: 'button',
              text: plainText('Add Members'),
              action_id: 'add_team_members',
              value: (team as any).id,
            },
            {
              type: 'button',
              text: plainText('Delete'),
              action_id: 'delete_team',
              value: (team as any).id,
              style: 'danger',
              confirm: {
                title: plainText('Delete Team'),
                text: mrkdwn(`Are you sure you want to delete *${(team as any).name}*? Members will be unassigned.`),
                confirm: plainText('Delete'),
                deny: plainText('Cancel'),
              },
            },
          ],
        },
        { type: 'divider' }
      );
    }
  }

  blocks.push({
    type: 'actions',
    block_id: 'team_management_actions',
    elements: [
      {
        type: 'button',
        text: plainText('➕ Create New Team'),
        action_id: 'create_team_modal',
        style: 'primary',
      },
    ],
  });

  return {
    type: 'modal',
    callback_id: 'team_management',
    title: plainText('Team Management'),
    close: plainText('Back'),
    blocks,
  };
}

/**
 * Build create team modal
 */
export function buildCreateTeamModal(): ModalView {
  return {
    type: 'modal',
    callback_id: 'create_team_submit',
    title: plainText('Create Team'),
    submit: plainText('Create'),
    close: plainText('Cancel'),
    blocks: [
      {
        type: 'input',
        block_id: 'team_name_block',
        label: plainText('Team Name'),
        element: {
          type: 'plain_text_input',
          action_id: 'team_name',
          placeholder: plainText('e.g., Engineering, Marketing'),
          max_length: 100,
        },
      },
      {
        type: 'input',
        block_id: 'team_description_block',
        optional: true,
        label: plainText('Description'),
        element: {
          type: 'plain_text_input',
          action_id: 'team_description',
          placeholder: plainText('Brief description of the team'),
          multiline: true,
          max_length: 500,
        },
      },
      {
        type: 'input',
        block_id: 'team_managers_block',
        optional: true,
        label: plainText('Team Managers'),
        element: {
          type: 'multi_users_select',
          action_id: 'team_managers',
          placeholder: plainText('Select managers'),
        },
      },
    ],
  };
}

/**
 * Build edit team modal
 */
export function buildEditTeamModal(team: TeamWithMembers): ModalView {
  return {
    type: 'modal',
    callback_id: 'edit_team_submit',
    private_metadata: (team as any).id,
    title: plainText('Edit Team'),
    submit: plainText('Save Changes'),
    close: plainText('Cancel'),
    blocks: [
      {
        type: 'input',
        block_id: 'team_name_block',
        label: plainText('Team Name'),
        element: {
          type: 'plain_text_input',
          action_id: 'team_name',
          initial_value: (team as any).name,
          max_length: 100,
        },
      },
      {
        type: 'input',
        block_id: 'team_description_block',
        optional: true,
        label: plainText('Description'),
        element: {
          type: 'plain_text_input',
          action_id: 'team_description',
          initial_value: (team as any).description || '',
          multiline: true,
          max_length: 500,
        },
      },
      {
        type: 'input',
        block_id: 'team_managers_block',
        optional: true,
        label: plainText('Team Managers'),
        element: {
          type: 'multi_users_select',
          action_id: 'team_managers',
          placeholder: plainText('Select managers'),
          initial_users: team.managers.map((m) => m.slackId),
        },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: mrkdwn(
          `*Current Members (${team.members.length}):*\n` +
            (team.members.map((m) => `<@${m.slackId}>`).join(', ') || '_No members_')
        ),
      },
    ],
  };
}

/**
 * Build add members to team modal
 */
export function buildAddTeamMembersModal(team: TeamWithMembers): ModalView {
  return {
    type: 'modal',
    callback_id: 'add_team_members_submit',
    private_metadata: (team as any).id,
    title: plainText('Add Team Members'),
    submit: plainText('Add Members'),
    close: plainText('Cancel'),
    blocks: [
      {
        type: 'section',
        text: mrkdwn(`Add members to *${(team as any).name}*`),
      },
      {
        type: 'input',
        block_id: 'members_block',
        label: plainText('Select Users'),
        element: {
          type: 'multi_users_select',
          action_id: 'team_members',
          placeholder: plainText('Select users to add'),
        },
      },
      {
        type: 'context',
        elements: [mrkdwn('_Selected users will be added to this team._')],
      },
    ],
  };
}

// ============================================
// User Management
// ============================================

/**
 * Build user management modal
 */
export function buildUserManagementModal(users: User[], teams: TeamWithMembers[]): ModalView {
  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: mrkdwn('*User Management*\n\nManage user roles and team assignments.'),
    },
    { type: 'divider' },
    {
      type: 'actions',
      block_id: 'user_quick_actions',
      elements: [
        {
          type: 'button',
          text: plainText('Assign User to Team'),
          action_id: 'admin_assign_user_modal',
          style: 'primary',
        },
        {
          type: 'button',
          text: plainText('Toggle Admin'),
          action_id: 'admin_toggle_admin_modal',
        },
      ],
    },
    { type: 'divider' },
  ];

  // Show admins
  const admins = users.filter((u) => u.isAdmin);
  if (admins.length > 0) {
    blocks.push({
      type: 'section',
      text: mrkdwn('*👑 Admins*\n' + admins.map((u) => `<@${u.slackId}>`).join(', ')),
    });
    blocks.push({ type: 'divider' });
  }

  // Show users by team
  for (const team of teams) {
    if (team.members.length > 0) {
      const managerIds = team.managers.map((m) => m.slackId);
      const memberList = team.members
        .map((m) => `<@${m.slackId}>${managerIds.includes(m.slackId) ? ' 👔' : ''}`)
        .join(', ');

      blocks.push({
        type: 'section',
        text: mrkdwn(`*${(team as any).name}*\n${memberList}`),
      });
    }
  }

  // Unassigned users
  const assignedUserIds = new Set(teams.flatMap((t) => t.members.map((m) => m.id)));
  const unassigned = users.filter((u) => !assignedUserIds.has(u.id));

  if (unassigned.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: mrkdwn('*Unassigned Users*\n' + unassigned.map((u) => `<@${u.slackId}>`).join(', ')),
      accessory: {
        type: 'button',
        text: plainText('🔄 Sync'),
        action_id: 'refresh_unassigned_users',
      },
    });
  }

  blocks.push(
    { type: 'divider' },
    { type: 'context', elements: [mrkdwn('_👔 = Team Manager_')] }
  );

  return {
    type: 'modal',
    callback_id: 'user_management',
    title: plainText('User Management'),
    close: plainText('Back'),
    blocks,
  };
}

/**
 * Build assign user to team modal
 */
export function buildAssignUserModal(teams: TeamWithMembers[]): ModalView {
  const teamOptions = teams.map((t) => ({
    text: plainText((t as any).name),
    value: (t as any).id,
  }));

  const blocks: KnownBlock[] = [
    {
      type: 'input',
      block_id: 'user_block',
      label: plainText('Select User'),
      element: {
        type: 'users_select',
        action_id: 'selected_user',
        placeholder: plainText('Select a user'),
      },
    },
  ];

  if (teamOptions.length > 0) {
    blocks.push({
      type: 'input',
      block_id: 'team_block',
      label: plainText('Select Team'),
      element: {
        type: 'static_select',
        action_id: 'selected_team',
        placeholder: plainText('Select a team'),
        options: teamOptions,
      },
    });
  } else {
    blocks.push({
      type: 'section',
      text: mrkdwn('⚠️ _No teams available. Create a team first._'),
    });
  }

  const modal: ModalView = {
    type: 'modal',
    callback_id: 'assign_user_submit',
    title: plainText('Assign to Team'),
    close: plainText('Cancel'),
    blocks,
  };

  if (teamOptions.length > 0) {
    modal.submit = plainText('Assign');
  }

  return modal;
}

/**
 * Build toggle admin modal
 */
export function buildToggleAdminModal(): ModalView {
  return {
    type: 'modal',
    callback_id: 'toggle_admin_submit',
    title: plainText('Toggle Admin'),
    submit: plainText('Toggle'),
    close: plainText('Cancel'),
    blocks: [
      {
        type: 'section',
        text: mrkdwn('Select a user to toggle their admin status.'),
      },
      {
        type: 'input',
        block_id: 'user_block',
        label: plainText('Select User'),
        element: {
          type: 'users_select',
          action_id: 'selected_user',
          placeholder: plainText('Select a user'),
        },
      },
      {
        type: 'context',
        elements: [mrkdwn('⚠️ _Admins have full access and can approve any request._')],
      },
    ],
  };
}

// ============================================
// Workspace Settings
// ============================================

/**
 * Build workspace settings modal
 */
export function buildWorkspaceSettingsModal(settings: {
  notificationChannelId: string | null;
  requireApproval: boolean;
  allowNegativeBalance: boolean;
  digestEnabled: boolean;
  digestHour: number;
  digestMinute: number;
  digestWeekdaysOnly: boolean;
  timezone: string;
}): ModalView {
  const timeOptions = buildTimeOptions();
  const currentDigestTime = `${settings.digestHour.toString().padStart(2, '0')}:${settings.digestMinute.toString().padStart(2, '0')}`;
  const currentDigestTimeOption =
    timeOptions.find((o) => o.value === currentDigestTime) || timeOptions.find((o) => o.value === '09:00');

  return {
    type: 'modal',
    callback_id: 'workspace_settings_submit',
    title: plainText('Settings'),
    submit: plainText('Save'),
    close: plainText('Cancel'),
    blocks: [
      {
        type: 'section',
        text: mrkdwn('*🔧 Workspace Settings*'),
      },
      { type: 'divider' },
      {
        type: 'section',
        text: mrkdwn('*📬 Daily Digest*'),
      },
      {
        type: 'input',
        block_id: 'notification_channel_block',
        optional: true,
        label: plainText('Notification Channel'),
        element: {
          type: 'channels_select',
          action_id: 'notification_channel',
          placeholder: plainText('Select a channel'),
          ...(settings.notificationChannelId && { initial_channel: settings.notificationChannelId }),
        },
      },
      {
        type: 'input',
        block_id: 'digest_enabled_block',
        label: plainText('Enable Daily Digest'),
        element: buildBooleanSelect('digest_enabled', settings.digestEnabled),
      },
      {
        type: 'context',
        elements: [mrkdwn('_Send a daily summary of who\'s out to the channel_')],
      },
      {
        type: 'input',
        block_id: 'digest_time_block',
        label: plainText('Digest Time'),
        element: {
          type: 'static_select',
          action_id: 'digest_time',
          ...(currentDigestTimeOption ? { initial_option: currentDigestTimeOption } : {}),
          options: timeOptions,
        } as any,
      },
      {
        type: 'context',
        elements: [mrkdwn('_Time to send daily digest (in your workspace timezone)_')],
      },
      {
        type: 'input',
        block_id: 'digest_weekdays_block',
        label: plainText('Weekdays Only'),
        element: buildBooleanSelect('digest_weekdays_only', settings.digestWeekdaysOnly),
      },
      {
        type: 'context',
        elements: [mrkdwn('_Only send digest on Monday-Friday_')],
      },
      { type: 'divider' },
      {
        type: 'section',
        text: mrkdwn('*⚙️ Leave Requests*'),
      },
      {
        type: 'input',
        block_id: 'require_approval_block',
        label: plainText('Require Approval'),
        element: buildBooleanSelect('require_approval', settings.requireApproval),
      },
      {
        type: 'context',
        elements: [mrkdwn('_Whether leave requests require manager approval_')],
      },
      {
        type: 'input',
        block_id: 'negative_balance_block',
        label: plainText('Allow Negative Balance'),
        element: buildBooleanSelect('allow_negative', settings.allowNegativeBalance),
      },
      {
        type: 'context',
        elements: [mrkdwn('_Allow requests even with no remaining balance_')],
      },
    ],
  };
}

// ============================================
// Leave Types
// ============================================

/**
 * Build leave types management modal
 */
export function buildLeaveTypesModal(leaveTypes: LeaveType[]): ModalView {
  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: mrkdwn('*Leave Types*\n\nConfigure types of leave available in your workspace, including custom reminder messages for each type.'),
    },
    { type: 'divider' },
  ];

  if (leaveTypes.length === 0) {
    blocks.push({
      type: 'section',
      text: mrkdwn('_No leave types configured. Create your first leave type to get started._'),
    });
  } else {
    for (const lt of leaveTypes) {
      const status = lt.isActive ? '✅' : '❌';
      const approval = lt.requiresApproval ? 'Requires approval' : 'Auto-approved';
      const balance = lt.affectsBalance ? `${lt.defaultAllowance ?? '∞'} days/year` : 'No balance';
      const reminderStatus = lt.reminderEnabled ? '🔔 On' : '🔕 Off';

      blocks.push(
        {
          type: 'section',
          text: mrkdwn(`${status} ${lt.emoji} *${lt.name}*\n${approval} • ${balance} • ${reminderStatus}`),
        },
        //...(lt.customReminderMessage ? [{
        //  type: 'context' as const,
        //  elements: [mrkdwn(`_💬 Custom message template: "${lt.customReminderMessage}"_`)],
        //}] : [{
        //  type: 'context' as const,
        //  elements: [
        //    mrkdwn('_💬 Using default reminder message template:_'),
        //    mrkdwn(`_• Before leave: "📅 Reminder: Your ${lt.name} leave starts tomorrow. Please ensure your work is handed over and any preparations are complete."_`),
        //    mrkdwn(`_• During leave: "🌴 Checking in during your ${lt.name} leave. Hope you're having a restful time!"_`)
        //  ],
        //}]),
        {
          type: 'actions',
          block_id: `leave_type_actions_${lt.id}`,
          elements: [
            {
              type: 'button',
              text: plainText('Edit'),
              action_id: 'edit_leave_type',
              value: lt.id,
              style: 'primary',
            },
            {
              type: 'button',
              text: plainText(lt.isActive ? 'Deactivate' : 'Activate'),
              action_id: 'toggle_leave_type',
              value: lt.id,
              ...(lt.isActive ? { style: 'danger' } : { style: 'primary' }),
            },
          ],
        },
        { type: 'divider' }
      );
    }
  }

  blocks.push({
    type: 'actions',
    block_id: 'leave_type_management_actions',
    elements: [
      {
        type: 'button',
        text: plainText('➕ Create Leave Type'),
        action_id: 'create_leave_type_modal',
        style: 'primary',
      },
    ],
  });

  return {
    type: 'modal',
    callback_id: 'leave_types_management',
    title: plainText('Leave Types'),
    close: plainText('Back'),
    blocks,
  };
}

/**
 * Build create leave type modal
 */
export function buildCreateLeaveTypeModal(): ModalView {
  return {
    type: 'modal',
    callback_id: 'create_leave_type_submit',
    title: plainText('Create Leave Type'),
    submit: plainText('Create'),
    close: plainText('Cancel'),
    blocks: [
      {
        type: 'input',
        block_id: 'name_block',
        label: plainText('Name'),
        element: {
          type: 'plain_text_input',
          action_id: 'leave_type_name',
          placeholder: plainText('e.g., Vacation, Sick Leave'),
          max_length: 50,
        },
      },
      {
        type: 'input',
        block_id: 'emoji_block',
        label: plainText('Emoji'),
        element: {
          type: 'plain_text_input',
          action_id: 'leave_type_emoji',
          placeholder: plainText('e.g., 🏖️'),
          initial_value: '📅',
          max_length: 10,
        },
      },
      {
        type: 'input',
        block_id: 'allowance_block',
        optional: true,
        label: plainText('Default Allowance (days/year)'),
        element: {
          type: 'plain_text_input',
          action_id: 'leave_type_allowance',
          placeholder: plainText('Leave empty for unlimited'),
        },
      },
      {
        type: 'context',
        elements: [mrkdwn('_Number of days per year. Leave empty for unlimited._')],
      },
      {
        type: 'input',
        block_id: 'requires_approval_block',
        label: plainText('Requires Approval'),
        element: buildBooleanSelect('requires_approval', true),
      },
      {
        type: 'input',
        block_id: 'affects_balance_block',
        label: plainText('Affects Balance'),
        element: buildBooleanSelect('affects_balance', true),
      },
      {
        type: 'context',
        elements: [mrkdwn('_Whether this leave type counts against user balance_')],
      },
      { type: 'divider' },
      {
        type: 'section',
        text: mrkdwn('*🔔 Default Reminder Settings*'),
      },
      {
        type: 'context',
        elements: [mrkdwn('_Configure default reminder settings for this leave type. These can be customized per user if needed._')],
      },
      {
        type: 'input',
        block_id: 'reminder_enabled_block',
        label: plainText('Enable Reminders'),
        element: buildBooleanSelect('reminder_enabled', true),
      },
      {
        type: 'context',
        elements: [mrkdwn('_Enable reminder messages for this leave type_')],
      },
      {
        type: 'input',
        block_id: 'reminder_time_block',
        label: plainText('Reminder Time'),
        element: {
          type: 'static_select',
          action_id: 'reminder_time',
          initial_option: { text: plainText('9:00 AM'), value: '09:00' },
          options: buildTimeOptions(),
        },
      },
      {
        type: 'context',
        elements: [mrkdwn('_Time to send reminder messages (in your workspace timezone)_')],
      },
      {
        type: 'input',
        block_id: 'reminder_weekdays_block',
        label: plainText('Weekdays Only'),
        element: buildBooleanSelect('reminder_weekdays_only', true),
      },
      {
        type: 'context',
        elements: [mrkdwn('_Only send reminders on Monday-Friday_')],
      },
      {
        type: 'input',
        block_id: 'pre_leave_enabled_block',
        label: plainText('Pre-leave Reminders'),
        element: buildBooleanSelect('pre_leave_enabled', true),
      },
      {
        type: 'context',
        elements: [mrkdwn('_Send reminders the day before leave starts_')],
      },
      {
        type: 'input',
        block_id: 'mid_leave_enabled_block',
        label: plainText('Mid-leave Check-ins'),
        element: buildBooleanSelect('mid_leave_enabled', true),
      },
      {
        type: 'context',
        elements: [mrkdwn('_Send check-ins during multi-day leaves (3+ days)_')],
      },
      {
        type: 'input',
        block_id: 'custom_message_block',
        optional: true,
        label: plainText('Custom Message Template'),
        element: {
          type: 'plain_text_input',
          action_id: 'custom_message',
          placeholder: plainText('Leave empty for default messages'),
          multiline: true,
        },
      },
      {
        type: 'context',
        elements: [mrkdwn('_Available variables: {userName}, {leaveType}, {emoji}, {startDate}, {endDate}, {totalDays}_')],
      },
      { type: 'context',
        elements: [
          mrkdwn('_💡 **Template Variables:**_'),
          mrkdwn('• `{userName}` - User\'s display name'),
          mrkdwn('• `{leaveType}` - Type of leave'),
          mrkdwn('• `{emoji}` - Leave type emoji'),
          mrkdwn('• `{startDate}` - Leave start date'),
          mrkdwn('• `{endDate}` - Leave end date'),
          mrkdwn('• `{totalDays}` - Total days of leave'),
        ],
      },
    ],
  };
}

/**
 * Build edit leave type modal
 */
export function buildEditLeaveTypeModal(leaveType: LeaveType): ModalView {
  const timeOptions = buildTimeOptions();
  const currentTime = `${leaveType.reminderHour.toString().padStart(2, '0')}:${leaveType.reminderMinute.toString().padStart(2, '0')}`;
  const currentTimeOption =
    timeOptions.find((o) => o.value === currentTime) || timeOptions.find((o) => o.value === '09:00');

  return {
    type: 'modal',
    callback_id: 'edit_leave_type_submit',
    private_metadata: leaveType.id,
    title: plainText('Edit Leave Type'),
    submit: plainText('Save'),
    close: plainText('Cancel'),
    blocks: [
      {
        type: 'input',
        block_id: 'name_block',
        label: plainText('Name'),
        element: {
          type: 'plain_text_input',
          action_id: 'leave_type_name',
          initial_value: leaveType.name,
          max_length: 50,
        },
      },
      {
        type: 'input',
        block_id: 'emoji_block',
        label: plainText('Emoji'),
        element: {
          type: 'plain_text_input',
          action_id: 'leave_type_emoji',
          initial_value: leaveType.emoji,
          max_length: 10,
        },
      },
      {
        type: 'input',
        block_id: 'allowance_block',
        optional: true,
        label: plainText('Default Allowance (days/year)'),
        element: {
          type: 'plain_text_input',
          action_id: 'leave_type_allowance',
          placeholder: plainText('Leave empty for unlimited'),
          ...(leaveType.defaultAllowance !== null && {
            initial_value: leaveType.defaultAllowance.toString(),
          }),
        },
      },
      {
        type: 'context',
        elements: [mrkdwn('_Number of days per year. Leave empty for unlimited._')],
      },
      {
        type: 'input',
        block_id: 'requires_approval_block',
        label: plainText('Requires Approval'),
        element: buildBooleanSelect('requires_approval', leaveType.requiresApproval),
      },
      {
        type: 'input',
        block_id: 'affects_balance_block',
        label: plainText('Affects Balance'),
        element: buildBooleanSelect('affects_balance', leaveType.affectsBalance),
      },
      {
        type: 'context',
        elements: [mrkdwn('_Whether this leave type counts against user balance_')],
      },
      { type: 'divider' },
      {
        type: 'section',
        text: mrkdwn('*🔔 Reminder Settings*'),
      },
      {
        type: 'input',
        block_id: 'reminder_enabled_block',
        label: plainText('Enable Reminders'),
        element: buildBooleanSelect('reminder_enabled', leaveType.reminderEnabled),
      },
      {
        type: 'context',
        elements: [mrkdwn('_Enable reminder messages for this leave type_')],
      },
      {
        type: 'input',
        block_id: 'reminder_time_block',
        label: plainText('Reminder Time'),
        element: {
          type: 'static_select',
          action_id: 'reminder_time',
          ...(currentTimeOption ? { initial_option: currentTimeOption } : {}),
          options: timeOptions,
        } as any,
      },
      {
        type: 'context',
        elements: [mrkdwn('_Time to send reminder messages (in your workspace timezone)_')],
      },
      {
        type: 'input',
        block_id: 'reminder_weekdays_block',
        label: plainText('Weekdays Only'),
        element: buildBooleanSelect('reminder_weekdays_only', leaveType.reminderWeekdaysOnly),
      },
      {
        type: 'context',
        elements: [mrkdwn('_Only send reminders on Monday-Friday_')],
      },
      {
        type: 'input',
        block_id: 'pre_leave_enabled_block',
        label: plainText('Pre-leave Reminders'),
        element: buildBooleanSelect('pre_leave_enabled', leaveType.preLeaveReminderEnabled),
      },
      {
        type: 'context',
        elements: [mrkdwn('_Send reminders the day before leave starts_')],
      },
      {
        type: 'input',
        block_id: 'mid_leave_enabled_block',
        label: plainText('Mid-leave Check-ins'),
        element: buildBooleanSelect('mid_leave_enabled', leaveType.midLeaveReminderEnabled),
      },
      {
        type: 'context',
        elements: [mrkdwn('_Send check-ins during multi-day leaves (3+ days)_')],
      },
      {
        type: 'input',
        block_id: 'custom_message_block',
        optional: true,
        label: plainText('Custom Message Template'),
        element: {
          type: 'plain_text_input',
          action_id: 'custom_message',
          placeholder: plainText('Leave empty for default messages'),
          multiline: true,
          ...(leaveType.customReminderMessage && { initial_value: leaveType.customReminderMessage }),
        },
      },
      {
        type: 'context',
        elements: [mrkdwn('_Available variables: {userName}, {leaveType}, {emoji}, {startDate}, {endDate}, {totalDays}_')],
      },
      { type: 'context',
        elements: [
          mrkdwn('_💡 **Template Variables:**_'+'\n'),
          mrkdwn('• `{userName}` - User\'s display name'+'\n'),
          mrkdwn('• `{leaveType}` - Type of leave'+'\n'),
          mrkdwn('• `{emoji}` - Leave type emoji'+'\n'),
          mrkdwn('• `{startDate}` - Leave start date'+'\n'),
          mrkdwn('• `{endDate}` - Leave end date'+'\n'),
          mrkdwn('• `{totalDays}` - Total days of leave'+'\n'),
        ],
      },
    ],
  };
}

// ============================================
// Balance Management
// ============================================

/**
 * Build balance management modal
 */
export function buildBalanceManagementModal(
  usersWithBalances: Array<{
    user: { slackId: string; displayName: string };
    balances: BalanceSummary[];
  }>,
  _leaveTypes: LeaveType[],
  page = 0
): ModalView {
  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: mrkdwn('*Balance Management*\n\nView and adjust user leave balances.'),
    },
    ...buildBalanceBlocks(usersWithBalances, {
      page,
      showActions: true,
      actionPrefix: 'admin_balances',
    }),
  ];

  return {
    type: 'modal',
    callback_id: 'balance_management',
    private_metadata: JSON.stringify({ page }),
    title: plainText('Balances'),
    close: plainText('Back'),
    blocks,
  };
}

/**
 * Action types for unified balance modal
 */
export type BalanceActionType = 'adjust_balance' | 'set_allowance' | 'auto_approve';

/**
 * Build action-specific fields based on the selected action type
 */
function buildActionSpecificFields(actionType: BalanceActionType): KnownBlock[] {
  switch (actionType) {
    case 'adjust_balance':
      return [
        {
          type: 'input',
          block_id: 'adjustment_block',
          label: plainText('Adjustment (days)'),
          element: {
            type: 'plain_text_input',
            action_id: 'adjustment_value',
            placeholder: plainText('e.g., 5 or -3'),
          },
        },
        {
          type: 'context',
          elements: [mrkdwn('_Use positive to add days, negative to subtract_')],
        },
      ];
    case 'set_allowance':
      return [
        {
          type: 'input',
          block_id: 'allowance_block',
          label: plainText('New Allowance (days)'),
          element: {
            type: 'plain_text_input',
            action_id: 'allowance_value',
            placeholder: plainText('e.g., 20'),
          },
        },
        {
          type: 'context',
          elements: [mrkdwn('_Total days allowed for this year_')],
        },
      ];
    case 'auto_approve':
      return [
        {
          type: 'input',
          block_id: 'auto_approve_block',
          label: plainText('Auto-Approve'),
          element: buildBooleanSelect('auto_approve_enabled', true, {
            yesLabel: 'Enable',
            noLabel: 'Disable',
          }),
        },
        {
          type: 'context',
          elements: [mrkdwn('_Enable to auto-approve future requests for this user and leave type_')],
        },
        {
          type: 'input',
          block_id: 'max_days_block',
          optional: true,
          label: plainText('Max Days'),
          element: {
            type: 'plain_text_input',
            action_id: 'max_days_value',
            placeholder: plainText('e.g., 3'),
          },
        },
        {
          type: 'context',
          elements: [mrkdwn('_Auto-approve up to this many days. Requests exceeding this require manual approval. Leave empty for unlimited._')],
        },
      ];
  }
}

/**
 * Get description text for each action type
 */
function getActionDescription(actionType: BalanceActionType): string {
  switch (actionType) {
    case 'adjust_balance':
      return "Add or subtract days from a user's current balance.";
    case 'set_allowance':
      return "Set a user's total annual allowance for a leave type.";
    case 'auto_approve':
      return 'Configure auto-approval for a specific user and leave type.';
  }
}

/**
 * Build unified balance management modal with action dropdown
 */
export function buildUnifiedBalanceModal(
  leaveTypes: LeaveType[],
  actionType: BalanceActionType = 'adjust_balance'
): ModalView {
  const typeOptions = buildLeaveTypeOptions(leaveTypes);

  const actionOptions = [
    { text: plainText('➕ Adjust Balance'), value: 'adjust_balance' },
    { text: plainText('📝 Set Allowance'), value: 'set_allowance' },
    { text: plainText('✅ Auto-Approve'), value: 'auto_approve' },
  ];

  const currentActionOption = actionOptions.find(o => o.value === actionType) || actionOptions[0];

  return {
    type: 'modal',
    callback_id: 'unified_balance_submit',
    private_metadata: JSON.stringify({ actionType }),
    title: plainText('Manage Balance'),
    submit: plainText('Apply'),
    close: plainText('Cancel'),
    blocks: [
      {
        type: 'input',
        block_id: 'action_type_block',
        dispatch_action: true,
        label: plainText('Action'),
        element: {
          type: 'static_select',
          action_id: 'balance_action_type_change',
          ...(currentActionOption ? { initial_option: currentActionOption } : {}),
          options: actionOptions,
        } as any,
      },
      {
        type: 'context',
        elements: [mrkdwn(`_${getActionDescription(actionType)}_`)],
      },
      { type: 'divider' },
      {
        type: 'input',
        block_id: 'user_block',
        label: plainText('User'),
        element: {
          type: 'users_select',
          action_id: 'selected_user',
          placeholder: plainText('Select a user'),
        },
      },
      {
        type: 'input',
        block_id: 'leave_type_block',
        label: plainText('Leave Type'),
        element: {
          type: 'static_select',
          action_id: 'selected_leave_type',
          placeholder: plainText('Select leave type'),
          options: typeOptions,
        },
      },
      ...buildActionSpecificFields(actionType),
    ],
  };
}

/**
 * Build adjust balance modal (legacy - redirects to unified modal)
 * @deprecated Use buildUnifiedBalanceModal instead
 */
export function buildAdjustBalanceModal(leaveTypes: LeaveType[]): ModalView {
  return buildUnifiedBalanceModal(leaveTypes, 'adjust_balance');
}

/**
 * Build set allowance modal (legacy - redirects to unified modal)
 * @deprecated Use buildUnifiedBalanceModal instead
 */
export function buildSetAllowanceModal(leaveTypes: LeaveType[]): ModalView {
  return buildUnifiedBalanceModal(leaveTypes, 'set_allowance');
}

// ============================================
// Help
// ============================================

/**
 * Build admin help message (for slash command fallback)
 */
export function buildAdminHelpMessage(): KnownBlock[] {
  return [
    header('⚙️ Admin Commands'),
    section(
      '*Team Management*\n' +
        '`/pto admin teams` - View and manage teams\n\n' +
        '*User Management*\n' +
        '`/pto admin users` - View and manage users\n\n' +
        '*Settings*\n' +
        '`/pto admin settings` - View current settings\n\n' +
        '_💡 Tip: Use the Home tab → Admin Settings for an interactive experience!_'
    ),
    context(['_Admin commands are only available to workspace admins._']),
  ];
}
