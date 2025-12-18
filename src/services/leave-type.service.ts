import { prisma } from '../db/client';
import type { LeaveType } from '@prisma/client';
import { appCache, CACHE_KEYS, CACHE_TTL } from '../utils/cache';

/**
 * Get all active leave types (cached)
 */
export async function getAllLeaveTypes(): Promise<LeaveType[]> {
  return appCache.getOrSet(
    CACHE_KEYS.LEAVE_TYPES,
    () => prisma.leaveType.findMany({
      where: { isActive: true },
      orderBy: { order: 'asc' },
    }),
    CACHE_TTL.LEAVE_TYPES
  );
}

/**
 * Get all leave types including inactive ones (for admin)
 */
export async function getAllLeaveTypesIncludingInactive(): Promise<LeaveType[]> {
  return prisma.leaveType.findMany({
    orderBy: { order: 'asc' },
  });
}

/**
 * Invalidate leave types cache (call when leave types are modified)
 */
export function invalidateLeaveTypesCache(): void {
  appCache.invalidatePrefix('leave_types:');
}

/**
 * Get a leave type by ID
 */
export async function getLeaveTypeById(id: string): Promise<LeaveType | null> {
  return prisma.leaveType.findUnique({
    where: { id },
  });
}

/**
 * Get a leave type by name
 */
export async function getLeaveTypeByName(name: string): Promise<LeaveType | null> {
  return prisma.leaveType.findUnique({
    where: { name },
  });
}

/**
 * Create a new leave type
 */
export async function createLeaveType(data: {
  name: string;
  emoji?: string;
  color?: string;
  defaultAllowance?: number | null;
  requiresApproval?: boolean;
  affectsBalance?: boolean;
  reminderEnabled?: boolean;
  reminderHour?: number;
  reminderMinute?: number;
  reminderWeekdaysOnly?: boolean;
  preLeaveReminderEnabled?: boolean;
  midLeaveReminderEnabled?: boolean;
  customReminderMessage?: string | null;
}): Promise<LeaveType> {
  // Get the max order value
  const maxOrder = await prisma.leaveType.aggregate({
    _max: { order: true },
  });

  const leaveType = await prisma.leaveType.create({
    data: {
      name: data.name,
      emoji: data.emoji ?? '📅',
      color: data.color ?? '#4A90A4',
      defaultAllowance: data.defaultAllowance,
      requiresApproval: data.requiresApproval ?? true,
      affectsBalance: data.affectsBalance ?? true,
      reminderEnabled: data.reminderEnabled ?? true,
      reminderHour: data.reminderHour ?? 9,
      reminderMinute: data.reminderMinute ?? 0,
      reminderWeekdaysOnly: data.reminderWeekdaysOnly ?? true,
      preLeaveReminderEnabled: data.preLeaveReminderEnabled ?? true,
      midLeaveReminderEnabled: data.midLeaveReminderEnabled ?? true,
      customReminderMessage: data.customReminderMessage,
      order: (maxOrder._max.order ?? 0) + 1,
    },
  });

  invalidateLeaveTypesCache();

  return leaveType;
}

/**
 * Update a leave type
 */
export async function updateLeaveType(
  id: string,
  data: {
    name?: string;
    emoji?: string;
    color?: string;
    defaultAllowance?: number | null;
    requiresApproval?: boolean;
    affectsBalance?: boolean;
    isActive?: boolean;
    reminderEnabled?: boolean;
    reminderHour?: number;
    reminderMinute?: number;
    reminderWeekdaysOnly?: boolean;
    preLeaveReminderEnabled?: boolean;
    midLeaveReminderEnabled?: boolean;
    customReminderMessage?: string | null;
  }
): Promise<LeaveType> {
  const leaveType = await prisma.leaveType.update({
    where: { id },
    data,
  });

  invalidateLeaveTypesCache();

  return leaveType;
}

/**
 * Deactivate a leave type (soft delete)
 */
export async function deactivateLeaveType(id: string): Promise<LeaveType> {
  const leaveType = await prisma.leaveType.update({
    where: { id },
    data: { isActive: false },
  });

  invalidateLeaveTypesCache();

  return leaveType;
}

/**
 * Reorder leave types
 */
export async function reorderLeaveTypes(
  orderedIds: string[]
): Promise<LeaveType[]> {
  const updates = orderedIds.map((id, index) =>
    prisma.leaveType.update({
      where: { id },
      data: { order: index + 1 },
    })
  );

  await prisma.$transaction(updates);
  invalidateLeaveTypesCache();

  return getAllLeaveTypes();
}
