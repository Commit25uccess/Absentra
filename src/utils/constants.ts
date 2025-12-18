/**
 * Application-wide constants
 */

// Pagination
export const PAGINATION = {
  DEFAULT_PAGE_SIZE: 10,
  REQUESTS_PAGE_SIZE: 10,
  BALANCES_PAGE_SIZE: 10,
  USER_REQUESTS_LIMIT: 15,
  ALL_REQUESTS_LIMIT: 100,
  MAX_PREVIEW_ITEMS: 5,
} as const;

// Time periods (in days)
export const TIME_PERIODS = {
  UPCOMING_DAYS: 7,
  UPCOMING_EXTENDED_DAYS: 14,
} as const;

// Request status
export const REQUEST_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
} as const;

export type RequestStatusType = typeof REQUEST_STATUS[keyof typeof REQUEST_STATUS];

// Error messages
export const ERROR_MESSAGES = {
  NOT_AUTHORIZED: '⚠️ You are not authorized to perform this action.',
  NOT_ADMIN: '⚠️ You need to be an admin to perform this action.',
  NOT_MANAGER: '⚠️ You need to be a manager to perform this action.',
  REQUEST_NOT_FOUND: '⚠️ This request no longer exists or has been deleted.',
  REQUEST_ALREADY_APPROVED: '✅ This request has already been approved.',
  REQUEST_ALREADY_REJECTED: '❌ This request has already been rejected.',
  REQUEST_CANCELLED: '🚫 This request has been cancelled.',
  USER_NOT_FOUND: '⚠️ User not found.',
  EXPIRED_TRIGGER: '⏰ This action has expired. Please try again.',
} as const;

// Success messages
export const SUCCESS_MESSAGES = {
  REQUEST_APPROVED: '✅ Leave request approved successfully!',
  REQUEST_REJECTED: '❌ Leave request rejected.',
  REQUEST_CANCELLED: '✅ Leave request cancelled.',
} as const;

// Balance thresholds
export const BALANCE_THRESHOLDS = {
  LOW: 3,
  NONE: 0,
} as const;

// Balance indicator emojis
export const BALANCE_INDICATORS = {
  GOOD: '🟢',
  LOW: '🟡',
  NONE: '🔴',
} as const;

// Default reminder messages
export const DEFAULT_REMINDER_MESSAGES = {
  BEFORE_LEAVE: (leaveType: string) => 
    `📅 Reminder: Your ${leaveType} leave starts tomorrow. Please ensure your work is handed over and any preparations are complete.`,
  DURING_LEAVE: (leaveType: string) => 
    `🌴 Checking in during your ${leaveType} leave. Hope you're having a restful time!`,
} as const;

/**
 * Get balance indicator emoji based on remaining days
 */
export function getBalanceIndicator(remaining: number): string {
  if (remaining <= BALANCE_THRESHOLDS.NONE) return BALANCE_INDICATORS.NONE;
  if (remaining <= BALANCE_THRESHOLDS.LOW) return BALANCE_INDICATORS.LOW;
  return BALANCE_INDICATORS.GOOD;
}

/**
 * Get status message for a request that's already been processed
 */
export function getRequestStatusMessage(status: string): string {
  switch (status) {
    case REQUEST_STATUS.APPROVED:
      return ERROR_MESSAGES.REQUEST_ALREADY_APPROVED;
    case REQUEST_STATUS.REJECTED:
      return ERROR_MESSAGES.REQUEST_ALREADY_REJECTED;
    case REQUEST_STATUS.CANCELLED:
      return ERROR_MESSAGES.REQUEST_CANCELLED;
    default:
      return ERROR_MESSAGES.REQUEST_NOT_FOUND;
  }
}
