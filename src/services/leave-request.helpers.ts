/**
 * Leave Request Helper Functions
 *
 * Private helper functions extracted from leave-request.service.ts
 * to improve code organization and testability.
 */

import { prisma } from '../db/client';
import { getCurrentYear } from '../utils/dates';
import { OverlappingRequestError, NotFoundError, ValidationError, InsufficientBalanceError } from '../utils/errors';
import type { LeaveType, Prisma } from '@prisma/client';
import logger from '../utils/logger';
import { validateBalanceConstraint } from '../utils/balance-calculator';

const requestLogger = logger.child('leave-request-helper');

/**
 * Validate and fetch leave type by ID
 */
export async function validateLeaveType(leaveTypeId: string): Promise<LeaveType> {
  const leaveType = await prisma.leaveType.findUnique({
    where: { id: leaveTypeId },
  });

  if (!leaveType) {
    requestLogger.warn({
      event: 'leave_type_not_found',
      leaveTypeId,
    });
    throw new NotFoundError('LeaveType', leaveTypeId);
  }

  return leaveType;
}

/**
 * Check for overlapping leave requests
 */
export async function validateNoOverlappingRequests(
  userId: string,
  startDate: Date,
  endDate: Date
): Promise<void> {
  const overlapping = await prisma.leaveRequest.findFirst({
    where: {
      requesterId: userId,
      status: { in: ['PENDING', 'APPROVED'] },
      OR: [
        {
          startDate: { lte: endDate },
          endDate: { gte: startDate },
        },
      ],
    },
  });

  if (overlapping) {
    requestLogger.warn({
      event: 'overlapping_request_detected',
      userId,
      existingRequestId: overlapping.id,
    });
    throw new OverlappingRequestError();
  }
}

/**
 * Determine initial request status based on settings and leave type
 */
export async function determineInitialStatus(leaveType: LeaveType): Promise<string> {
  const settings = await prisma.settings.findUnique({ where: { id: 'default' } });
  const requiresApproval = settings?.requireApproval && leaveType.requiresApproval;
  return requiresApproval ? 'PENDING' : 'APPROVED';
}

/**
 * Validate sufficient balance for auto-approved requests
 */
export async function validateSufficientBalanceForAutoApproval(
  userId: string,
  leaveType: LeaveType,
  totalDays: number
): Promise<void> {
  const currentBalance = await prisma.leaveBalance.findUnique({
    where: {
      userId_leaveTypeId_year: {
        userId,
        leaveTypeId: leaveType.id,
        year: getCurrentYear(),
      },
    },
  });

  const settings = await prisma.settings.findUnique({
    where: { id: 'default' },
  });

  const allowance = currentBalance?.allowance ?? leaveType.defaultAllowance ?? 0;
  const used = currentBalance?.used ?? 0;
  const adjustment = currentBalance?.adjustment ?? 0;
  const remaining = Number(allowance) + Number(adjustment) - Number(used);
  const allowNegative = settings?.allowNegativeBalance ?? false;

  const validation = validateBalanceConstraint(remaining, totalDays, allowNegative);

  if (!validation.valid) {
    throw new InsufficientBalanceError(remaining, totalDays);
  }
}

/**
 * Create leave request with transaction
 */
export async function createLeaveRequestWithTransaction(
  userId: string,
  leaveTypeId: string,
  input: {
    startDate: Date;
    endDate: Date;
    isHalfDay?: boolean;
    halfDayPeriod?: 'morning' | 'afternoon';
    totalDays: number;
    reason?: string;
    teamNotes?: string;
  },
  initialStatus: string,
  leaveTypeAffectsBalance: boolean
) {
  return await prisma.$transaction(async (tx) => {
    // Create the leave request
    const created = await tx.leaveRequest.create({
      data: {
        requesterId: userId,
        leaveTypeId,
        startDate: input.startDate,
        endDate: input.endDate,
        isHalfDay: input.isHalfDay ?? false,
        halfDayPeriod: input.halfDayPeriod,
        totalDays: input.totalDays,
        reason: input.reason,
        teamNotes: input.teamNotes,
        status: initialStatus,
        approvedAt: initialStatus === 'APPROVED' ? new Date() : null,
      },
      include: {
        requester: true,
        leaveType: true,
        approver: true,
      },
    });

    // If auto-approved and affects balance, update balance within same transaction
    if (initialStatus === 'APPROVED' && leaveTypeAffectsBalance) {
      await updateLeaveBalanceInTransaction(
        tx,
        userId,
        leaveTypeId,
        input.totalDays
      );
    }

    return created;
  });
}

/**
 * Update leave balance within a transaction
 */
async function updateLeaveBalanceInTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  leaveTypeId: string,
  days: number
): Promise<void> {
  const currentYear = getCurrentYear();

  // Fetch leave type to get default allowance for new balance records
  const leaveType = await tx.leaveType.findUnique({
    where: { id: leaveTypeId },
  });

  await tx.leaveBalance.upsert({
    where: {
      userId_leaveTypeId_year: {
        userId,
        leaveTypeId,
        year: currentYear,
      },
    },
    update: {
      used: { increment: days },
    },
    create: {
      userId,
      leaveTypeId,
      year: currentYear,
      allowance: leaveType?.defaultAllowance ?? 0,
      used: days,
      adjustment: 0,
    },
  });

  requestLogger.debug({
    event: 'leave_balance_updated_in_transaction',
    userId,
    leaveTypeId,
    days,
    year: currentYear,
  });
}

/**
 * Validate that a request can be cancelled
 */
export async function validateRequestCancellation(
  request: {
    id: string;
    requesterId: string;
    status: string;
    startDate: Date;
    endDate: Date;
  },
  userId: string,
  leaveTypeAffectsBalance: boolean
): Promise<{
  canCancel: boolean;
  shouldRestoreBalance: boolean;
}> {
  // Verify ownership
  if (request.requesterId !== userId) {
    requestLogger.warn({
      event: 'cancellation_failed_not_owner',
      requestId: request.id,
      requesterId: request.requesterId,
      attemptedBy: userId,
    });
    throw new Error('Unauthorized');
  }

  // Check if already cancelled
  if (request.status === 'CANCELLED') {
    throw new ValidationError('This request is already cancelled');
  }

  // Validate: Cannot cancel past leave requests
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endDate = new Date(request.endDate);
  endDate.setHours(0, 0, 0, 0);

  if (endDate < today) {
    requestLogger.warn({
      event: 'cancellation_failed_past_request',
      requestId: request.id,
      endDate: request.endDate,
      today,
    });
    throw new ValidationError('Cannot cancel leave requests that have already ended. Please contact your administrator if you need to make changes to past records.');
  }

  // Determine if balance should be restored
  const startDate = new Date(request.startDate);
  startDate.setHours(0, 0, 0, 0);
  const shouldRestoreBalance = startDate > today &&
    request.status === 'APPROVED' &&
    leaveTypeAffectsBalance;

  return {
    canCancel: true,
    shouldRestoreBalance,
  };
}

/**
 * Log leave request creation
 */
export function logLeaveRequestCreated(
  requestId: string,
  userId: string,
  leaveTypeName: string,
  totalDays: number,
  status: string
): void {
  requestLogger.info({
    event: 'leave_request_created',
    requestId,
    userId,
    leaveType: leaveTypeName,
    totalDays,
    status,
  });
}
