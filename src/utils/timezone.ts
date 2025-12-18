import { toZonedTime, fromZonedTime, formatInTimeZone } from 'date-fns-tz';
import { startOfDay, endOfDay } from 'date-fns';
import { prisma } from '../db/client';
import { appCache, CACHE_TTL } from './cache';
import { config } from '../config';

/**
 * Get the workspace timezone from settings (cached)
 */
export async function getWorkspaceTimezone(): Promise<string> {
  return appCache.getOrSet(
    'workspace:timezone',
    async () => {
      const settings = await prisma.settings.findUnique({
        where: { id: 'default' },
        select: { timezone: true },
      });
      return settings?.timezone || config.app.timezone || 'UTC';
    },
    CACHE_TTL.SETTINGS
  );
}

/**
 * Invalidate the timezone cache (call when settings are updated)
 */
export function invalidateTimezoneCache(): void {
  appCache.invalidate('workspace:timezone');
}

/**
 * Get "now" in the workspace timezone
 */
export async function getNowInWorkspaceTimezone(): Promise<Date> {
  const tz = await getWorkspaceTimezone();
  return toZonedTime(new Date(), tz);
}

/**
 * Get today's date at start of day in workspace timezone
 */
export async function getTodayInWorkspaceTimezone(): Promise<Date> {
  const tz = await getWorkspaceTimezone();
  const nowInTz = toZonedTime(new Date(), tz);
  return startOfDay(nowInTz);
}

/**
 * Get the current year in workspace timezone
 */
export async function getCurrentYearInTimezone(): Promise<number> {
  const today = await getTodayInWorkspaceTimezone();
  return today.getFullYear();
}

/**
 * Convert a UTC date to workspace timezone for display
 */
export async function toWorkspaceTime(date: Date): Promise<Date> {
  const tz = await getWorkspaceTimezone();
  return toZonedTime(date, tz);
}

/**
 * Convert a workspace timezone date to UTC for storage
 */
export async function toUTC(date: Date): Promise<Date> {
  const tz = await getWorkspaceTimezone();
  return fromZonedTime(date, tz);
}

/**
 * Format a date in workspace timezone
 */
export async function formatInWorkspaceTimezone(
  date: Date,
  formatStr: string
): Promise<string> {
  const tz = await getWorkspaceTimezone();
  return formatInTimeZone(date, tz, formatStr);
}

/**
 * Check if a time (in HH:mm format) has been reached in the workspace timezone
 * Used for scheduled jobs
 */
export async function isTimeInWorkspaceTimezone(hour: number, minute: number): Promise<boolean> {
  const tz = await getWorkspaceTimezone();
  const nowInTz = toZonedTime(new Date(), tz);
  return nowInTz.getHours() === hour && nowInTz.getMinutes() === minute;
}
