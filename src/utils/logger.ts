import winston from 'winston';
import fs from 'fs';
import path from 'path';
import { AsyncLocalStorage } from 'async_hooks';

const { combine, timestamp, printf, errors } = winston.format;

/* ------------------------------------------------------------------ */
/* Configuration                                                        */
/* ------------------------------------------------------------------ */
const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const APP_NAME = 'absentra';

/* ------------------------------------------------------------------ */
/* Request Context (for tracing requests across async operations)       */
/* ------------------------------------------------------------------ */
export interface RequestContext {
  requestId: string;
  userId?: string;
  type?: 'command' | 'action' | 'view' | 'event' | 'shortcut' | 'job';
  name?: string;
  startTime?: number;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return requestContext.run(context, fn);
}

export async function runWithContextAsync<T>(
  context: RequestContext,
  fn: () => Promise<T>
): Promise<T> {
  return requestContext.run(context, fn);
}

/* ------------------------------------------------------------------ */
/* Generate unique request ID                                           */
/* ------------------------------------------------------------------ */
export function generateRequestId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp}-${random}`;
}

/* ------------------------------------------------------------------ */
/* Ensure log directory exists                                          */
/* ------------------------------------------------------------------ */
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/* ------------------------------------------------------------------ */
/* Safe stringify helper (prevents crashes on circular objects)         */
/* ------------------------------------------------------------------ */
function safeStringify(obj: unknown, pretty = false): string {
  const seen = new WeakSet();
  try {
    return JSON.stringify(
      obj,
      (_key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
        }
        if (value instanceof Error) {
          return {
            message: value.message,
            name: value.name,
            stack: value.stack,
          };
        }
        return value;
      },
      pretty ? 2 : 0
    );
  } catch {
    return '[Unserializable]';
  }
}

/* ------------------------------------------------------------------ */
/* JSON format for structured logging (all output)                       */
/* ------------------------------------------------------------------ */
const structuredFormat = printf(({ level, timestamp, ...meta }) => {
  const ctx = getRequestContext();

  const logEntry: Record<string, unknown> = {
    timestamp,
    level: level.replace(/\u001b\[\d+m/g, ''), // Strip ANSI codes
  };

  // Add request context
  if (ctx) {
    logEntry.requestId = ctx.requestId;
    if (ctx.userId) logEntry.userId = ctx.userId;
    if (ctx.type) logEntry.type = ctx.type;
    if (ctx.name) logEntry.name = ctx.name;
    if (ctx.startTime) {
      logEntry.duration = Date.now() - ctx.startTime;
    }
  }

  // Add remaining metadata
  if (Object.keys(meta).length > 0) {
    // Handle error specially
    if (meta.error instanceof Error) {
      logEntry.error = {
        message: meta.error.message,
        name: meta.error.name,
        stack: meta.error.stack,
      };
      delete meta.error;
    }
    Object.assign(logEntry, meta);
  }

  return safeStringify(logEntry);
});

/* ------------------------------------------------------------------ */
/* Winston logger instance                                              */
/* ------------------------------------------------------------------ */
const winstonLogger = winston.createLogger({
  level: LOG_LEVEL,
  //defaultMeta: { label: APP_NAME },
  exitOnError: false,
  transports: [
    // Console transport with structured JSON format
    new winston.transports.Console({
      format: combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        errors({ stack: true }),
        structuredFormat
      ),
    }),
  ],
});

/* ------------------------------------------------------------------ */
/* File transports (production or when LOG_TO_FILE is set)              */
/* ------------------------------------------------------------------ */
if (IS_PRODUCTION || process.env.LOG_TO_FILE === 'true') {
  // Error log - errors only
  winstonLogger.add(
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
      format: combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        errors({ stack: true }),
        structuredFormat
      ),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 10,
      tailable: true,
    })
  );

  // Combined log - all levels
  winstonLogger.add(
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'combined.log'),
      format: combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        errors({ stack: true }),
        structuredFormat
      ),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 10,
      tailable: true,
    })
  );

  // Access log - request logs only (like HTTP access logs)
  winstonLogger.add(
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'access.log'),
      level: 'info',
      format: combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        structuredFormat
      ),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 10,
      tailable: true,
    })
  );
}

/* ------------------------------------------------------------------ */
/* Logger interface types                                               */
/* ------------------------------------------------------------------ */
type LogMeta = Record<string, unknown>;

interface AccessLogData {
  type: 'command' | 'action' | 'view' | 'event' | 'shortcut';
  name: string;
  userId: string;
  userName?: string;
  teamId?: string;
  channelId?: string;
  duration?: number;
  status: 'started' | 'completed' | 'failed';
  error?: string;
  meta?: LogMeta;
}

export interface Logger {
  debug(meta: LogMeta): void;
  info(meta: LogMeta): void;
  warn(meta: LogMeta): void;
  error(meta: LogMeta, error?: unknown): void;
  access(data: AccessLogData): void;
  slack(operation: string, meta?: LogMeta): void;
  job(jobName: string, status: 'started' | 'completed' | 'failed', meta?: LogMeta): void;
  child(childLabel: string): Logger;
}

/* ------------------------------------------------------------------ */
/* Public logger API                                                    */
/* ------------------------------------------------------------------ */
export const logger: Logger = {
  /* ---------------- Core logging methods ---------------- */

  debug(meta: LogMeta): void {
    winstonLogger.debug('', meta);
  },

  info(meta: LogMeta): void {
    winstonLogger.info('', meta);
  },

  warn(meta: LogMeta): void {
    winstonLogger.warn('', meta);
  },

  error(meta: LogMeta, error?: unknown): void {
    if (error instanceof Error) {
      winstonLogger.error('', { ...meta, error });
    } else if (error !== undefined && error !== null) {
      // If error is not an Error instance, include it in meta
      winstonLogger.error('', { ...meta, error });
    } else {
      winstonLogger.error('', meta);
    }
  },

  /* ---------------- Access logging (like HTTP logs) ---------------- */

  access(data: AccessLogData): void {
    const { type, name, userId, userName, teamId, channelId, duration, status, error, meta } = data;

    // Enhanced error handling: validate input data
    if (!type || !name || !userId || !status) {
      winstonLogger.error({
        event: 'validation_error',
        missingFields: { type: !type, name: !name, userId: !userId, status: !status },
        providedData: data
      });
      return;
    }

    // Validate duration is a number and non-negative
    if (duration !== undefined && (typeof duration !== 'number' || duration < 0)) {
      winstonLogger.warn({
        event: 'validation_warning',
        issue: 'invalid_duration',
        duration,
        userId,
        name
      });
      // Continue with undefined duration to prevent crashes
      (data as any).duration = undefined;
    }

    // Normalize status to valid values
    const normalizedStatus = status.toLowerCase();
    if (!['started', 'completed', 'failed'].includes(normalizedStatus)) {
      winstonLogger.warn({
        event: 'validation_warning',
        issue: 'invalid_status',
        status,
        userId,
        name,
        allowedStatuses: ['started', 'completed', 'failed']
      });
      (data as any).status = 'unknown';
    }

    // Enhanced error handling: sanitize inputs to prevent log injection
    const sanitizedType = String(type).replace(/[^\w-_]/g, '').substring(0, 20);
    const sanitizedName = String(name).replace(/[^\w-_]/g, '').substring(0, 50);
    const sanitizedUserId = String(userId).replace(/[^\w-_]/g, '').substring(0, 20);

    const logData: LogMeta = {
      event: 'access',
      type: sanitizedType,
      name: sanitizedName,
      userId: sanitizedUserId,
      status: data.status,
      userName: userName ? String(userName).substring(0, 100) : undefined, // Sanitize userName length
      duration: data.duration,
      ...meta,
    };

    if (teamId) logData.teamId = teamId;
    if (channelId) logData.channelId = channelId;

    // Enhanced error handling: wrap logging in try-catch to prevent crashes
    try {
      if (data.status === 'failed' && error) {
        logData.error = error;
        winstonLogger.error('', logData);
      } else if (data.status === 'completed') {
        winstonLogger.info('', logData);
      } else {
        winstonLogger.debug('', logData);
      }
    } catch (logError) {
      // Fallback logging if primary logging fails
      winstonLogger.error({
        event: 'logging_error',
        errorMessage: logError instanceof Error ? logError.message : String(logError),
        originalData: logData,
        fallback: true
      });
    }
  },

  /* ---------------- Domain-specific helpers ---------------- */

  slack(operation: string, meta?: LogMeta): void {
    winstonLogger.debug('', {
      event: 'slack_api',
      operation,
      ...meta
    });
  },

  job(jobName: string, status: 'started' | 'completed' | 'failed', meta?: LogMeta): void {
    const level = status === 'failed' ? 'error' : status === 'completed' ? 'info' : 'debug';
    winstonLogger[level]('', {
      event: 'job',
      jobName,
      status,
      ...meta,
    });
  },

  /* ---------------- Child logger with label ---------------- */

  child(childLabel: string): Logger {
    const childWinston = winstonLogger.child({ label: `${APP_NAME}:${childLabel}` });

    const childLogger: Logger = {
      debug: (meta: LogMeta) => childWinston.debug('', meta),
      info: (meta: LogMeta) => childWinston.info('', meta),
      warn: (meta: LogMeta) => childWinston.warn('', meta),
      error: (meta: LogMeta, error?: unknown) => {
        if (error instanceof Error) {
          childWinston.error('', { ...meta, error });
        } else if (error !== undefined && error !== null) {
          childWinston.error('', { ...meta, error });
        } else {
          childWinston.error('', meta);
        }
      },
      access: logger.access.bind(logger),
      slack: logger.slack.bind(logger),
      job: logger.job.bind(logger),
      child: (label: string) => logger.child(`${childLabel}:${label}`),
    };

    return childLogger;
  },
};

export default logger;
