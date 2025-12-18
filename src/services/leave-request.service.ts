import { prisma, executeWithRetry } from '../db/client';
import { calculateWorkingDays, getCurrentYear, formatDate } from '../utils/dates';
import { startOfDay, endOfDay } from 'date-fns';
import { getUserBySlackIdOrThrow } from './user.service';
import logger from '../utils/logger';
import { NotFoundError, ValidationError, AlreadyProcessedError, UnauthorizedError } from '../utils/errors';
import type { LeaveRequest, LeaveType, User, Prisma } from '@prisma/client';
import {
  validateLeaveType,
  validateNoOverlappingRequests,
  determineInitialStatus,
  validateSufficientBalanceForAutoApproval,
  createLeaveRequestWithTransaction,
  logLeaveRequestCreated,
} from './leave-request.helpers';

const requestLogger = logger.child('leave-request-service');

// Status constants (SQLite doesn't support enums)
export const RequestStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
} as const;

export type RequestStatusType = typeof RequestStatus[keyof typeof RequestStatus];

export interface CreateLeaveRequestInput {
  requesterSlackId: string;
  leaveTypeId: string;
  startDate: Date;
  endDate: Date;
  isHalfDay?: boolean;
  halfDayPeriod?: 'morning' | 'afternoon';
  reason?: string;
  teamNotes?: string;
}

export interface LeaveRequestWithDetails extends LeaveRequest {
  requester: User;
  leaveType: LeaveType;
  approver?: User | null;
}

// Include clause for consistent query results
const leaveRequestInclude = {
  requester: true,
  leaveType: true,
  approver: true,
} as const;

/**
 * Update leave balance within a transaction or standalone
 * Note: For optimal performance, ensure composite index exists on (status, startDate, endDate)
 */
async function updateLeaveBalance(
  tx: Prisma.TransactionClient | typeof prisma,
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
    event: 'leave_balance_updated',
    userId,
    leaveTypeId,
    days,
    year: currentYear,
  });
}

/**
 * Create a new leave request
 * Uses transaction to ensure atomicity when auto-approved
 */
export async function createLeaveRequest(
  input: CreateLeaveRequestInput
): Promise<LeaveRequestWithDetails> {
  requestLogger.debug({
    event: 'leave_request_creating',
    requesterSlackId: input.requesterSlackId,
    leaveTypeId: input.leaveTypeId,
    startDate: await formatDate(input.startDate),
    endDate: await formatDate(input.endDate),
  });

  // Step 1: Validate and fetch user
  const user = await getUserBySlackIdOrThrow(input.requesterSlackId);

  // Step 2: Validate leave type exists
  const leaveType = await validateLeaveType(input.leaveTypeId);

  // Step 3: Calculate total working days
  const totalDays = await calculateWorkingDays(
    input.startDate,
    input.endDate,
    input.isHalfDay
  );

  // Step 4: Validate no overlapping requests
  await validateNoOverlappingRequests(user.id, input.startDate, input.endDate);

  // Step 5: Determine initial status (pending vs auto-approved)
  const initialStatus = await determineInitialStatus(leaveType);

  // Step 6: For auto-approved requests, validate sufficient balance
  if (initialStatus === RequestStatus.APPROVED && leaveType.affectsBalance) {
    await validateSufficientBalanceForAutoApproval(user.id, leaveType, totalDays);
  }

  // Step 7: Create the request with atomic balance update in transaction
  const request = await executeWithRetry(async () => {
    return await createLeaveRequestWithTransaction(
      user.id,
      input.leaveTypeId,
      {
        startDate: input.startDate,
        endDate: input.endDate,
        isHalfDay: input.isHalfDay,
        halfDayPeriod: input.halfDayPeriod,
        totalDays,
        reason: input.reason,
        teamNotes: input.teamNotes,
      },
      initialStatus,
      leaveType.affectsBalance
    );
  }, 'create leave request');

  // Step 8: Log successful creation
  logLeaveRequestCreated(request.id, user.id, leaveType.name, totalDays, initialStatus);

  return request;
}

/**
 * Approve a leave request
 * Uses transaction to ensure atomicity
 */
export async function approveLeaveRequest(
  requestId: string,
  approverSlackId: string,
  note?: string
): Promise<LeaveRequestWithDetails> {
  requestLogger.debug({ event: 'leave_request_approving', requestId, approverSlackId });

  const approver = await getUserBySlackIdOrThrow(approverSlackId);

  const request = await prisma.leaveRequest.findUnique({
    where: { id: requestId },
    include: { leaveType: true, requester: true },
  });

  if (!request) {
    throw new NotFoundError('LeaveRequest', requestId);
  }

  if (request.status !== RequestStatus.PENDING) {
    requestLogger.warn({
      event: 'approval_failed_already_processed',
      requestId,
      currentStatus: request.status,
    });
    throw new AlreadyProcessedError(request.status);
  }

  // Use transaction for atomicity
  const updatedRequest = await prisma.$transaction(async (tx) => {
    const updated = await tx.leaveRequest.update({
      where: { id: requestId },
      data: {
        status: RequestStatus.APPROVED,
        approverId: approver.id,
        approverNote: note,
        approvedAt: new Date(),
      },
      include: leaveRequestInclude,
    });

    // Update balance if this leave type affects it
    if (request.leaveType.affectsBalance) {
      await updateLeaveBalance(tx, request.requesterId, request.leaveTypeId, request.totalDays.toNumber());
    }

    return updated;
  });

  requestLogger.info({
    event: 'leave_request_approved',
    requestId,
    approverId: approver.id,
    requesterId: request.requesterId,
    leaveType: request.leaveType.name,
    totalDays: request.totalDays,
  });

  return updatedRequest;
}

/**
 * Reject a leave request
 */
export async function rejectLeaveRequest(
  requestId: string,
  approverSlackId: string,
  note?: string
): Promise<LeaveRequestWithDetails> {
  requestLogger.debug({ event: 'leave_request_rejecting', requestId, approverSlackId });

  const approver = await getUserBySlackIdOrThrow(approverSlackId);

  const request = await prisma.leaveRequest.findUnique({
    where: { id: requestId },
    include: { leaveType: true, requester: true },
  });

  if (!request) {
    throw new NotFoundError('Leave request');
  }

  if (request.status !== RequestStatus.PENDING) {
    requestLogger.warn({
      event: 'rejection_failed_already_processed',
      requestId,
      currentStatus: request.status,
    });
    throw new AlreadyProcessedError(request.status);
  }

  const updatedRequest = await prisma.leaveRequest.update({
    where: { id: requestId },
    data: {
      status: RequestStatus.REJECTED,
      approverId: approver.id,
      approverNote: note,
    },
    include: leaveRequestInclude,
  });

  requestLogger.info({
    event: 'leave_request_rejected',
    requestId,
    approverId: approver.id,
    requesterId: request.requesterId,
    leaveType: request.leaveType.name,
  });

  return updatedRequest;
}

/**
 * Cancel a leave request
 * Uses transaction to ensure atomicity when restoring balance
 */
export async function cancelLeaveRequest(
  requestId: string,
  userSlackId: string
): Promise<LeaveRequestWithDetails> {
  requestLogger.debug({ event: 'leave_request_cancelling', requestId, userSlackId });

  const user = await getUserBySlackIdOrThrow(userSlackId);

  const request = await prisma.leaveRequest.findUnique({
    where: { id: requestId },
    include: { leaveType: true },
  });

  if (!request) {
    throw new NotFoundError('LeaveRequest', requestId);
  }

  if (request.requesterId !== user.id) {
    requestLogger.warn({
      event: 'cancellation_failed_not_owner',
      requestId,
      requesterId: request.requesterId,
      attemptedBy: user.id,
    });
    throw new UnauthorizedError('cancel this request');
  }

  if (request.status === RequestStatus.CANCELLED) {
    throw new Error('This request is already cancelled');
  }

  // Validate: Cannot cancel past leave requests
  const today = startOfDay(new Date());
  const endDate = startOfDay(new Date(request.endDate));

  if (endDate < today) {
    requestLogger.warn({
      event: 'cancellation_failed_past_request',
      requestId,
      endDate: request.endDate,
      today,
    });
    throw new ValidationError('Cannot cancel leave requests that have already ended. Please contact your administrator if you need to make changes to past records.');
  }

  // Use transaction for atomicity when restoring balance
  const updatedRequest = await prisma.$transaction(async (tx) => {
    // Only restore balance for future leave requests
    // If the leave period has already started or is in the past, don't restore balance
    const startDate = startOfDay(new Date(request.startDate));
    const shouldRestoreBalance = startDate > today &&
      request.status === RequestStatus.APPROVED &&
      request.leaveType.affectsBalance;

    if (shouldRestoreBalance) {
      await updateLeaveBalance(tx, request.requesterId, request.leaveTypeId, -request.totalDays);
      requestLogger.debug({
        event: 'balance_restored',
        requestId,
        restoredDays: request.totalDays,
      });
    } else if (request.status === RequestStatus.APPROVED && request.leaveType.affectsBalance) {
      requestLogger.info({
        event: 'balance_not_restored',
        requestId,
        reason: 'past_or_in_progress',
        startDate: request.startDate,
        endDate: request.endDate,
      });
    }

    return tx.leaveRequest.update({
      where: { id: requestId },
      data: {
        status: RequestStatus.CANCELLED,
      },
      include: leaveRequestInclude,
    });
  });

  requestLogger.info({
    event: 'leave_request_cancelled',
    requestId,
    userId: user.id,
    previousStatus: request.status,
    leaveType: request.leaveType.name,
  });

  return updatedRequest;
}

/**
 * Get leave request by ID
 */
export async function getLeaveRequestById(
  id: string
): Promise<LeaveRequestWithDetails | null> {
  return prisma.leaveRequest.findUnique({
    where: { id },
    include: leaveRequestInclude,
  });
}

/**
 * Get pending requests for approval by a specific user
 */
export async function getPendingRequestsForApprover(
  approverSlackId: string
): Promise<LeaveRequestWithDetails[]> {
  const approver = await prisma.user.findUnique({
    where: { slackId: approverSlackId },
    include: { managedTeams: true },
  });

  if (!approver) {
    return [];
  }

  // Build where clause based on approver's permissions
  const whereClause: Prisma.LeaveRequestWhereInput = {
    status: RequestStatus.PENDING,
  };

  if (!approver.isAdmin) {
    // Non-admins can only see requests from their team members
    const teamIds = approver.managedTeams.map((t) => t.id);
    whereClause.requester = {
      teamId: { in: teamIds },
    };
  }

  return prisma.leaveRequest.findMany({
    where: whereClause,
    include: leaveRequestInclude,
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Get user's leave requests
 */
export async function getUserLeaveRequests(
  userSlackId: string,
  options: {
    status?: RequestStatusType[];
    limit?: number;
    includeUpcoming?: boolean;
  } = {}
): Promise<LeaveRequestWithDetails[]> {
  const user = await prisma.user.findUnique({
    where: { slackId: userSlackId },
  });

  if (!user) {
    return [];
  }

  const whereClause: Prisma.LeaveRequestWhereInput = {
    requesterId: user.id,
  };

  if (options.status && options.status.length > 0) {
    whereClause.status = { in: options.status };
  }

  if (options.includeUpcoming) {
    whereClause.endDate = { gte: new Date() };
  }

  return prisma.leaveRequest.findMany({
    where: whereClause,
    include: leaveRequestInclude,
    orderBy: { startDate: 'desc' },
    take: options.limit,
  });
}

/**
 * Get who's out on a specific date
 * Uses start of day and end of day to ensure proper date comparison
 * Note: For optimal performance, ensure composite index exists on (status, startDate, endDate)
 */
export async function getWhosOut(
  date: Date = new Date()
): Promise<LeaveRequestWithDetails[]> {
  // Use start of day for the target date to ensure we catch all leaves
  const targetDate = startOfDay(date);
  const targetDateEnd = endOfDay(date);

  return prisma.leaveRequest.findMany({
    where: {
      status: RequestStatus.APPROVED,
      // A leave is active on this date if:
      // startDate <= endOfDay(date) AND endDate >= startOfDay(date)
      startDate: { lte: targetDateEnd },
      endDate: { gte: targetDate },
    },
    include: leaveRequestInclude,
    orderBy: { requester: { displayName: 'asc' } },
  });
}

/**
 * Get upcoming leaves (next N days)
 * Returns leaves that are active during the date range [today, today + days]
 * Note: For optimal performance, ensure composite index exists on (status, startDate, endDate)
 */
export async function getUpcomingLeaves(
  days = 7
): Promise<LeaveRequestWithDetails[]> {
  const todayStart = startOfDay(new Date());
  const rangeEnd = endOfDay(new Date());
  rangeEnd.setDate(rangeEnd.getDate() + days);

  return prisma.leaveRequest.findMany({
    where: {
      status: RequestStatus.APPROVED,
      // Leave overlaps with our range if:
      // startDate <= rangeEnd AND endDate >= todayStart
      startDate: { lte: rangeEnd },
      endDate: { gte: todayStart },
    },
    include: leaveRequestInclude,
    orderBy: { startDate: 'asc' },
  });
}

/**
 * Get all approved leave requests for a specific month (calendar view)
 */
export async function getLeaveRequestsForMonth(
  year: number,
  month: number // 0-indexed (0 = January)
): Promise<LeaveRequestWithDetails[]> {
  const monthStart = startOfDay(new Date(year, month, 1));
  const monthEnd = endOfDay(new Date(year, month + 1, 0)); // Last day of month

  return prisma.leaveRequest.findMany({
    where: {
      status: RequestStatus.APPROVED,
      // Leave overlaps with month if:
      // startDate <= monthEnd AND endDate >= monthStart
      startDate: { lte: monthEnd },
      endDate: { gte: monthStart },
    },
    include: leaveRequestInclude,
    orderBy: { startDate: 'asc' },
  });
}

/**
 * Get all leave requests (admin/manager view)
 */
export async function getAllLeaveRequests(options: {
  status?: RequestStatusType[];
  limit?: number;
} = {}): Promise<LeaveRequestWithDetails[]> {
  const whereClause: Prisma.LeaveRequestWhereInput = {};

  if (options.status && options.status.length > 0) {
    whereClause.status = { in: options.status };
  }

  return prisma.leaveRequest.findMany({
    where: whereClause,
    include: leaveRequestInclude,
    orderBy: { createdAt: 'desc' },
    take: options.limit,
  });
}

/**
 * Update a message reference for a leave request
 */
export async function updateRequestMessageRef(
  requestId: string,
  channelId: string,
  messageTs: string
): Promise<void> {
  await prisma.leaveRequest.update({
    where: { id: requestId },
    data: {
      slackChannelId: channelId,
      slackMessageTs: messageTs,
    },
  });
}
