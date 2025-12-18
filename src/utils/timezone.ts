import { toZonedTime, fromZonedTime, formatInTimeZone } from 'date-fns-tz';
import { startOfDay, isValid, parseISO } from 'date-fns';
import { prisma } from '../db/client';
import { appCache, CACHE_TTL } from './cache';
import { config } from '../config';
import logger from './logger';

const timezoneLogger = logger.child('timezone');

// List of valid IANA timezone identifiers for validation
const VALID_TIMEZONE_PATTERNS = [
  /^[A-Za-z_]+\/[A-Za-z_]+$/, // Standard IANA format: America/New_York
  /^[A-Za-z_]+$/, // Simple format: UTC, GMT
  /^[A-Za-z]+\/[A-Za-z_]+\/[A-Za-z_]+$/, // Complex format: America/Argentina/Buenos_Aires
];

/**
 * Validate a timezone string
 */
export function isValidTimezone(timezone: string): boolean {
  if (!timezone || typeof timezone !== 'string') {
    return false;
  }

  // Check against known patterns
  const isValidPattern = VALID_TIMEZONE_PATTERNS.some(pattern => pattern.test(timezone));
  
  if (!isValidPattern) {
    return false;
  }

  // Additional validation: check if timezone is supported by trying to use it
  try {
    const testDate = new Date();
    toZonedTime(testDate, timezone);
    return true;
  } catch (error) {
    timezoneLogger.warn({ event: 'timezone_invalid', timezone, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/**
 * Normalize timezone string (fallback to UTC if invalid)
 */
export function normalizeTimezone(timezone: string | null | undefined): string {
  if (!timezone) {
    timezoneLogger.debug({ event: 'timezone_empty', fallback: 'UTC' });
    return 'UTC';
  }

  const trimmed = timezone.trim();
  
  if (!isValidTimezone(trimmed)) {
    timezoneLogger.warn({
      event: 'timezone_invalid_fallback',
      originalTimezone: timezone,
      trimmed: trimmed,
      fallback: 'UTC',
    });
    return 'UTC';
  }

  return trimmed;
}

/**
 * Get the workspace timezone from settings (cached)
 */
export async function getWorkspaceTimezone(): Promise<string> {
  return appCache.getOrSet(
    'workspace:timezone',
    async () => {
      try {
        const settings = await prisma.settings.findUnique({
          where: { id: 'default' },
          select: { timezone: true },
        });
        
        const rawTimezone = settings?.timezone || config.app.timezone || 'UTC';
        const normalizedTimezone = normalizeTimezone(rawTimezone);
        
        // Log if timezone was normalized
        if (rawTimezone !== normalizedTimezone) {
          timezoneLogger.info({
            event: 'timezone_normalized',
            original: rawTimezone,
            normalized: normalizedTimezone,
            source: 'database',
          });
        }
        
        return normalizedTimezone;
      } catch (error) {
        timezoneLogger.error({ event: 'timezone_fetch_failed' }, error);
        return normalizeTimezone(config.app.timezone);
      }
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

/**
 * Safely parse a date string and convert to workspace timezone
 * Handles various input formats and validates the result
 */
export async function parseAndNormalizeDate(
  dateInput: string | Date | null | undefined,
  defaultTimezone?: string
): Promise<Date | null> {
  if (!dateInput) {
    timezoneLogger.debug({ event: 'date_input_empty' });
    return null;
  }

  // If already a Date, validate and convert
  if (dateInput instanceof Date) {
    if (!isValid(dateInput)) {
      timezoneLogger.warn({ event: 'date_invalid', date: dateInput.toString() });
      return null;
    }
    
    try {
      return await toWorkspaceTime(dateInput);
    } catch (error) {
      timezoneLogger.error({ event: 'date_convert_failed', date: dateInput.toString() }, error);
      return null;
    }
  }

  // Try parsing as ISO string first
  let parsedDate: Date;
  try {
    parsedDate = parseISO(dateInput);
    if (isValid(parsedDate)) {
      return await toWorkspaceTime(parsedDate);
    }
  } catch (error) {
    timezoneLogger.debug({ event: 'date_parse_iso_failed', input: dateInput });
  }

  // Try parsing as other common formats
  try {
    parsedDate = new Date(dateInput);
    if (isValid(parsedDate)) {
      return await toWorkspaceTime(parsedDate);
    }
  } catch (error) {
    timezoneLogger.debug({ event: 'date_parse_failed', input: dateInput });
  }

  timezoneLogger.error({
    event: 'date_parse_unable',
    input: dateInput,
    fallbackTimezone: defaultTimezone,
  });
  return null;
}

/**
 * Get timezone offset information for debugging
 */
export async function getTimezoneInfo(timezone?: string): Promise<{
  name: string;
  offset: string;
  isDST: boolean;
}> {
  const tz = timezone || await getWorkspaceTimezone();
  const now = new Date();
  
  try {
    const tzDate = toZonedTime(now, tz);
    const utcDate = new Date(now.toISOString());
    
    // Calculate offset in minutes
    const offsetMs = tzDate.getTime() - utcDate.getTime();
    const offsetMinutes = Math.round(offsetMs / (60 * 1000));
    const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
    const offsetMins = Math.abs(offsetMinutes) % 60;
    const offsetSign = offsetMinutes >= 0 ? '+' : '-';
    const offsetString = `${offsetSign}${offsetHours.toString().padStart(2, '0')}:${offsetMins.toString().padStart(2, '0')}`;
    
    // Check if DST is in effect (this is simplified, real DST detection is more complex)
    const isDST = tzDate.getTimezoneOffset() !== utcDate.getTimezoneOffset();
    
    return {
      name: tz,
      offset: offsetString,
      isDST,
    };
  } catch (error) {
    timezoneLogger.error({ event: 'timezone_info_failed', timezone: tz }, error);
    return {
      name: tz,
      offset: '+00:00',
      isDST: false,
    };
  }
}

/**
 * Validate date range in workspace timezone context
 */
export async function validateDateRange(
  startDate: Date,
  endDate: Date,
  allowPast: boolean = false
): Promise<{
  isValid: boolean;
  error?: string;
  normalizedDates?: { start: Date; end: Date };
}> {
  try {
    // Normalize dates to workspace timezone
    const normalizedStart = await toWorkspaceTime(startDate);
    const normalizedEnd = await toWorkspaceTime(endDate);
    
    if (!isValid(normalizedStart) || !isValid(normalizedEnd)) {
      return {
        isValid: false,
        error: 'Invalid date format',
      };
    }

    // Check if dates are in the past (if not allowed)
    if (!allowPast) {
      const today = await getTodayInWorkspaceTimezone();
      if (normalizedStart < today || normalizedEnd < today) {
        return {
          isValid: false,
          error: 'Dates cannot be in the past',
        };
      }
    }

    // Check date range logic
    if (normalizedEnd < normalizedStart) {
      return {
        isValid: false,
        error: 'End date must be on or after start date',
      };
    }

    // Check for reasonable date range (e.g., not more than 2 years in future)
    const maxFutureDate = new Date();
    maxFutureDate.setFullYear(maxFutureDate.getFullYear() + 2);
    if (normalizedStart > maxFutureDate) {
      return {
        isValid: false,
        error: 'Start date is too far in the future',
      };
    }

    return {
      isValid: true,
      normalizedDates: {
        start: normalizedStart,
        end: normalizedEnd,
      },
    };
  } catch (error) {
    timezoneLogger.error({ event: 'date_range_validation_failed' }, error);
    return {
      isValid: false,
      error: 'Date validation failed',
    };
  }
}
