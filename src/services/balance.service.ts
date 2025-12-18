import { prisma, executeWithRetry } from '../db/client';
import { getCurrentYear } from '../utils/dates';
import { getUserBySlackIdOrThrow } from './user.service';
import { NotFoundError } from '../utils/errors';
import type { LeaveBalance, LeaveType } from '@prisma/client';
import logger from '../utils/logger';
import {
  calculateBalanceSummary,
  type BalanceSummary as UtilBalanceSummary,
} from '../utils/balance-calculator';

const balanceLogger = logger.child('balance-service');

export interface BalanceWithType extends LeaveBalance {
  leaveType: LeaveType;
}

// Re-export the utility type for backward compatibility
export type BalanceSummary = UtilBalanceSummary;

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

  // Build summary for each leave type using the utility function
  return leaveTypes.map((lt) => {
    const balance = balanceMap.get(lt.id);
    return calculateBalanceSummary(balance, lt, targetYear);
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

  // Use the utility function to calculate the summary
  return calculateBalanceSummary(balance, leaveType, targetYear);
}

/**
 * Check if user has sufficient balance for a leave request
 * This is a read-only check - for atomic operations, use reserveBalance or consumeBalance
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
 * Reserve balance for a leave request (atomic operation)
 * This prevents race conditions when multiple requests are processed simultaneously
 */
export async function reserveBalance(
  userSlackId: string,
  leaveTypeId: string,
  days: number,
  requestId?: string
): Promise<{ success: boolean; remaining: number; newBalance?: BalanceSummary }> {
  return executeWithRetry(async () => {
    const result = await prisma.$transaction(async (tx) => {
      // Get current balance within transaction for consistency
      const user = await tx.user.findUnique({
        where: { slackId: userSlackId },
      });

      if (!user) {
        throw new NotFoundError('User', userSlackId);
      }

      const currentBalance = await tx.leaveBalance.findUnique({
        where: {
          userId_leaveTypeId_year: {
            userId: user.id,
            leaveTypeId,
            year: getCurrentYear(),
          },
        },
      });

      const leaveType = await tx.leaveType.findUnique({
        where: { id: leaveTypeId },
      });

      if (!leaveType) {
        throw new NotFoundError('LeaveType', leaveTypeId);
      }

      const allowance = currentBalance?.allowance ?? leaveType.defaultAllowance ?? 0;
      const used = currentBalance?.used ?? 0;
      const adjustment = currentBalance?.adjustment ?? 0;
      const currentRemaining = Number(allowance) + Number(adjustment) - Number(used);

      // Check if reservation would exceed balance
      const settings = await tx.settings.findUnique({
        where: { id: 'default' },
      });

      const allowNegative = settings?.allowNegativeBalance ?? false;
      if (!allowNegative && currentRemaining < days) {
        balanceLogger.warn({
          event: 'balance_reservation_insufficient',
          userSlackId,
          leaveTypeId,
          requestedDays: days,
          remaining: currentRemaining,
          requestId,
        });
        
        return {
          success: false,
          remaining: currentRemaining,
        };
      }

      // Create or update balance record
      const updatedBalance = await tx.leaveBalance.upsert({
        where: {
          userId_leaveTypeId_year: {
            userId: user.id,
            leaveTypeId,
            year: getCurrentYear(),
          },
        },
        update: {
          used: { increment: days },
        },
        create: {
          userId: user.id,
          leaveTypeId,
          year: getCurrentYear(),
          allowance: leaveType.defaultAllowance ?? 0,
          used: days,
          adjustment: 0,
        },
      });

      const newRemaining = Number(allowance) + Number(adjustment) - (Number(used) + days);

      balanceLogger.info({
        event: 'balance_reserved',
        userSlackId,
        leaveTypeId,
        days,
        requestId,
        previousRemaining: currentRemaining,
        newRemaining,
      });

      return {
        success: true,
        remaining: newRemaining,
        newBalance: {
          leaveType: leaveType as any,
          allowance: Number(updatedBalance.allowance),
          used: Number(updatedBalance.used),
          adjustment: Number(updatedBalance.adjustment),
          remaining: newRemaining,
          year: getCurrentYear(),
        },
      };
    });

    return result;
  }, 'reserve balance');
}

/**
 * Release balance (when a leave request is cancelled or rejected)
 * This is the opposite of reserveBalance
 */
export async function releaseBalance(
  userSlackId: string,
  leaveTypeId: string,
  days: number,
  requestId?: string
): Promise<{ success: boolean; remaining: number }> {
  return executeWithRetry(async () => {
    const result = await prisma.$transaction(async (tx) => {
      // Get current balance within transaction for consistency
      const user = await tx.user.findUnique({
        where: { slackId: userSlackId },
      });

      if (!user) {
        throw new NotFoundError('User', userSlackId);
      }

      const currentBalance = await tx.leaveBalance.findUnique({
        where: {
          userId_leaveTypeId_year: {
            userId: user.id,
            leaveTypeId,
            year: getCurrentYear(),
          },
        },
      });

      if (!currentBalance) {
        balanceLogger.warn({
          event: 'balance_release_no_record',
          userSlackId,
          leaveTypeId,
          days,
          requestId,
        });
        
        return {
          success: false,
          remaining: 0,
        };
      }

      // Ensure we don't release more than what was used
      if (Number(currentBalance.used) < days) {
        balanceLogger.warn({
          event: 'balance_release_excess',
          userSlackId,
          leaveTypeId,
          days,
          currentUsed: currentBalance.used,
          requestId,
        });
        
        return {
          success: false,
          remaining: Number(currentBalance.allowance) + Number(currentBalance.adjustment) - Number(currentBalance.used),
        };
      }

      // Update balance record
      const updatedBalance = await tx.leaveBalance.update({
        where: { id: currentBalance.id },
        data: {
          used: { decrement: days },
        },
      });

      const newRemaining = Number(updatedBalance.allowance) + Number(updatedBalance.adjustment) - Number(updatedBalance.used);

      balanceLogger.info({
        event: 'balance_released',
        userSlackId,
        leaveTypeId,
        days,
        requestId,
        previousRemaining: Number(currentBalance.allowance) + Number(currentBalance.adjustment) - Number(currentBalance.used),
        newRemaining,
      });

      return {
        success: true,
        remaining: newRemaining,
      };
    });

    return result;
  }, 'release balance');
}

/**
 * Confirm balance consumption (when a leave request moves from pending to approved)
 * This finalizes the balance reservation
 */
export async function confirmBalanceConsumption(
  userSlackId: string,
  leaveTypeId: string,
  days: number,
  requestId?: string
): Promise<void> {
  balanceLogger.info({
    event: 'balance_consumption_confirmed',
    userSlackId,
    leaveTypeId,
    days,
    requestId,
  });

  // In this implementation, balance is already consumed during reservation
  // This function exists for audit purposes and future enhancements
  // such as temporary reservations that expire if not confirmed
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
    throw new NotFoundError('LeaveType', leaveTypeId);
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

  // Build results for each user using the utility function
  return users.map(user => {
    const userBalanceMap = balanceMap.get(user.id) || new Map();

    const balances: BalanceSummary[] = leaveTypes.map(lt => {
      const balance = userBalanceMap.get(lt.id);
      return calculateBalanceSummary(balance, lt, targetYear);
    });

    return {
      user: { slackId: user.slackId, displayName: user.displayName },
      balances,
    };
  });
}
