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
} from '../views/admin.modal';
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

type SlackClient = any;

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
  app.action('manage_teams', async ({ ack, body, client }) => {
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
      logger.error('Error opening team management modal', error, { userId });
    }
  });

  // Open create team modal
  app.action('create_team_modal', async ({ ack, body, client }) => {
    await ack();
    await client.views.push({
      trigger_id: (body as any).trigger_id,
      view: buildCreateTeamModal(),
    });
  });

  // Handle create team submission
  app.view('create_team_submit', async ({ ack, body, view, client }) => {
    const userId = body.user.id;
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

      // Create the team
      const team = await createTeam(teamName, description || undefined);

      // Add managers in parallel
      if (managerIds.length > 0) {
        await ensureUsersExist(client, managerIds);
        await Promise.all(managerIds.map((managerId: string) => addTeamManager(team.id, managerId)));
      }

      await ack({ response_action: 'clear' });

      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: `✅ Team "${teamName}" created successfully!`,
      });
    } catch (error) {
      logger.error('Error creating team', error);
      await ack({
        response_action: 'errors',
        errors: { team_name_block: error instanceof Error ? error.message : 'Could not create team' },
      });
    }
  });

  // Open edit team modal
  app.action('edit_team', async ({ ack, body, client, action }) => {
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
      logger.error('Error opening edit team modal', error);
    }
  });

  // Handle edit team submission
  app.view('edit_team_submit', async ({ ack, body, view, client }) => {
    const userId = body.user.id;
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

      await ack({ response_action: 'clear' });

      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: `✅ Team "${teamName}" updated successfully!`,
      });
    } catch (error) {
      logger.error('Error updating team', error);
      await ack({
        response_action: 'errors',
        errors: { team_name_block: error instanceof Error ? error.message : 'Could not update team' },
      });
    }
  });

  // === Admin Settings Main Menu ===
  app.action('home_admin_settings', async ({ ack, body, client }) => {
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
      logger.error('Error opening admin settings modal', error, { userId });
    }
  });

  // === Team Management from Admin Dashboard ===
  app.action('admin_manage_teams', async ({ ack, body, client }) => {
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
  app.action('delete_team', async ({ ack, body, client, action }) => {
    await ack();
    const userId = body.user.id;
    const teamId = (action as any).value;

    try {
      if (!await requireAdmin(client, userId, undefined, true)) return;

      const team = await getTeamById(teamId);
      if (!team) {
        throw new Error('Team not found');
      }

      const teamName = team.name;
      await deleteTeam(teamId);

      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: `✅ Team "${teamName}" has been deleted.`,
      });

      // Refresh the team management modal
      const teams = await getAllTeams();
      await client.views.update({
        view_id: (body as any).view?.id,
        view: buildTeamManagementModal(teams),
      });
    } catch (error) {
      logger.error('Error deleting team', error);
      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: `❌ Error: ${error instanceof Error ? error.message : 'Could not delete team'}`,
      });
    }
  });

  // Open add team members modal
  app.action('add_team_members', async ({ ack, body, client, action }) => {
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
      logger.error('Error opening add members modal', error);
    }
  });

  // Handle add team members submission
  app.view('add_team_members_submit', async ({ ack, body, view, client }) => {
    const userId = body.user.id;
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

      await ack({ response_action: 'clear' });

      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: `✅ Added ${memberIds.length} member(s) to the team!`,
      });
    } catch (error) {
      logger.error('Error adding team members', error);
      await ack({
        response_action: 'errors',
        errors: { members_block: error instanceof Error ? error.message : 'Could not add members' },
      });
    }
  });

  // === User Management ===

  // Sync workspace users on demand
  app.action('admin_sync_users', async ({ ack, body, client }) => {
    await ack();
    const userId = body.user.id;

    if (!await requireAdmin(client, userId)) return;

    logger.action('admin_sync_users', userId);

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
      logger.error('Error syncing workspace users', error, { userId });
      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: `❌ Error syncing users: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  });

  // Open user management modal
  app.action('admin_manage_users', async ({ ack, body, client }) => {
    await ack();
    const userId = body.user.id;

    if (!await requireAdmin(client, userId, undefined, true)) return;

    logger.action('admin_manage_users', userId);

    const [users, teams] = await Promise.all([getAllActiveUsers(), getAllTeams()]);

    await client.views.push({
      trigger_id: (body as any).trigger_id,
      view: buildUserManagementModal(users, teams),
    });
  });

  // Open assign user to team modal
  app.action('admin_assign_user_modal', async ({ ack, body, client }) => {
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
  app.view('assign_user_submit', async ({ ack, body, view, client }) => {
    const userId = body.user.id;
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

      await ack({ response_action: 'clear' });

      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: `✅ User <@${selectedUser}> has been assigned to the team!`,
      });
    } catch (error) {
      logger.error('Error assigning user', error);
      await ack({
        response_action: 'errors',
        errors: { user_block: error instanceof Error ? error.message : 'Could not assign user' },
      });
    }
  });

  // Open toggle admin modal
  app.action('admin_toggle_admin_modal', async ({ ack, body, client }) => {
    await ack();
    const userId = body.user.id;

    if (!await requireAdmin(client, userId, undefined, true)) return;

    await client.views.push({
      trigger_id: (body as any).trigger_id,
      view: buildToggleAdminModal(),
    });
  });

  // Handle toggle admin submission
  app.view('toggle_admin_submit', async ({ ack, body, view, client }) => {
    const userId = body.user.id;
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

      await ack({ response_action: 'clear' });

      const newStatus = !currentIsAdmin ? 'an admin' : 'no longer an admin';
      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: `✅ <@${selectedUser}> is now ${newStatus}.`,
      });
    } catch (error) {
      logger.error('Error toggling admin', error);
      await ack({
        response_action: 'errors',
        errors: { user_block: error instanceof Error ? error.message : 'Could not toggle admin status' },
      });
    }
  });

  // === Workspace Settings ===

  // Open workspace settings modal
  app.action('admin_workspace_settings', async ({ ack, body, client }) => {
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
      }),
    });
  });

  // Handle workspace settings submission
  app.view('workspace_settings_submit', async ({ ack, body, view, client }) => {
    const userId = body.user.id;
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

      await ack({ response_action: 'clear' });

      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: '✅ Workspace settings updated successfully!',
      });
    } catch (error) {
      logger.error('Error updating settings', error);
      await ack({
        response_action: 'errors',
        errors: { require_approval_block: error instanceof Error ? error.message : 'Could not update settings' },
      });
    }
  });

  // === Leave Types Management ===

  // Open leave types modal
  app.action('admin_leave_types', async ({ ack, body, client }) => {
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
  app.action('create_leave_type_modal', async ({ ack, body, client }) => {
    await ack();
    await client.views.push({
      trigger_id: (body as any).trigger_id,
      view: buildCreateLeaveTypeModal(),
    });
  });

  // Handle create leave type submission
  app.view('create_leave_type_submit', async ({ ack, body, view, client }) => {
    const userId = body.user.id;
    const values = view.state.values;

    try {
      const name = values.name_block?.leave_type_name?.value;
      const emoji = values.emoji_block?.leave_type_emoji?.value || '📅';
      const allowanceStr = values.allowance_block?.leave_type_allowance?.value;
      const requiresApproval = values.requires_approval_block?.requires_approval?.selected_option?.value === 'true';
      const affectsBalance = values.affects_balance_block?.affects_balance?.selected_option?.value === 'true';

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

      await createLeaveType({
        name,
        emoji,
        defaultAllowance,
        requiresApproval,
        affectsBalance,
      });

      await ack({ response_action: 'clear' });

      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: `✅ Leave type "${name}" created successfully!`,
      });
    } catch (error) {
      logger.error('Error creating leave type', error);
      await ack({
        response_action: 'errors',
        errors: { name_block: error instanceof Error ? error.message : 'Could not create leave type' },
      });
    }
  });

  // Open edit leave type modal
  app.action('edit_leave_type', async ({ ack, body, client, action }) => {
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
      logger.error('Error opening edit leave type modal', error);
    }
  });

  // Handle edit leave type submission
  app.view('edit_leave_type_submit', async ({ ack, body, view, client }) => {
    const userId = body.user.id;
    const leaveTypeId = view.private_metadata;
    const values = view.state.values;

    try {
      const name = values.name_block?.leave_type_name?.value;
      const emoji = values.emoji_block?.leave_type_emoji?.value || '📅';
      const allowanceStr = values.allowance_block?.leave_type_allowance?.value;
      const requiresApproval = values.requires_approval_block?.requires_approval?.selected_option?.value === 'true';
      const affectsBalance = values.affects_balance_block?.affects_balance?.selected_option?.value === 'true';

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

      await updateLeaveType(leaveTypeId, {
        name,
        emoji,
        defaultAllowance,
        requiresApproval,
        affectsBalance,
      });

      await ack({ response_action: 'clear' });

      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: `✅ Leave type "${name}" updated successfully!`,
      });
    } catch (error) {
      logger.error('Error updating leave type', error);
      await ack({
        response_action: 'errors',
        errors: { name_block: error instanceof Error ? error.message : 'Could not update leave type' },
      });
    }
  });

  // Toggle leave type active status
  app.action('toggle_leave_type', async ({ ack, body, client, action }) => {
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

      // Refresh the modal
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
      logger.error('Error toggling leave type', error);
    }
  });

  // === Balance Management ===

  // Open balance management modal
  app.action('admin_balances', async ({ ack, body, client }) => {
    await ack();
    const userId = body.user.id;

    if (!await requireAdmin(client, userId, undefined, true)) return;

    logger.action('admin_balances', userId);

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
  const createBalancePaginationHandler = () => async ({ ack, body, client, action }: any) => {
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

  // Open adjust balance modal
  app.action('admin_adjust_balance_modal', async ({ ack, body, client }) => {
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

  // Handle adjust balance submission
  app.view('adjust_balance_submit', async ({ ack, body, view, client }) => {
    const userId = body.user.id;
    const values = view.state.values;

    try {
      const selectedUser = values.user_block?.selected_user?.selected_user;
      const leaveTypeId = values.leave_type_block?.selected_leave_type?.selected_option?.value;
      const adjustmentStr = values.adjustment_block?.adjustment_value?.value;

      if (!selectedUser || !leaveTypeId || !adjustmentStr) {
        await ack({
          response_action: 'errors',
          errors: {
            ...((!selectedUser) && { user_block: 'Please select a user' }),
            ...((!leaveTypeId) && { leave_type_block: 'Please select a leave type' }),
            ...((!adjustmentStr) && { adjustment_block: 'Please enter an adjustment value' }),
          },
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

      await ensureUsersExist(client, [selectedUser]);
      await adjustBalance(selectedUser, leaveTypeId, adjustment);

      await ack({ response_action: 'clear' });

      const sign = adjustment >= 0 ? '+' : '';
      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: `✅ Adjusted balance for <@${selectedUser}> by ${sign}${adjustment} days!`,
      });
    } catch (error) {
      logger.error('Error adjusting balance', error);
      await ack({
        response_action: 'errors',
        errors: { adjustment_block: error instanceof Error ? error.message : 'Could not adjust balance' },
      });
    }
  });

  // Open set allowance modal
  app.action('admin_set_allowance_modal', async ({ ack, body, client }) => {
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

  // Handle set allowance submission
  app.view('set_allowance_submit', async ({ ack, body, view, client }) => {
    const userId = body.user.id;
    const values = view.state.values;

    try {
      const selectedUser = values.user_block?.selected_user?.selected_user;
      const leaveTypeId = values.leave_type_block?.selected_leave_type?.selected_option?.value;
      const allowanceStr = values.allowance_block?.allowance_value?.value;

      if (!selectedUser || !leaveTypeId || !allowanceStr) {
        await ack({
          response_action: 'errors',
          errors: {
            ...((!selectedUser) && { user_block: 'Please select a user' }),
            ...((!leaveTypeId) && { leave_type_block: 'Please select a leave type' }),
            ...((!allowanceStr) && { allowance_block: 'Please enter an allowance value' }),
          },
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

      await ensureUsersExist(client, [selectedUser]);
      await setAllowance(selectedUser, leaveTypeId, allowance);

      await ack({ response_action: 'clear' });

      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: `✅ Set allowance for <@${selectedUser}> to ${allowance} days!`,
      });
    } catch (error) {
      logger.error('Error setting allowance', error);
      await ack({
        response_action: 'errors',
        errors: { allowance_block: error instanceof Error ? error.message : 'Could not set allowance' },
      });
    }
  });
}
