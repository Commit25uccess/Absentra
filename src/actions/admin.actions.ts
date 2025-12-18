import type { App } from '@slack/bolt';
import {
  getAllTeams,
  createTeam,
  updateTeam,
  getTeamById,
  addTeamManager,
  removeTeamManager,
  deleteTeam,
  addTeamMember,
} from '../services/team.service';
import {
  getOrCreateUser,
  isUserAdmin,
  getAllActiveUsers,
  setUserAdmin,
  assignUserToTeam,
  syncWorkspaceUsers,
} from '../services/user.service';
import { getSettings, updateSettings } from '../services/settings.service';
import logger from '../utils/logger';
import { prisma } from '../db/client';
import { handleExpiredTrigger } from '../utils/slack-helpers';
import {
  buildTeamManagementModal,
  buildCreateTeamModal,
  buildEditTeamModal,
  buildAdminSettingsModal,
  buildUserManagementModal,
  buildAssignUserModal,
  buildToggleAdminModal,
  buildWorkspaceSettingsModal,
  buildAddTeamMembersModal,
  buildLeaveTypesModal,
  buildCreateLeaveTypeModal,
  buildEditLeaveTypeModal,
  buildBalanceManagementModal,
  buildAdjustBalanceModal,
  buildSetAllowanceModal,
  buildUnifiedBalanceModal,
  type BalanceActionType,
} from '../views/admin.modal';
import { buildSuccessModal, buildErrorModal } from '../views/modal-result.view';
import {
  getAllLeaveTypes,
  getLeaveTypeById,
  createLeaveType,
  updateLeaveType,
} from '../services/leave-type.service';
import {
  getAllUsersBalances,
  adjustBalance,
  setAllowance,
} from '../services/balance.service';
import { updateLeavePolicy } from '../services/leave-policy.service';

type SlackClient = any;

interface ActionHandlerParams {
  ack: any;
  body: any;
  client: any;
  action?: any;
}

interface ViewHandlerParams {
  ack: any;
  body: any;
  view: any;
  client: any;
}

/**
 * Admin guard - checks if user is admin and sends error if not
 * Returns true if user is admin, false otherwise
 */
async function requireAdmin(
  client: SlackClient,
  userId: string,
  channelId?: string,
  silent = false
): Promise<boolean> {
  const isAdmin = await isUserAdmin(userId);
  if (!isAdmin && !silent) {
    await client.chat.postEphemeral({
      channel: channelId || userId,
      user: userId,
      text: '⚠️ You need to be an admin to perform this action.',
    });
  }
  return isAdmin;
}

/**
 * Ensure users exist in DB from Slack user IDs
 */
async function ensureUsersExist(client: SlackClient, userIds: string[]): Promise<void> {
  await Promise.all(
    userIds.map(async (userId) => {
      const userInfo = await client.users.info({ user: userId });
      if (userInfo.user) {
        await getOrCreateUser(userInfo.user as any);
      }
    })
  );
}

/**
 * Register admin-related actions
 */
export function registerAdminActions(app: App): void {
  // Open team management modal
  app.action('manage_teams', async ({ ack, body, client }: ActionHandlerParams) => {
    await ack();
    const userId = body.user.id;

    try {
      if (!await requireAdmin(client, userId, (body as any).channel?.id)) return;

      const teams = await getAllTeams();
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: buildTeamManagementModal(teams),
      });
    } catch (error) {
      if (await handleExpiredTrigger(client, error, userId)) return;
      logger.error({ event: 'team_management_modal_open_failed', userId }, error);
    }
  });

  // Open create team modal
  app.action('create_team_modal', async ({ ack, body, client }: ActionHandlerParams) => {
    await ack();
    await client.views.push({
      trigger_id: (body as any).trigger_id,
      view: buildCreateTeamModal(),
    });
  });

  // Handle create team submission
  app.view('create_team_submit', async ({ ack, view, client }: ViewHandlerParams) => {
    const values = view.state.values;

    try {
      const teamName = values.team_name_block.team_name.value;
      const description = values.team_description_block?.team_description?.value;
      const managerIds = values.team_managers_block?.team_managers?.selected_users || [];

      if (!teamName) {
        await ack({
          response_action: 'errors',
          errors: { team_name_block: 'Team name is required' },
        });
        return;
      }

      // Create team
      const team = await createTeam(teamName, description || undefined);

      // Add managers in parallel
      if (managerIds.length > 0) {
        await ensureUsersExist(client, managerIds);
        await Promise.all(managerIds.map((managerId: string) => addTeamManager(team.id, managerId)));
      }

      const managerNames = managerIds.map((id: string) => `<@${id}>`).join(', ');
      const details = [
        `Team: ${teamName}`,
        description ? `Description: ${description}` : undefined,
        managerIds.length > 0 ? `Managers: ${managerNames}` : undefined,
      ].filter(Boolean) as string[];

      await ack({
        response_action: 'update',
        view: buildSuccessModal(
          'Team Created',
          `The team *${teamName}* has been created successfully.`,
          details
        ),
      });
    } catch (error) {
      logger.error({ event: 'team_creation_failed' }, error);
      await ack({
        response_action: 'update',
        view: buildErrorModal(
          'Creation Failed',
          error instanceof Error ? error.message : 'Could not create team',
          ['Please try again or contact support if the issue persists.']
        ),
      });
    }
  });

  // Open edit team modal
  app.action('edit_team', async ({ ack, body, client, action }: ActionHandlerParams) => {
    await ack();
    const teamId = (action as any).value;

    try {
      const team = await getTeamById(teamId);
      if (!team) {
        throw new Error('Team not found');
      }

      await client.views.push({
        trigger_id: (body as any).trigger_id,
        view: buildEditTeamModal(team),
      });
    } catch (error) {
      logger.error({ event: 'edit_team_modal_open_failed', teamId }, error);
    }
  });

  // Handle edit team submission
  app.view('edit_team_submit', async ({ ack, view, client }: ViewHandlerParams) => {
    const teamId = view.private_metadata;
    const values = view.state.values;

    try {
      const teamName = values.team_name_block.team_name.value;
      const description = values.team_description_block?.team_description?.value;
      const newManagerIds = values.team_managers_block?.team_managers?.selected_users || [];

      if (!teamName) {
        await ack({
          response_action: 'errors',
          errors: { team_name_block: 'Team name is required' },
        });
        return;
      }

      const currentTeam = await getTeamById(teamId);
      if (!currentTeam) {
        throw new Error('Team not found');
      }

      // Update team details
      await updateTeam(teamId, {
        name: teamName,
        description: description || undefined,
      });

      // Update managers
      const currentManagerIds = currentTeam.managers.map((m) => m.slackId);
      const managersToRemove = currentManagerIds.filter((id) => !newManagerIds.includes(id));
      const managersToAdd = newManagerIds.filter((id: string) => !currentManagerIds.includes(id));

      // Ensure new managers exist and process changes in parallel
      if (managersToAdd.length > 0) {
        await ensureUsersExist(client, managersToAdd);
      }

      await Promise.all([
        ...managersToRemove.map((id) => removeTeamManager(teamId, id)),
        ...managersToAdd.map((id: string) => addTeamManager(teamId, id)),
      ]);

      const managerNames = newManagerIds.map((id: string) => `<@${id}>`).join(', ') || '_None_';
      const details = [
        `Team: ${teamName}`,
        description ? `Description: ${description}` : undefined,
        `Managers: ${managerNames}`,
      ].filter(Boolean) as string[];

      await ack({
        response_action: 'update',
        view: buildSuccessModal(
          'Team Updated',
          `The team *${teamName}* has been updated successfully.`,
          details
        ),
      });
    } catch (error) {
      logger.error({ event: 'team_update_failed', teamId }, error);
      await ack({
        response_action: 'update',
        view: buildErrorModal(
          'Update Failed',
          error instanceof Error ? error.message : 'Could not update team',
          ['Please try again or contact support if the issue persists.']
        ),
      });
    }
  });

  // === Admin Settings Main Menu ===
  app.action('home_admin_settings', async ({ ack, body, client }: ActionHandlerParams) => {
    await ack();
    const userId = body.user.id;

    try {
      if (!await requireAdmin(client, userId)) return;

      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: buildAdminSettingsModal(),
      });
    } catch (error) {
      if (await handleExpiredTrigger(client, error, userId)) return;
      logger.error({ event: 'admin_settings_modal_open_failed', userId }, error);
    }
  });

  // === Team Management from Admin Dashboard ===
  app.action('admin_manage_teams', async ({ ack, body, client }: ActionHandlerParams) => {
    await ack();
    const userId = body.user.id;

    if (!await requireAdmin(client, userId, undefined, true)) return;

    const teams = await getAllTeams();
    await client.views.push({
      trigger_id: (body as any).trigger_id,
      view: buildTeamManagementModal(teams),
    });
  });

  // Delete team
  app.action('delete_team', async ({ ack, body, client, action }: ActionHandlerParams) => {
    await ack();
    const userId = body.user.id;
    const teamId = (action as any).value;

    try {
      if (!await requireAdmin(client, userId, undefined, true)) return;

      const team = await getTeamById(teamId);
      if (!team) {
        throw new Error('Team not found');
      }

      const teamName = (team as any).name;
      await deleteTeam(teamId);

      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: `✅ Team "${teamName}" has been deleted.`,
      });

      // Refresh: team management modal
      const teams = await getAllTeams();
      await client.views.update({
        view_id: (body as any).view?.id,
        view: buildTeamManagementModal(teams),
      });
    } catch (error) {
      logger.error({ event: 'team_deletion_failed', teamId }, error);
      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: `❌ Error: ${error instanceof Error ? error.message : 'Could not delete team'}`,
      });
    }
  });

  // Open add team members modal
  app.action('add_team_members', async ({ ack, body, client, action }: ActionHandlerParams) => {
    await ack();
    const teamId = (action as any).value;

    try {
      const team = await getTeamById(teamId);
      if (!team) {
        throw new Error('Team not found');
      }

      await client.views.push({
        trigger_id: (body as any).trigger_id,
        view: buildAddTeamMembersModal(team),
      });
    } catch (error) {
      logger.error({ event: 'add_members_modal_open_failed', teamId }, error);
    }
  });

  // Handle add team members submission
  app.view('add_team_members_submit', async ({ ack, view, client }: ViewHandlerParams) => {
    const teamId = view.private_metadata;
    const values = view.state.values;

    try {
      const memberIds = values.members_block?.team_members?.selected_users || [];

      if (memberIds.length === 0) {
        await ack({
          response_action: 'errors',
          errors: { members_block: 'Please select at least one user' },
        });
        return;
      }

      // Add members in parallel
      await ensureUsersExist(client, memberIds);
      await Promise.all(memberIds.map((memberId: string) => addTeamMember(teamId, memberId)));

      const memberNames = memberIds.map((id: string) => `<@${id}>`).join(', ');

      await ack({
        response_action: 'update',
        view: buildSuccessModal(
          'Members Added',
          `Successfully added *${memberIds.length}* member(s) to the team.`,
          [`Members: ${memberNames}`]
        ),
      });
    } catch (error) {
      logger.error({ event: 'team_members_add_failed' }, error);
      await ack({
        response_action: 'update',
        view: buildErrorModal(
          'Failed to Add Members',
          error instanceof Error ? error.message : 'Could not add members',
          ['Please try again or contact support if the issue persists.']
        ),
      });
    }
  });

  // === User Management ===

  // Sync workspace users on demand
  app.action('admin_sync_users', async ({ ack, body, client }: ActionHandlerParams) => {
    await ack();
    const userId = body.user.id;

    if (!await requireAdmin(client, userId)) return;

    try {
      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: '🔄 Syncing workspace users...',
      });

      const syncedUsers = await syncWorkspaceUsers(client);

      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: `✅ Successfully synced ${syncedUsers.length} users from the workspace!`,
      });
    } catch (error) {
      logger.error({ event: 'workspace_users_sync_failed', userId }, error);
      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: `❌ Error syncing users: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  });

  // Open user management modal
  app.action('admin_manage_users', async ({ ack, body, client }: ActionHandlerParams) => {
    await ack();
    const userId = body.user.id;

    if (!await requireAdmin(client, userId, undefined, true)) return;

    const [users, teams] = await Promise.all([getAllActiveUsers(), getAllTeams()]);

    await client.views.push({
      trigger_id: (body as any).trigger_id,
      view: buildUserManagementModal(users, teams),
    });
  });

  // Open assign user to team modal
  app.action('admin_assign_user_modal', async ({ ack, body, client }: ActionHandlerParams) => {
    await ack();
    const userId = body.user.id;

    if (!await requireAdmin(client, userId, undefined, true)) return;

    const teams = await getAllTeams();

    if (teams.length === 0) {
      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: '⚠️ No teams exist yet. Please create a team first using "Manage Teams" before assigning users.',
      });
      return;
    }

    await client.views.push({
      trigger_id: (body as any).trigger_id,
      view: buildAssignUserModal(teams),
    });
  });

  // Handle assign user submission
  app.view('assign_user_submit', async ({ ack, view, client }: ViewHandlerParams) => {
    const values = view.state.values;

    try {
      const selectedUser = values.user_block?.selected_user?.selected_user;
      const selectedTeam = values.team_block?.selected_team?.selected_option?.value;

      if (!selectedUser || !selectedTeam) {
        await ack({
          response_action: 'errors',
          errors: {
            ...((!selectedUser) && { user_block: 'Please select a user' }),
            ...((!selectedTeam) && { team_block: 'Please select a team' }),
          },
        });
        return;
      }

      await ensureUsersExist(client, [selectedUser]);
      await assignUserToTeam(selectedUser, selectedTeam);

      // Get team name for the message
      const team = await getTeamById(selectedTeam);

      await ack({
        response_action: 'update',
        view: buildSuccessModal(
          'User Assigned',
          `Successfully assigned <@${selectedUser}> to the team.`,
          [`User: <@${selectedUser}>`, `Team: ${team ? (team as any).name : selectedTeam}`]
        ),
      });
    } catch (error) {
      logger.error({ event: 'user_assignment_failed' }, error);
      await ack({
        response_action: 'update',
        view: buildErrorModal(
          'Assignment Failed',
          error instanceof Error ? error.message : 'Could not assign user',
          ['Please try again or contact support if the issue persists.']
        ),
      });
    }
  });

  // Open toggle admin modal
  app.action('admin_toggle_admin_modal', async ({ ack, body, client }: ActionHandlerParams) => {
    await ack();
    const userId = body.user.id;

    if (!await requireAdmin(client, userId, undefined, true)) return;

    await client.views.push({
      trigger_id: (body as any).trigger_id,
      view: buildToggleAdminModal(),
    });
  });

  // Handle refresh unassigned users
  app.action('refresh_unassigned_users', async ({ ack, body, client }: ActionHandlerParams) => {
    await ack();
    const userId = body.user.id;

    if (!await requireAdmin(client, userId, undefined, true)) return;

    try {
      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: '🔄 Syncing workspace users...',
      });

      const syncedUsers = await syncWorkspaceUsers(client);

      // Refresh the user management modal with updated data
      const [users, teams] = await Promise.all([getAllActiveUsers(), getAllTeams()]);
      
      await client.views.update({
        view_id: (body as any).view?.id,
        view: buildUserManagementModal(users, teams),
      });

      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: `✅ Successfully synced ${syncedUsers.length} users from the workspace!`,
      });
    } catch (error) {
      logger.error({ event: 'unassigned_users_refresh_failed', userId }, error);
      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: `❌ Error syncing users: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  });

  // Handle toggle admin submission
  app.view('toggle_admin_submit', async ({ ack, view, client }: ViewHandlerParams) => {
    const values = view.state.values;

    try {
      const selectedUser = values.user_block?.selected_user?.selected_user;

      if (!selectedUser) {
        await ack({
          response_action: 'errors',
          errors: { user_block: 'Please select a user' },
        });
        return;
      }

      await ensureUsersExist(client, [selectedUser]);

      const currentIsAdmin = await isUserAdmin(selectedUser);
      await setUserAdmin(selectedUser, !currentIsAdmin);

      const newIsAdmin = !currentIsAdmin;
      const newStatus = newIsAdmin ? 'granted admin privileges' : 'removed from admin role';

      await ack({
        response_action: 'update',
        view: buildSuccessModal(
          'Admin Status Updated',
          `<@${selectedUser}> has been ${newStatus}.`,
          [`User: <@${selectedUser}>`, `New status: ${newIsAdmin ? '✅ Admin' : 'Regular user'}`]
        ),
      });
    } catch (error) {
      logger.error({ event: 'admin_toggle_failed' }, error);
      await ack({
        response_action: 'update',
        view: buildErrorModal(
          'Update Failed',
          error instanceof Error ? error.message : 'Could not toggle admin status',
          ['Please try again or contact support if the issue persists.']
        ),
      });
    }
  });

  // === Workspace Settings ===

  // Open workspace settings modal
  app.action('admin_workspace_settings', async ({ ack, body, client }: ActionHandlerParams) => {
    await ack();
    const userId = body.user.id;

    if (!await requireAdmin(client, userId, undefined, true)) return;

    const settings = await getSettings();

    await client.views.push({
      trigger_id: (body as any).trigger_id,
      view: buildWorkspaceSettingsModal({
        notificationChannelId: settings?.notificationChannelId ?? null,
        requireApproval: settings?.requireApproval ?? true,
        allowNegativeBalance: settings?.allowNegativeBalance ?? false,
        digestEnabled: settings?.digestEnabled ?? true,
        digestHour: settings?.digestHour ?? 9,
        digestMinute: settings?.digestMinute ?? 0,
        digestWeekdaysOnly: settings?.digestWeekdaysOnly ?? true,
        timezone: settings?.timezone ?? 'UTC',
      }),
    });
  });

  // Handle workspace settings submission
  app.view('workspace_settings_submit', async ({ ack, view }: ViewHandlerParams) => {
    const values = view.state.values;

    try {
      const notificationChannel =
        values.notification_channel_block?.notification_channel?.selected_channel ?? null;
      const requireApproval =
        values.require_approval_block?.require_approval?.selected_option?.value === 'true';
      const allowNegativeBalance =
        values.negative_balance_block?.allow_negative?.selected_option?.value === 'true';
      const digestEnabled =
        values.digest_enabled_block?.digest_enabled?.selected_option?.value === 'true';
      const digestTime = values.digest_time_block?.digest_time?.selected_option?.value || '09:00';
      const digestWeekdaysOnly =
        values.digest_weekdays_block?.digest_weekdays_only?.selected_option?.value === 'true';

      const [hourStr, minuteStr] = digestTime.split(':');
      const digestHour = parseInt(hourStr, 10);
      const digestMinute = parseInt(minuteStr, 10);

      await updateSettings({
        notificationChannelId: notificationChannel,
        requireApproval,
        allowNegativeBalance,
        digestEnabled,
        digestHour,
        digestMinute,
        digestWeekdaysOnly,
      });

      const details = [
        `Require Approval: ${requireApproval ? '✅ Yes' : '❌ No'}`,
        `Allow Negative Balance: ${allowNegativeBalance ? '✅ Yes' : '❌ No'}`,
        `Daily Digest: ${digestEnabled ? '✅ Enabled' : '❌ Disabled'}${digestEnabled ? ` at ${digestTime}` : ''}`,
        `Digest Weekdays Only: ${digestWeekdaysOnly ? '✅ Yes' : '❌ No'}`,
        notificationChannel ? `Notification Channel: <#${notificationChannel}>` : undefined,
      ].filter(Boolean) as string[];

      await ack({
        response_action: 'update',
        view: buildSuccessModal(
          'Settings Updated',
          'Your workspace settings have been updated successfully.',
          details
        ),
      });
    } catch (error) {
      logger.error({ event: 'settings_update_failed' }, error);
      await ack({
        response_action: 'update',
        view: buildErrorModal(
          'Update Failed',
          error instanceof Error ? error.message : 'Could not update settings',
          ['Please try again or contact support if the issue persists.']
        ),
      });
    }
  });

  // === Leave Types Management ===

  // Open leave types modal
  app.action('admin_leave_types', async ({ ack, body, client }: ActionHandlerParams) => {
    await ack();
    const userId = body.user.id;

    if (!await requireAdmin(client, userId, undefined, true)) return;

    const leaveTypes = await prisma.leaveType.findMany({
      orderBy: { order: 'asc' },
    });

    await client.views.push({
      trigger_id: (body as any).trigger_id,
      view: buildLeaveTypesModal(leaveTypes),
    });
  });

  // Open create leave type modal
  app.action('create_leave_type_modal', async ({ ack, body, client }: ActionHandlerParams) => {
    await ack();
    await client.views.push({
      trigger_id: (body as any).trigger_id,
      view: buildCreateLeaveTypeModal(),
    });
  });

  // Handle create leave type submission
  app.view('create_leave_type_submit', async ({ ack, view }: ViewHandlerParams) => {
    const values = view.state.values;

    try {
      const name = values.name_block?.leave_type_name?.value;
      const emoji = values.emoji_block?.leave_type_emoji?.value || '📅';
      const allowanceStr = values.allowance_block?.leave_type_allowance?.value;
      const requiresApproval = values.requires_approval_block?.requires_approval?.selected_option?.value === 'true';
      const affectsBalance = values.affects_balance_block?.affects_balance?.selected_option?.value === 'true';

      // Reminder settings
      const reminderEnabled = values.reminder_enabled_block?.reminder_enabled?.selected_option?.value === 'true';
      const reminderTime = values.reminder_time_block?.reminder_time?.selected_option?.value || '09:00';
      const reminderWeekdaysOnly = values.reminder_weekdays_block?.reminder_weekdays_only?.selected_option?.value === 'true';
      const preLeaveReminderEnabled = values.pre_leave_enabled_block?.pre_leave_enabled?.selected_option?.value === 'true';
      const midLeaveReminderEnabled = values.mid_leave_enabled_block?.mid_leave_enabled?.selected_option?.value === 'true';
      const customReminderMessage = values.custom_message_block?.custom_message?.value;

      if (!name) {
        await ack({
          response_action: 'errors',
          errors: { name_block: 'Name is required' },
        });
        return;
      }

      const defaultAllowance = allowanceStr ? parseInt(allowanceStr, 10) : null;
      if (allowanceStr && isNaN(defaultAllowance as number)) {
        await ack({
          response_action: 'errors',
          errors: { allowance_block: 'Allowance must be a number' },
        });
        return;
      }

      const [reminderHourStr, reminderMinuteStr] = reminderTime.split(':');
      const reminderHour = parseInt(reminderHourStr, 10);
      const reminderMinute = parseInt(reminderMinuteStr, 10);

      await createLeaveType({
        name,
        emoji,
        defaultAllowance,
        requiresApproval,
        affectsBalance,
        reminderEnabled,
        reminderHour,
        reminderMinute,
        reminderWeekdaysOnly,
        preLeaveReminderEnabled,
        midLeaveReminderEnabled,
        customReminderMessage,
      });

      const details = [
        `Name: ${emoji} ${name}`,
        `Requires Approval: ${requiresApproval ? '✅ Yes' : '❌ No'}`,
        `Affects Balance: ${affectsBalance ? '✅ Yes' : '❌ No'}`,
        affectsBalance && defaultAllowance ? `Default Allowance: ${defaultAllowance} days/year` : undefined,
        `Reminders: ${reminderEnabled ? '✅ Enabled' : '❌ Disabled'}${reminderEnabled ? ` at ${reminderTime}` : ''}`,
      ].filter(Boolean) as string[];

      await ack({
        response_action: 'update',
        view: buildSuccessModal(
          'Leave Type Created',
          `The leave type *${name}* has been created successfully.`,
          details
        ),
      });
    } catch (error) {
      logger.error({ event: 'leave_type_creation_failed' }, error);
      await ack({
        response_action: 'update',
        view: buildErrorModal(
          'Creation Failed',
          error instanceof Error ? error.message : 'Could not create leave type',
          ['Please try again or contact support if the issue persists.']
        ),
      });
    }
  });

  // Open edit leave type modal
  app.action('edit_leave_type', async ({ ack, body, client, action }: ActionHandlerParams) => {
    await ack();
    const leaveTypeId = (action as any).value;

    try {
      const leaveType = await getLeaveTypeById(leaveTypeId);
      if (!leaveType) {
        throw new Error('Leave type not found');
      }

      await client.views.push({
        trigger_id: (body as any).trigger_id,
        view: buildEditLeaveTypeModal(leaveType),
      });
    } catch (error) {
      logger.error({ event: 'edit_leave_type_modal_open_failed', leaveTypeId }, error);
    }
  });

  // Handle edit leave type submission
  app.view('edit_leave_type_submit', async ({ ack, view }: ViewHandlerParams) => {
    const leaveTypeId = view.private_metadata;
    const values = view.state.values;

    try {
      const name = values.name_block?.leave_type_name?.value;
      const emoji = values.emoji_block?.leave_type_emoji?.value || '📅';
      const allowanceStr = values.allowance_block?.leave_type_allowance?.value;
      const requiresApproval = values.requires_approval_block?.requires_approval?.selected_option?.value === 'true';
      const affectsBalance = values.affects_balance_block?.affects_balance?.selected_option?.value === 'true';

      // Reminder settings
      const reminderEnabled = values.reminder_enabled_block?.reminder_enabled?.selected_option?.value === 'true';
      const reminderTime = values.reminder_time_block?.reminder_time?.selected_option?.value || '09:00';
      const reminderWeekdaysOnly = values.reminder_weekdays_block?.reminder_weekdays_only?.selected_option?.value === 'true';
      const preLeaveReminderEnabled = values.pre_leave_enabled_block?.pre_leave_enabled?.selected_option?.value === 'true';
      const midLeaveReminderEnabled = values.mid_leave_enabled_block?.mid_leave_enabled?.selected_option?.value === 'true';
      const customReminderMessage = values.custom_message_block?.custom_message?.value;

      if (!name) {
        await ack({
          response_action: 'errors',
          errors: { name_block: 'Name is required' },
        });
        return;
      }

      const defaultAllowance = allowanceStr ? parseInt(allowanceStr, 10) : null;
      if (allowanceStr && isNaN(defaultAllowance as number)) {
        await ack({
          response_action: 'errors',
          errors: { allowance_block: 'Allowance must be a number' },
        });
        return;
      }

      const [reminderHourStr, reminderMinuteStr] = reminderTime.split(':');
      const reminderHour = parseInt(reminderHourStr, 10);
      const reminderMinute = parseInt(reminderMinuteStr, 10);

      await updateLeaveType(leaveTypeId, {
        name,
        emoji,
        defaultAllowance,
        requiresApproval,
        affectsBalance,
        reminderEnabled,
        reminderHour,
        reminderMinute,
        reminderWeekdaysOnly,
        preLeaveReminderEnabled,
        midLeaveReminderEnabled,
        customReminderMessage,
      });

      const details = [
        `Name: ${emoji} ${name}`,
        `Requires Approval: ${requiresApproval ? '✅ Yes' : '❌ No'}`,
        `Affects Balance: ${affectsBalance ? '✅ Yes' : '❌ No'}`,
        affectsBalance && defaultAllowance ? `Default Allowance: ${defaultAllowance} days/year` : undefined,
        `Reminders: ${reminderEnabled ? '✅ Enabled' : '❌ Disabled'}${reminderEnabled ? ` at ${reminderTime}` : ''}`,
      ].filter(Boolean) as string[];

      await ack({
        response_action: 'update',
        view: buildSuccessModal(
          'Leave Type Updated',
          `The leave type *${name}* has been updated successfully.`,
          details
        ),
      });
    } catch (error) {
      logger.error({ event: 'leave_type_update_failed', leaveTypeId }, error);
      await ack({
        response_action: 'update',
        view: buildErrorModal(
          'Update Failed',
          error instanceof Error ? error.message : 'Could not update leave type',
          ['Please try again or contact support if the issue persists.']
        ),
      });
    }
  });

  // Toggle leave type active status
  app.action('toggle_leave_type', async ({ ack, body, client, action }: ActionHandlerParams) => {
    await ack();
    const userId = body.user.id;
    const leaveTypeId = (action as any).value;

    try {
      if (!await requireAdmin(client, userId, undefined, true)) return;

      const leaveType = await getLeaveTypeById(leaveTypeId);
      if (!leaveType) {
        throw new Error('Leave type not found');
      }

      await updateLeaveType(leaveTypeId, { isActive: !leaveType.isActive });

      // Refresh: modal
      const leaveTypes = await prisma.leaveType.findMany({
        orderBy: { order: 'asc' },
      });

      await client.views.update({
        view_id: (body as any).view?.id,
        view: buildLeaveTypesModal(leaveTypes),
      });

      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: `✅ Leave type "${leaveType.name}" ${leaveType.isActive ? 'deactivated' : 'activated'}!`,
      });
    } catch (error) {
      logger.error({ event: 'leave_type_toggle_failed', leaveTypeId }, error);
    }
  });

  // Configure reminders for a specific leave type
  app.action('configure_leave_type_reminders', async ({ ack, body, client, action }: ActionHandlerParams) => {
    await ack();
    const leaveTypeId = (action as any).value;
    const userId = body.user.id;

    try {
      if (!await requireAdmin(client, userId, undefined, true)) return;

      const leaveType = await getLeaveTypeById(leaveTypeId);
      if (!leaveType) {
        throw new Error('Leave type not found');
      }

      // Open the edit leave type modal with focus on reminder settings
      await client.views.push({
        trigger_id: (body as any).trigger_id,
        view: buildEditLeaveTypeModal({
          ...leaveType,
          // Ensure reminder settings have defaults
          reminderEnabled: leaveType.reminderEnabled ?? true,
          reminderHour: leaveType.reminderHour ?? 9,
          reminderMinute: leaveType.reminderMinute ?? 0,
          reminderWeekdaysOnly: leaveType.reminderWeekdaysOnly ?? true,
          preLeaveReminderEnabled: leaveType.preLeaveReminderEnabled ?? true,
          midLeaveReminderEnabled: leaveType.midLeaveReminderEnabled ?? true,
          customReminderMessage: leaveType.customReminderMessage || `📅 Reminder: Your {leaveType} leave starts tomorrow. Please ensure your work is handed over and any preparations are complete.\n\n🌴 Checking in during your {leaveType} leave. Hope you're having a restful time!`,
        }),
      });
    } catch (error) {
      logger.error({ event: 'configure_reminders_modal_open_failed', userId }, error);
      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: `❌ Error: ${error instanceof Error ? error.message : 'Could not open reminder configuration'}`,
      });
    }
  });

  // === Leave Policy Management ===

  // Handle edit policy submission
  app.view('edit_policy_submit', async ({ ack, body, view }: ViewHandlerParams) => {
    const values = view.state.values;

    try {
      const content = values.policy_content_block?.policy_content?.value;

      if (!content) {
        await ack({
          response_action: 'errors',
          errors: {
            policy_content_block: 'Policy content is required',
          },
        });
        return;
      }

      await updateLeavePolicy(content, body.user.id);

      await ack({
        response_action: 'update',
        view: buildSuccessModal(
          'Policy Updated',
          'The leave policy has been updated successfully.',
          ['The changes are now visible to all users.']
        ),
      });
    } catch (error) {
      logger.error({ event: 'leave_policy_update_failed', userId: body.user.id }, error);
      await ack({
        response_action: 'update',
        view: buildErrorModal(
          'Update Failed',
          error instanceof Error ? error.message : 'Failed to update policy',
          ['Please try again or contact support if the issue persists.']
        ),
      });
    }
  });

  // === Balance Management ===

  // Open balance management modal
  app.action('admin_balances', async ({ ack, body, client }: ActionHandlerParams) => {
    await ack();
    const userId = body.user.id;

    if (!await requireAdmin(client, userId, undefined, true)) return;

    const [usersWithBalances, leaveTypes] = await Promise.all([
      getAllUsersBalances(),
      getAllLeaveTypes(),
    ]);

    await client.views.push({
      trigger_id: (body as any).trigger_id,
      view: buildBalanceManagementModal(usersWithBalances, leaveTypes, 0),
    });
  });

  // Balance pagination handler factory
  const createBalancePaginationHandler = () => async ({ ack, body, client, action }: ActionHandlerParams) => {
    await ack();
    const userId = body.user.id;
    const page = parseInt((action as any).value, 10);

    if (page < 0) return;
    if (!await requireAdmin(client, userId, undefined, true)) return;

    const [usersWithBalances, leaveTypes] = await Promise.all([
      getAllUsersBalances(),
      getAllLeaveTypes(),
    ]);

    await client.views.update({
      view_id: body.view?.id,
      view: buildBalanceManagementModal(usersWithBalances, leaveTypes, page),
    });
  };

  app.action('admin_balances_prev_page', createBalancePaginationHandler());
  app.action('admin_balances_next_page', createBalancePaginationHandler());

  // Open unified manage balance modal (new single button)
  app.action('admin_manage_balance_modal', async ({ ack, body, client }: ActionHandlerParams) => {
    await ack();
    const userId = body.user.id;

    if (!await requireAdmin(client, userId, undefined, true)) return;

    const leaveTypes = await getAllLeaveTypes();
    const balanceTypes = leaveTypes.filter(lt => lt.affectsBalance);

    if (balanceTypes.length === 0) {
      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: '⚠️ No leave types with balance tracking exist. Please create a leave type with "Affects Balance" enabled first.',
      });
      return;
    }

    const viewMethod = (body as any).view ? 'push' : 'open';
    await client.views[viewMethod]({
      trigger_id: (body as any).trigger_id,
      view: buildUnifiedBalanceModal(leaveTypes, 'adjust_balance'),
    });
  });

  // Handle action type change in unified balance modal
  app.action('balance_action_type_change', async ({ ack, body, client }: ActionHandlerParams) => {
    await ack();

    const selectedAction = (body as any).actions?.[0]?.selected_option?.value as BalanceActionType;
    if (!selectedAction) return;

    const leaveTypes = await getAllLeaveTypes();

    await client.views.update({
      view_id: (body as any).view?.id,
      view: buildUnifiedBalanceModal(leaveTypes, selectedAction),
    });
  });

  // Handle unified balance modal submission
  app.view('unified_balance_submit', async ({ ack, view, client }: ViewHandlerParams) => {
    const values = view.state.values;
    const metadata = JSON.parse(view.private_metadata || '{}');
    const actionType: BalanceActionType = metadata.actionType || 'adjust_balance';

    try {
      const selectedUser = values.user_block?.selected_user?.selected_user;
      const leaveTypeId = values.leave_type_block?.selected_leave_type?.selected_option?.value;

      if (!selectedUser || !leaveTypeId) {
        await ack({
          response_action: 'errors',
          errors: {
            ...(!selectedUser && { user_block: 'Please select a user' }),
            ...(!leaveTypeId && { leave_type_block: 'Please select a leave type' }),
          },
        });
        return;
      }

      await ensureUsersExist(client, [selectedUser]);

      let successTitle = '';
      let successMessage = '';
      let details: string[] = [];

      const leaveType = await getLeaveTypeById(leaveTypeId);
      const leaveTypeName = leaveType ? `${leaveType.emoji} ${leaveType.name}` : 'Leave Type';

      switch (actionType) {
        case 'adjust_balance': {
          const adjustmentStr = values.adjustment_block?.adjustment_value?.value;
          if (!adjustmentStr) {
            await ack({
              response_action: 'errors',
              errors: { adjustment_block: 'Please enter an adjustment value' },
            });
            return;
          }

          const adjustment = parseFloat(adjustmentStr);
          if (isNaN(adjustment)) {
            await ack({
              response_action: 'errors',
              errors: { adjustment_block: 'Adjustment must be a number' },
            });
            return;
          }

          await adjustBalance(selectedUser, leaveTypeId, adjustment);
          const sign = adjustment >= 0 ? '+' : '';
          successTitle = 'Balance Adjusted';
          successMessage = `Successfully adjusted balance for <@${selectedUser}> by ${sign}${adjustment} days.`;
          details = [`User: <@${selectedUser}>`, `Leave Type: ${leaveTypeName}`, `Adjustment: ${sign}${adjustment} days`];
          break;
        }

        case 'set_allowance': {
          const allowanceStr = values.allowance_block?.allowance_value?.value;
          if (!allowanceStr) {
            await ack({
              response_action: 'errors',
              errors: { allowance_block: 'Please enter an allowance value' },
            });
            return;
          }

          const allowance = parseFloat(allowanceStr);
          if (isNaN(allowance) || allowance < 0) {
            await ack({
              response_action: 'errors',
              errors: { allowance_block: 'Allowance must be a positive number' },
            });
            return;
          }

          await setAllowance(selectedUser, leaveTypeId, allowance);
          successTitle = 'Allowance Set';
          successMessage = `Successfully set allowance for <@${selectedUser}> to ${allowance} days.`;
          details = [`User: <@${selectedUser}>`, `Leave Type: ${leaveTypeName}`, `New Allowance: ${allowance} days/year`];
          break;
        }

        case 'auto_approve': {
          const autoApproveEnabled = values.auto_approve_block?.auto_approve_enabled?.selected_option?.value === 'true';
          const maxDaysStr = values.max_days_block?.max_days_value?.value;
          let maxDays: number | null = null;

          if (maxDaysStr) {
            maxDays = parseInt(maxDaysStr, 10);
            if (isNaN(maxDays) || maxDays < 1) {
              await ack({
                response_action: 'errors',
                errors: { max_days_block: 'Max days must be a positive number' },
              });
              return;
            }
          }

          // Store auto-approve preference in database
          await prisma.userLeaveTypePreference.upsert({
            where: {
              userId_leaveTypeId: {
                userId: selectedUser,
                leaveTypeId: leaveTypeId,
              },
            },
            update: {
              autoApprove: autoApproveEnabled,
              maxDays: maxDays,
            },
            create: {
              userId: selectedUser,
              leaveTypeId: leaveTypeId,
              autoApprove: autoApproveEnabled,
              maxDays: maxDays,
            },
          });

          const maxDaysText = maxDays ? ` (up to ${maxDays} days)` : '';
          successTitle = 'Auto-Approve Updated';
          successMessage = `Auto-approve ${autoApproveEnabled ? 'enabled' : 'disabled'}${maxDaysText} for <@${selectedUser}>.`;
          details = [
            `User: <@${selectedUser}>`,
            `Leave Type: ${leaveTypeName}`,
            `Status: ${autoApproveEnabled ? '✅ Enabled' : '❌ Disabled'}`,
            maxDays ? `Max Days: ${maxDays}` : 'Max Days: Unlimited',
          ];
          break;
        }
      }

      await ack({
        response_action: 'update',
        view: buildSuccessModal(successTitle, successMessage, details),
      });
    } catch (error) {
      logger.error({ event: 'unified_balance_modal_failed' }, error);
      await ack({
        response_action: 'update',
        view: buildErrorModal(
          'Action Failed',
          error instanceof Error ? error.message : 'Could not complete action',
          ['Please try again or contact support if the issue persists.']
        ),
      });
    }
  });

  // Legacy: Open adjust balance modal (backward compatibility)
  app.action('admin_adjust_balance_modal', async ({ ack, body, client }: ActionHandlerParams) => {
    await ack();
    const userId = body.user.id;

    if (!await requireAdmin(client, userId, undefined, true)) return;

    const leaveTypes = await getAllLeaveTypes();
    const balanceTypes = leaveTypes.filter(lt => lt.affectsBalance);

    if (balanceTypes.length === 0) {
      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: '⚠️ No leave types with balance tracking exist. Please create a leave type with "Affects Balance" enabled first.',
      });
      return;
    }

    const viewMethod = (body as any).view ? 'push' : 'open';
    await client.views[viewMethod]({
      trigger_id: (body as any).trigger_id,
      view: buildAdjustBalanceModal(leaveTypes),
    });
  });

  // Legacy: Open set allowance modal (backward compatibility)
  app.action('admin_set_allowance_modal', async ({ ack, body, client }: ActionHandlerParams) => {
    await ack();
    const userId = body.user.id;

    if (!await requireAdmin(client, userId, undefined, true)) return;

    const leaveTypes = await getAllLeaveTypes();
    const balanceTypes = leaveTypes.filter(lt => lt.affectsBalance);

    if (balanceTypes.length === 0) {
      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: '⚠️ No leave types with balance tracking exist. Please create a leave type with "Affects Balance" enabled first.',
      });
      return;
    }

    const viewMethod = (body as any).view ? 'push' : 'open';
    await client.views[viewMethod]({
      trigger_id: (body as any).trigger_id,
      view: buildSetAllowanceModal(leaveTypes),
    });
  });
}
