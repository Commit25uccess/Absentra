import { prisma } from '../db/client';
import { getCurrentYear } from '../utils/dates';
import { config } from '../config';
import logger from '../utils/logger';
import { NotFoundError } from '../utils/errors';
import type { User } from '@prisma/client';

const userLogger = logger.child('user-service');

interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  profile?: {
    email?: string;
    display_name?: string;
    real_name?: string;
    image_72?: string;
  };
  deleted?: boolean;
}

/**
 * Check if a Slack ID is the configured env admin
 */
function isEnvAdmin(slackId: string): boolean {
  return config.app.adminSlackId !== '' && config.app.adminSlackId === slackId;
}

/**
 * Get user by Slack ID or throw if not found
 */
export async function getUserBySlackIdOrThrow(slackId: string): Promise<User> {
  const user = await prisma.user.findUnique({ where: { slackId } });
  if (!user) {
    throw new NotFoundError('User', slackId);
  }
  return user;
}

/**
 * Get or create a user from Slack user info
 */
export async function getOrCreateUser(slackUser: SlackUser): Promise<User> {
  const displayName =
    slackUser.profile?.display_name ||
    slackUser.profile?.real_name ||
    slackUser.real_name ||
    slackUser.name ||
    'Unknown User';

  // Check if this user should be auto-promoted to admin via env variable
  const shouldBeAdmin = isEnvAdmin(slackUser.id);

  try {
    const user = await prisma.user.upsert({
      where: { slackId: slackUser.id },
      update: {
        displayName,
        realName: slackUser.real_name || slackUser.profile?.real_name,
        email: slackUser.profile?.email,
        avatarUrl: slackUser.profile?.image_72,
        isActive: !slackUser.deleted,
        // Auto-promote env admin if not already admin
        ...(shouldBeAdmin && { isAdmin: true }),
      },
      create: {
        slackId: slackUser.id,
        displayName,
        realName: slackUser.real_name || slackUser.profile?.real_name,
        email: slackUser.profile?.email,
        avatarUrl: slackUser.profile?.image_72,
        isActive: !slackUser.deleted,
        isAdmin: shouldBeAdmin,
      },
    });

    // Ensure user has balances for the current year
    await ensureUserBalances(user.id);

    userLogger.debug({ event: 'user_synced', slackId: slackUser.id, displayName });

    return user;
  } catch (error) {
    userLogger.error({ event: 'user_create_failed', slackId: slackUser.id }, error);
    throw error;
  }
}

/**
 * Get user by Slack ID
 */
export async function getUserBySlackId(slackId: string): Promise<User | null> {
  return prisma.user.findUnique({
    where: { slackId },
    include: {
      team: true,
      leaveBalances: {
        where: { year: getCurrentYear() },
        include: { leaveType: true },
      },
    },
  });
}

/**
 * Get user by internal ID
 */
export async function getUserById(id: string): Promise<User | null> {
  return prisma.user.findUnique({
    where: { id },
    include: {
      team: true,
    },
  });
}

/**
 * Check if a user is an admin
 */
export async function isUserAdmin(slackId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { slackId },
    select: { isAdmin: true },
  });
  return user?.isAdmin ?? false;
}

/**
 * Check if a user is a manager of any team
 */
export async function isUserManager(slackId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { slackId },
    include: {
      managedTeams: true,
    },
  });
  return (user?.managedTeams?.length ?? 0) > 0;
}

/**
 * Check if a user can approve requests for another user
 */
export async function canApproveFor(
  approverSlackId: string,
  requesterSlackId: string
): Promise<boolean> {
  const approver = await prisma.user.findUnique({
    where: { slackId: approverSlackId },
    include: { managedTeams: true },
  });

  if (!approver) return false;

  // Admins can approve for anyone
  if (approver.isAdmin) return true;

  // Get the requester's team
  const requester = await prisma.user.findUnique({
    where: { slackId: requesterSlackId },
    select: { teamId: true },
  });

  if (!requester?.teamId) return false;

  // Check if approver manages the requester's team
  return approver.managedTeams.some((team) => team.id === requester.teamId);
}

/**
 * Set a user as admin
 */
export async function setUserAdmin(slackId: string, isAdmin: boolean): Promise<User> {
  const user = await prisma.user.update({
    where: { slackId },
    data: { isAdmin },
  });

  userLogger.info({ event: 'user_admin_updated', slackId, isAdmin });

  return user;
}

/**
 * Assign a user to a team
 */
export async function assignUserToTeam(
  userSlackId: string,
  teamId: string
): Promise<User> {
  const user = await prisma.user.update({
    where: { slackId: userSlackId },
    data: { teamId },
  });

  userLogger.info({ event: 'user_team_assigned', slackId: userSlackId, teamId });

  return user;
}

/**
 * Get all managers who can approve for a user
 */
export async function getApproversForUser(userSlackId: string): Promise<User[]> {
  const user = await prisma.user.findUnique({
    where: { slackId: userSlackId },
    select: { teamId: true },
  });

  if (!user?.teamId) {
    // If user has no team, return all admins
    return prisma.user.findMany({
      where: { isAdmin: true, isActive: true },
    });
  }

  // Get team managers and admins in parallel
  const [team, admins] = await Promise.all([
    prisma.team.findUnique({
      where: { id: user.teamId },
      include: { managers: { where: { isActive: true } } },
    }),
    prisma.user.findMany({
      where: { isAdmin: true, isActive: true },
    }),
  ]);

  // Combine and deduplicate
  const approverMap = new Map<string, User>();
  team?.managers.forEach((m) => approverMap.set(m.id, m));
  admins.forEach((a) => approverMap.set(a.id, a));

  return Array.from(approverMap.values());
}

/**
 * Ensure user has balance records for all leave types for current year
 */
async function ensureUserBalances(userId: string): Promise<void> {
  const currentYear = getCurrentYear();

  const [leaveTypes, existingBalances] = await Promise.all([
    prisma.leaveType.findMany({
      where: { isActive: true, affectsBalance: true },
    }),
    prisma.leaveBalance.findMany({
      where: { userId, year: currentYear },
      select: { leaveTypeId: true },
    }),
  ]);

  const existingTypeIds = new Set(existingBalances.map((b) => b.leaveTypeId));

  const newBalances = leaveTypes
    .filter((lt) => !existingTypeIds.has(lt.id))
    .map((lt) => ({
      userId,
      leaveTypeId: lt.id,
      year: currentYear,
      allowance: lt.defaultAllowance ?? 0,
      used: 0,
      adjustment: 0,
    }));

  if (newBalances.length > 0) {
    await prisma.leaveBalance.createMany({ data: newBalances });
    userLogger.debug({
      event: 'user_balances_created',
      userId,
      count: newBalances.length,
      year: currentYear,
    });
  }
}

/**
 * Get all active users
 */
export async function getAllActiveUsers(): Promise<User[]> {
  return prisma.user.findMany({
    where: { isActive: true },
    include: { team: true },
    orderBy: { displayName: 'asc' },
  });
}

/**
 * Sync all users from Slack workspace
 * This fetches all real users (not bots, not deleted) and creates/updates them in our DB
 */
export async function syncWorkspaceUsers(client: any): Promise<User[]> {
  userLogger.info({ event: 'workspace_sync_starting' });
  const startTime = Date.now();

  try {
    const result = await client.users.list();

    if (!result.members) {
      userLogger.warn({ event: 'workspace_sync_no_members' });
      return [];
    }

    const realUsers = result.members.filter((member: any) =>
      !member.is_bot &&
      !member.deleted &&
      member.id !== 'USLACKBOT' &&
      !member.is_app_user
    );

    userLogger.debug({
      event: 'workspace_sync_filtered',
      total: result.members.length,
      real: realUsers.length,
    });

    // Process users in parallel (with concurrency limit to avoid overwhelming DB)
    const BATCH_SIZE = 10;
    const syncedUsers: User[] = [];

    for (let i = 0; i < realUsers.length; i += BATCH_SIZE) {
      const batch = realUsers.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((slackUser: SlackUser) => getOrCreateUser(slackUser))
      );
      syncedUsers.push(...batchResults);
    }

    const duration = Date.now() - startTime;
    userLogger.info({
      event: 'workspace_sync_completed',
      syncedCount: syncedUsers.length,
      duration,
    });

    return syncedUsers;
  } catch (error) {
    userLogger.error({ event: 'workspace_sync_failed' }, error);
    // Fall back to cached users
    return getAllActiveUsers();
  }
}
