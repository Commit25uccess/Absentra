import {
  format,
  parseISO,
  eachDayOfInterval,
  isWeekend,
  isSameDay,
  startOfDay,
  endOfDay,
  addDays,
  isWithinInterval,
} from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { prisma } from '../db/client';
import { formatInWorkspaceTimezone } from './timezone';

/**
 * Format a date for display in workspace timezone
 */
export async function formatDate(date: Date | string, formatStr = 'MMM d, yyyy'): Promise<string> {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return formatInWorkspaceTimezone(d, formatStr);
}

/**
 * Format a date range for display in workspace timezone
 */
export async function formatDateRange(startDate: Date, endDate: Date): Promise<string> {
  if (isSameDay(startDate, endDate)) {
    return await formatDate(startDate);
  }
  return `${await formatDate(startDate)} - ${await formatDate(endDate)}`;
}

/**
 * Calculate number of working days between two dates
 * Excludes weekends and public holidays
 */
export async function calculateWorkingDays(
  startDate: Date,
  endDate: Date,
  isHalfDay = false
): Promise<number> {
  const start = startOfDay(startDate);
  const end = startOfDay(endDate);

  // Get all days in range
  const allDays = eachDayOfInterval({ start, end });

  // Get public holidays in this date range
  const holidays = await prisma.publicHoliday.findMany({
    where: {
      date: {
        gte: start,
        lte: endOfDay(end),
      },
    },
  });

  const holidayDates = holidays.map((h: { date: Date }) => startOfDay(h.date));

  // Filter out weekends and holidays
  const workingDays = allDays.filter((day) => {
    if (isWeekend(day)) return false;
    if (holidayDates.some((h: Date) => isSameDay(h, day))) return false;
    return true;
  });

  const totalDays = workingDays.length;

  // If it's a half day, subtract 0.5
  return isHalfDay ? Math.max(0.5, totalDays - 0.5) : totalDays;
}

/**
 * Parse a date string from Slack date picker (YYYY-MM-DD format)
 */
export function parseSlackDate(dateString: string): Date {
  return parseISO(dateString);
}

/**
 * Format a date for Slack date picker (YYYY-MM-DD format)
 */
export function toSlackDateFormat(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

/**
 * Get today's date at start of day (synchronous, uses system timezone)
 * For timezone-aware operations, use getTodayInWorkspaceTimezone instead
 */
export function getToday(): Date {
  return startOfDay(new Date());
}

/**
 * Get a human-readable relative date string in workspace timezone
 */
export async function getRelativeDateLabel(date: Date): Promise<string> {
  const today = getToday();
  const tomorrow = addDays(today, 1);

  if (isSameDay(date, today)) {
    return 'Today';
  }
  if (isSameDay(date, tomorrow)) {
    return 'Tomorrow';
  }
  return await formatDate(date, 'EEEE, MMM d');
}

/**
 * Check if a date range overlaps with today
 */
export function isCurrentlyOnLeave(startDate: Date, endDate: Date): boolean {
  const today = getToday();
  return isWithinInterval(today, {
    start: startOfDay(startDate),
    end: endOfDay(endDate),
  });
}

/**
 * Get the current year (synchronous, uses system timezone)
 * For timezone-aware operations, use getCurrentYearInTimezone instead
 */
export function getCurrentYear(): number {
  return new Date().getFullYear();
}

/**
 * Check if a date is a weekday (Monday-Friday)
 */
export function isWeekday(date: Date): boolean {
  const day = date.getDay();
  return day >= 1 && day <= 5; // 1 = Monday, 5 = Friday
}

/**
 * Check if a date is within a specific timezone
 */
export function isInTimezone(date: Date, timezone: string): boolean {
  try {
    const zonedDate = toZonedTime(date, timezone);
    return zonedDate.getTime() === date.getTime();
  } catch {
    return false;
  }
}
