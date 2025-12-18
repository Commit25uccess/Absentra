/**
 * Base application error with structured code for better error handling and logging.
 * Extends Error for stack traces and serialization.
 */
export class AppError extends Error {
  readonly code: string;
  readonly isOperational: boolean = true;

  constructor(message: string, code: string, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    if (cause) {
      this.cause = cause;
    }
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Resource not found error.
 */
export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super(
      id ? `${resource} not found: ${id}` : `${resource} not found`,
      'NOT_FOUND'
    );
  }
}

/**
 * Validation or business rule violation.
 */
export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
  }
}

/**
 * Insufficient balance for leave request.
 */
export class InsufficientBalanceError extends AppError {
  constructor(remaining: number, required: number) {
    super(
      `Insufficient balance. You have ${remaining} days remaining, but this request needs ${required} working days.`,
      'INSUFFICIENT_BALANCE',
      { remaining, required }
    );
  }
}

/**
 * Request already processed (approved/rejected/cancelled).
 */
export class AlreadyProcessedError extends AppError {
  constructor(currentStatus: string) {
    super(
      `This request has already been processed (${currentStatus})`,
      'ALREADY_PROCESSED'
    );
  }
}

/**
 * Overlapping leave request.
 */
export class OverlappingRequestError extends AppError {
  constructor() {
    super('You already have a leave request for these dates', 'OVERLAPPING_REQUEST');
  }
}

/**
 * Unauthorized action (e.g., cancel own only).
 */
export class UnauthorizedError extends AppError {
  constructor(action: string) {
    super(`Unauthorized to ${action}`, 'UNAUTHORIZED');
  }
}

/**
 * Generic conflict error.
 */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 'CONFLICT');
  }
}
