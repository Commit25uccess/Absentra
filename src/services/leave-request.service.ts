import { prisma } from '../db/client';
import { calculateWorkingDays, getCurrentYear, formatDate } from '../utils/dates';
import { startOfDay, endOfDay } from 'date-fns';
import { getUserBySlackIdOrThrow } from './user.service';
import logger from '../utils/logger';
import type { LeaveRequest, LeaveType, User, Prisma } from '@prisma/client';

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
      allowance: 0,
      used: days,
    },
  });

  requestLogger.debug('Leave balance updated', {
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
  requestLogger.debug('Creating leave request', {
    requesterSlackId: input.requesterSlackId,
    leaveTypeId: input.leaveTypeId,
    startDate: formatDate(input.startDate),
    endDate: formatDate(input.endDate),
  });

  const user = await getUserBySlackIdOrThrow(input.requesterSlackId);

  const leaveType = await prisma.leaveType.findUnique({
    where: { id: input.leaveTypeId },
  });

  if (!leaveType) {
    requestLogger.warn('Leave request failed: leave type not found', {
      leaveTypeId: input.leaveTypeId,
    });
    throw new Error('Leave type not found');
  }

  // Calculate total working days
  const totalDays = await calculateWorkingDays(
    input.startDate,
    input.endDate,
    input.isHalfDay
  );

  // Check for overlapping requests
  const overlapping = await prisma.leaveRequest.findFirst({
    where: {
      requesterId: user.id,
      status: { in: ['PENDING', 'APPROVED'] },
      OR: [
        {
          startDate: { lte: input.endDate },
          endDate: { gte: input.startDate },
        },
      ],
    },
  });

  if (overlapping) {
    requestLogger.warn('Leave request failed: overlapping dates', {
      userId: user.id,
      existingRequestId: overlapping.id,
    });
    throw new Error('You already have a leave request for these dates');
  }

  // Determine initial status
  const settings = await prisma.settings.findUnique({ where: { id: 'default' } });
  const requiresApproval = settings?.requireApproval && leaveType.requiresApproval;
  const initialStatus = requiresApproval ? RequestStatus.PENDING : RequestStatus.APPROVED;

  // Use transaction for atomicity when auto-approved
  const request = await prisma.$transaction(async (tx) => {
    const created = await tx.leaveRequest.create({
      data: {
        requesterId: user.id,
        leaveTypeId: input.leaveTypeId,
        startDate: input.startDate,
        endDate: input.endDate,
        isHalfDay: input.isHalfDay ?? false,
        halfDayPeriod: input.halfDayPeriod,
        totalDays,
        reason: input.reason,
        teamNotes: input.teamNotes,
        status: initialStatus,
        approvedAt: initialStatus === RequestStatus.APPROVED ? new Date() : null,
      },
      include: leaveRequestInclude,
    });

    // If auto-approved, update balance within same transaction
    if (initialStatus === RequestStatus.APPROVED && leaveType.affectsBalance) {
      await updateLeaveBalance(tx, user.id, input.leaveTypeId, totalDays);
    }

    return created;
  });

  requestLogger.info('Leave request created', {
    requestId: request.id,
    userId: user.id,
    leaveType: leaveType.name,
    totalDays,
    status: initialStatus,
  });

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
  requestLogger.debug('Approving leave request', { requestId, approverSlackId });

  const approver = await getUserBySlackIdOrThrow(approverSlackId);

  const request = await prisma.leaveRequest.findUnique({
    where: { id: requestId },
    include: { leaveType: true, requester: true },
  });

  if (!request) {
    throw new Error('Leave request not found');
  }

  if (request.status !== RequestStatus.PENDING) {
    requestLogger.warn('Approval failed: request already processed', {
      requestId,
      currentStatus: request.status,
    });
    throw new Error('This request has already been processed');
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
      await updateLeaveBalance(tx, request.requesterId, request.leaveTypeId, request.totalDays);
    }

    return updated;
  });

  requestLogger.info('Leave request approved', {
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
  requestLogger.debug('Rejecting leave request', { requestId, approverSlackId });

  const approver = await getUserBySlackIdOrThrow(approverSlackId);

  const request = await prisma.leaveRequest.findUnique({
    where: { id: requestId },
    include: { leaveType: true, requester: true },
  });

  if (!request) {
    throw new Error('Leave request not found');
  }

  if (request.status !== RequestStatus.PENDING) {
    requestLogger.warn('Rejection failed: request already processed', {
      requestId,
      currentStatus: request.status,
    });
    throw new Error('This request has already been processed');
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

  requestLogger.info('Leave request rejected', {
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
  requestLogger.debug('Cancelling leave request', { requestId, userSlackId });

  const user = await getUserBySlackIdOrThrow(userSlackId);

  const request = await prisma.leaveRequest.findUnique({
    where: { id: requestId },
    include: { leaveType: true },
  });

  if (!request) {
    throw new Error('Leave request not found');
  }

  if (request.requesterId !== user.id) {
    requestLogger.warn('Cancellation failed: not owner', {
      requestId,
      requesterId: request.requesterId,
      attemptedBy: user.id,
    });
    throw new Error('You can only cancel your own requests');
  }

  if (request.status === RequestStatus.CANCELLED) {
    throw new Error('This request is already cancelled');
  }

  // Use transaction for atomicity when restoring balance
  const updatedRequest = await prisma.$transaction(async (tx) => {
    // If was approved and affects balance, restore the balance
    if (
      request.status === RequestStatus.APPROVED &&
      request.leaveType.affectsBalance
    ) {
      await updateLeaveBalance(tx, request.requesterId, request.leaveTypeId, -request.totalDays);
      requestLogger.debug('Balance restored for cancelled request', {
        requestId,
        restoredDays: request.totalDays,
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

  requestLogger.info('Leave request cancelled', {
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
