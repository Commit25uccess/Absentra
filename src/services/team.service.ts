import { prisma } from '../db/client';
import { getUserBySlackIdOrThrow } from './user.service';
import type { Team, User } from '@prisma/client';

export interface TeamWithMembers extends Team {
  managers: User[];
  members: User[];
}

// Include clause for consistent query results
const teamInclude = {
  managers: true,
  members: { where: { isActive: true } },
} as const;

/**
 * Create a new team
 */
export async function createTeam(
  name: string,
  description?: string
): Promise<Team> {
  return prisma.team.create({
    data: {
      name,
      description,
    },
  });
}

/**
 * Get all teams
 */
export async function getAllTeams(): Promise<TeamWithMembers[]> {
  return prisma.team.findMany({
    include: teamInclude,
    orderBy: { name: 'asc' },
  });
}

/**
 * Get a team by ID
 */
export async function getTeamById(id: string): Promise<TeamWithMembers | null> {
  return prisma.team.findUnique({
    where: { id },
    include: teamInclude,
  });
}

/**
 * Get a team by name
 */
export async function getTeamByName(name: string): Promise<TeamWithMembers | null> {
  return prisma.team.findUnique({
    where: { name },
    include: teamInclude,
  });
}

/**
 * Update a team
 */
export async function updateTeam(
  id: string,
  data: { name?: string; description?: string }
): Promise<Team> {
  return prisma.team.update({
    where: { id },
    data,
  });
}

/**
 * Delete a team
 */
export async function deleteTeam(id: string): Promise<void> {
  // First, remove all members from the team
  await prisma.user.updateMany({
    where: { teamId: id },
    data: { teamId: null },
  });

  // Then delete the team
  await prisma.team.delete({
    where: { id },
  });
}

/**
 * Add a manager to a team
 */
export async function addTeamManager(
  teamId: string,
  userSlackId: string
): Promise<TeamWithMembers> {
  const user = await getUserBySlackIdOrThrow(userSlackId);

  return prisma.team.update({
    where: { id: teamId },
    data: {
      managers: {
        connect: { id: user.id },
      },
    },
    include: teamInclude,
  });
}

/**
 * Remove a manager from a team
 */
export async function removeTeamManager(
  teamId: string,
  userSlackId: string
): Promise<TeamWithMembers> {
  const user = await getUserBySlackIdOrThrow(userSlackId);

  return prisma.team.update({
    where: { id: teamId },
    data: {
      managers: {
        disconnect: { id: user.id },
      },
    },
    include: teamInclude,
  });
}

/**
 * Add a member to a team
 */
export async function addTeamMember(
  teamId: string,
  userSlackId: string
): Promise<User> {
  return prisma.user.update({
    where: { slackId: userSlackId },
    data: { teamId },
  });
}

/**
 * Remove a member from a team
 */
export async function removeTeamMember(userSlackId: string): Promise<User> {
  return prisma.user.update({
    where: { slackId: userSlackId },
    data: { teamId: null },
  });
}

/**
 * Get teams managed by a user
 */
export async function getTeamsManagedByUser(
  userSlackId: string
): Promise<TeamWithMembers[]> {
  const user = await prisma.user.findUnique({
    where: { slackId: userSlackId },
    include: {
      managedTeams: {
        include: teamInclude,
      },
    },
  });

  return user?.managedTeams ?? [];
}

/**
 * Get the team a user belongs to
 */
export async function getUserTeam(
  userSlackId: string
): Promise<TeamWithMembers | null> {
  const user = await prisma.user.findUnique({
    where: { slackId: userSlackId },
    include: {
      team: {
        include: teamInclude,
      },
    },
  });

  return user?.team ?? null;
}
