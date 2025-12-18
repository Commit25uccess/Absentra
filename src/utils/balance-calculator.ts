/**
 * Balance Calculation Utilities
 *
 * Reusable functions for calculating leave balance summaries
 * to eliminate code duplication across services.
 */

import type { LeaveBalance, LeaveType } from '@prisma/client';
import { getCurrentYear } from './dates';

/**
 * Balance summary interface
 */
export interface BalanceSummary {
  leaveType: LeaveType;
  allowance: number;
  used: number;
  adjustment: number;
  remaining: number;
  year: number;
}

/**
 * Calculate balance summary from a balance record and leave type
 *
 * @param balance - Optional leave balance record
 * @param leaveType - Leave type configuration
 * @param year - Year for the balance (defaults to current year)
 * @returns Balance summary with calculated remaining days
 *
 * @example
 * ```typescript
 * const summary = calculateBalanceSummary(
 *   { allowance: 20, used: 5, adjustment: 2 },
 *   leaveType,
 *   2026
 * );
 * // { allowance: 20, used: 5, adjustment: 2, remaining: 17, year: 2026 }
 * ```
 */
export function calculateBalanceSummary(
  balance: Pick<LeaveBalance, 'allowance' | 'used' | 'adjustment'> | null | undefined,
  leaveType: LeaveType,
  year?: number
): BalanceSummary {
  const targetYear = year ?? getCurrentYear();

  const allowance = Number(balance?.allowance ?? leaveType.defaultAllowance ?? 0);
  const used = Number(balance?.used ?? 0);
  const adjustment = Number(balance?.adjustment ?? 0);
  const remaining = allowance + adjustment - used;

  return {
    leaveType,
    allowance,
    used,
    adjustment,
    remaining,
    year: targetYear,
  };
}

/**
 * Check if a user has sufficient balance for a leave request
 *
 * @param remaining - Current remaining balance
 * @param requested - Requested number of days
 * @param allowNegative - Whether negative balance is allowed
 * @returns Object indicating if balance is sufficient
 *
 * @example
 * ```typescript
 * const check = hasSufficientBalance(5, 3, false);
 * // { sufficient: true, remaining: 5, requested: 3, deficit: 0 }
 *
 * const check2 = hasSufficientBalance(2, 5, false);
 * // { sufficient: false, remaining: 2, requested: 5, deficit: 3 }
 * ```
 */
export function hasSufficientBalance(
  remaining: number,
  requested: number,
  allowNegative: boolean
): {
  sufficient: boolean;
  remaining: number;
  requested: number;
  deficit: number;
} {
  const deficit = Math.max(0, requested - remaining);
  const sufficient = allowNegative || remaining >= requested;

  return {
    sufficient,
    remaining,
    requested,
    deficit,
  };
}

/**
 * Calculate new balance after a transaction
 *
 * @param currentAllowance - Current allowance
 * @param currentUsed - Current used days
 * @param currentAdjustment - Current adjustment
 * @param change - Change to apply (positive for consumption, negative for release)
 * @returns New balance values
 *
 * @example
 * ```typescript
 * // Consuming 3 days
 * const newBalance = applyBalanceChange(20, 5, 2, 3);
 * // { allowance: 20, used: 8, adjustment: 2, remaining: 14 }
 *
 * // Releasing 3 days (canceling)
 * const newBalance2 = applyBalanceChange(20, 8, 2, -3);
 * // { allowance: 20, used: 5, adjustment: 2, remaining: 17 }
 * ```
 */
export function applyBalanceChange(
  currentAllowance: number,
  currentUsed: number,
  currentAdjustment: number,
  change: number
): {
  allowance: number;
  used: number;
  adjustment: number;
  remaining: number;
} {
  // We always modify the 'used' field
  // Positive change = more days used (consumption)
  // Negative change = fewer days used (release/cancellation)
  const newUsed = Math.max(0, currentUsed + change);

  const remaining = currentAllowance + currentAdjustment - newUsed;

  return {
    allowance: currentAllowance,
    used: newUsed,
    adjustment: currentAdjustment,
    remaining,
  };
}

/**
 * Validate balance constraints
 *
 * @param remaining - Current remaining balance
 * @param requested - Requested days
 * @param allowNegative - Whether negative balance is allowed
 * @returns Validation result with error message if invalid
 *
 * @example
 * ```typescript
 * const validation = validateBalanceConstraint(2, 5, false);
 * // { valid: false, error: 'Insufficient balance: have 2 days, need 5 days' }
 * ```
 */
export function validateBalanceConstraint(
  remaining: number,
  requested: number,
  allowNegative: boolean
): {
  valid: boolean;
  error?: string;
} {
  if (!allowNegative && remaining < requested) {
    return {
      valid: false,
      error: `Insufficient balance: have ${remaining} day${remaining !== 1 ? 's' : ''}, need ${requested} day${requested !== 1 ? 's' : ''}`,
    };
  }

  return { valid: true };
}

/**
 * Format balance for display
 *
 * @param summary - Balance summary
 * @returns Formatted string representation
 *
 * @example
 * ```typescript
 * const formatted = formatBalanceForDisplay({
 *   leaveType: { name: 'Sick Leave' },
 *   allowance: 20,
 *   used: 5,
 *   adjustment: 2,
 *   remaining: 17,
 *   year: 2026,
 * });
 * // "Sick Leave: 17 days remaining (20 allowance + 2 adjustment - 5 used)"
 * ```
 */
export function formatBalanceForDisplay(summary: BalanceSummary): string {
  const { leaveType, allowance, used, adjustment, remaining } = summary;

  const parts: string[] = [`${leaveType.name}: ${remaining} day${remaining !== 1 ? 's' : ''} remaining`];

  if (adjustment !== 0) {
    parts.push(`(${allowance} allowance ${adjustment > 0 ? '+' : ''}${adjustment} adjustment - ${used} used)`);
  } else {
    parts.push(`(${allowance} allowance - ${used} used)`);
  }

  return parts.join(' ');
}
