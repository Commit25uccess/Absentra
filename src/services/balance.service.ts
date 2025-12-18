import { prisma } from '../db/client';
import { getCurrentYear } from '../utils/dates';
import { getUserBySlackIdOrThrow } from './user.service';
import type { LeaveBalance, LeaveType } from '@prisma/client';

export interface BalanceWithType extends LeaveBalance {
  leaveType: LeaveType;
}

export interface BalanceSummary {
  leaveType: LeaveType;
  allowance: number;
  used: number;
  adjustment: number;
  remaining: number;
  year: number;
}

/**
 * Get all balances for a user for the current year
 */
export async function getUserBalances(
  userSlackId: string,
  year?: number
): Promise<BalanceSummary[]> {
  const targetYear = year ?? getCurrentYear();

  const user = await prisma.user.findUnique({
    where: { slackId: userSlackId },
  });

  if (!user) {
    return [];
  }

  // Get leave types and balances in parallel
  const [leaveTypes, balances] = await Promise.all([
    prisma.leaveType.findMany({
      where: { isActive: true, affectsBalance: true },
      orderBy: { order: 'asc' },
    }),
    prisma.leaveBalance.findMany({
      where: { userId: user.id, year: targetYear },
      include: { leaveType: true },
    }),
  ]);

  const balanceMap = new Map<string, LeaveBalance>();
  balances.forEach((b) => balanceMap.set(b.leaveTypeId, b));

  // Build summary for each leave type
  return leaveTypes.map((lt) => {
    const balance = balanceMap.get(lt.id);
    const allowance = balance?.allowance ?? lt.defaultAllowance ?? 0;
    const used = balance?.used ?? 0;
    const adjustment = balance?.adjustment ?? 0;

    return {
      leaveType: lt,
      allowance,
      used,
      adjustment,
      remaining: allowance + adjustment - used,
      year: targetYear,
    };
  });
}

/**
 * Get a specific balance
 */
export async function getBalance(
  userSlackId: string,
  leaveTypeId: string,
  year?: number
): Promise<BalanceSummary | null> {
  const targetYear = year ?? getCurrentYear();

  const user = await prisma.user.findUnique({
    where: { slackId: userSlackId },
  });

  if (!user) {
    return null;
  }

  // Fetch leave type and balance in parallel
  const [leaveType, balance] = await Promise.all([
    prisma.leaveType.findUnique({ where: { id: leaveTypeId } }),
    prisma.leaveBalance.findUnique({
      where: {
        userId_leaveTypeId_year: {
          userId: user.id,
          leaveTypeId,
          year: targetYear,
        },
      },
    }),
  ]);

  if (!leaveType) {
    return null;
  }

  const allowance = balance?.allowance ?? leaveType.defaultAllowance ?? 0;
  const used = balance?.used ?? 0;
  const adjustment = balance?.adjustment ?? 0;

  return {
    leaveType,
    allowance,
    used,
    adjustment,
    remaining: allowance + adjustment - used,
    year: targetYear,
  };
}

/**
 * Check if user has sufficient balance for a leave request
 */
export async function hasSufficientBalance(
  userSlackId: string,
  leaveTypeId: string,
  days: number
): Promise<{ sufficient: boolean; remaining: number; allowNegative: boolean }> {
  const [balance, settings] = await Promise.all([
    getBalance(userSlackId, leaveTypeId),
    prisma.settings.findUnique({ where: { id: 'default' } }),
  ]);

  if (!balance) {
    return {
      sufficient: false,
      remaining: 0,
      allowNegative: settings?.allowNegativeBalance ?? false,
    };
  }

  const allowNegative = settings?.allowNegativeBalance ?? false;
  const sufficient = allowNegative || balance.remaining >= days;

  return {
    sufficient,
    remaining: balance.remaining,
    allowNegative,
  };
}

/**
 * Adjust a user's balance (for manual adjustments, carryover, etc.)
 */
export async function adjustBalance(
  userSlackId: string,
  leaveTypeId: string,
  adjustment: number,
  year?: number
): Promise<BalanceSummary | null> {
  const targetYear = year ?? getCurrentYear();

  const user = await getUserBySlackIdOrThrow(userSlackId);

  const leaveType = await prisma.leaveType.findUnique({
    where: { id: leaveTypeId },
  });

  if (!leaveType) {
    throw new Error('Leave type not found');
  }

  await prisma.leaveBalance.upsert({
    where: {
      userId_leaveTypeId_year: {
        userId: user.id,
        leaveTypeId,
        year: targetYear,
      },
    },
    update: {
      adjustment: { increment: adjustment },
    },
    create: {
      userId: user.id,
      leaveTypeId,
      year: targetYear,
      allowance: leaveType.defaultAllowance ?? 0,
      adjustment,
    },
  });

  return getBalance(userSlackId, leaveTypeId, targetYear);
}

/**
 * Set a user's allowance for a specific leave type
 */
export async function setAllowance(
  userSlackId: string,
  leaveTypeId: string,
  allowance: number,
  year?: number
): Promise<BalanceSummary | null> {
  const targetYear = year ?? getCurrentYear();

  const user = await getUserBySlackIdOrThrow(userSlackId);

  await prisma.leaveBalance.upsert({
    where: {
      userId_leaveTypeId_year: {
        userId: user.id,
        leaveTypeId,
        year: targetYear,
      },
    },
    update: { allowance },
    create: {
      userId: user.id,
      leaveTypeId,
      year: targetYear,
      allowance,
    },
  });

  return getBalance(userSlackId, leaveTypeId, targetYear);
}

/**
 * Get balance overview for all users (admin view)
 * Optimized to fetch all data in batch queries instead of N+1
 */
export async function getAllUsersBalances(
  year?: number
): Promise<Array<{ user: { slackId: string; displayName: string }; balances: BalanceSummary[] }>> {
  const targetYear = year ?? getCurrentYear();

  // Batch query all data in parallel
  const [users, leaveTypes, allBalances] = await Promise.all([
    prisma.user.findMany({
      where: { isActive: true },
      orderBy: { displayName: 'asc' },
    }),
    prisma.leaveType.findMany({
      where: { isActive: true, affectsBalance: true },
      orderBy: { order: 'asc' },
    }),
    prisma.leaveBalance.findMany({
      where: { year: targetYear },
      include: { leaveType: true },
    }),
  ]);

  if (users.length === 0) {
    return [];
  }

  // Create lookup map: userId -> leaveTypeId -> balance
  const balanceMap = new Map<string, Map<string, LeaveBalance>>();
  for (const balance of allBalances) {
    if (!balanceMap.has(balance.userId)) {
      balanceMap.set(balance.userId, new Map());
    }
    balanceMap.get(balance.userId)!.set(balance.leaveTypeId, balance);
  }

  // Build results for each user
  return users.map(user => {
    const userBalanceMap = balanceMap.get(user.id) || new Map();

    const balances: BalanceSummary[] = leaveTypes.map(lt => {
      const balance = userBalanceMap.get(lt.id);
      const allowance = balance?.allowance ?? lt.defaultAllowance ?? 0;
      const used = balance?.used ?? 0;
      const adjustment = balance?.adjustment ?? 0;

      return {
        leaveType: lt,
        allowance,
        used,
        adjustment,
        remaining: allowance + adjustment - used,
        year: targetYear,
      };
    });

    return {
      user: { slackId: user.slackId, displayName: user.displayName },
      balances,
    };
  });
}
