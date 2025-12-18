import winston from 'winston';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { AsyncLocalStorage } from 'async_hooks';

const { combine, timestamp, printf, colorize, errors } = winston.format;

/* ------------------------------------------------------------------ */
/* Configuration                                                        */
/* ------------------------------------------------------------------ */
const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_LEVEL = config.app.logLevel || 'info';
const IS_PRODUCTION = config.app.nodeEnv === 'production';
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
/* Custom format for human-readable console output                      */
/* ------------------------------------------------------------------ */
const consoleFormat = printf(({ level, message, timestamp, label: lbl, ...meta }) => {
  // Get request context for tracing
  const ctx = getRequestContext();

  // Build the base log line
  let line = `[${timestamp}]`;

  // Add label if present
  if (lbl) {
    line += ` [${lbl}]`;
  }

  // Add level
  line += ` [${level}]`;

  // Add request ID if in context
  if (ctx?.requestId) {
    line += ` [${ctx.requestId}]`;
  }

  // Add message
  line += ` ${message}`;

  // Add metadata if present (excluding internal fields)
  const cleanMeta = { ...meta };
  delete cleanMeta.error; // Handle error separately

  if (Object.keys(cleanMeta).length > 0) {
    line += ` ${safeStringify(cleanMeta)}`;
  }

  // Add error details on new line if present
  if (meta.error) {
    const err = meta.error;
    if (err instanceof Error) {
      line += `\n  Error: ${err.message}`;
      if (err.stack) {
        const stackLines = err.stack.split('\n').slice(1, 4);
        line += '\n  ' + stackLines.join('\n  ');
      }
    } else if (typeof err === 'object') {
      line += `\n  Error: ${safeStringify(err)}`;
    } else {
      line += `\n  Error: ${err}`;
    }
  }

  return line;
});

/* ------------------------------------------------------------------ */
/* JSON format for structured logging (production/file output)          */
/* ------------------------------------------------------------------ */
const structuredFormat = printf(({ level, message, timestamp, label: lbl, ...meta }) => {
  const ctx = getRequestContext();

  const logEntry: Record<string, unknown> = {
    timestamp,
    level: level.replace(/\u001b\[\d+m/g, ''), // Strip ANSI codes
    label: lbl || APP_NAME,
    message,
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
    // Console transport with colors for development
    new winston.transports.Console({
      format: combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        errors({ stack: true }),
        colorize({ level: true }), // Only colorize the level, not the whole message
        consoleFormat
      ),
    }),
  ],
});

/* ------------------------------------------------------------------ */
/* File transports (production or when LOG_TO_FILE is set)              */
/* ------------------------------------------------------------------ */
if (IS_PRODUCTION || config.app.logToFile === 'true') {
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
  teamId?: string;
  channelId?: string;
  duration?: number;
  status: 'started' | 'completed' | 'failed';
  error?: string;
  meta?: LogMeta;
}

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, error?: unknown, meta?: LogMeta): void;
  access(data: AccessLogData): void;
  action(actionId: string, userId: string, meta?: LogMeta): void;
  view(viewId: string, userId: string, meta?: LogMeta): void;
  request(
    action: 'created' | 'approved' | 'rejected' | 'cancelled',
    requestId: string,
    userId: string,
    meta?: LogMeta
  ): void;
  slack(operation: string, meta?: LogMeta): void;
  job(jobName: string, status: 'started' | 'completed' | 'failed', meta?: LogMeta): void;
  child(childLabel: string): Logger;
}

/* ------------------------------------------------------------------ */
/* Public logger API                                                    */
/* ------------------------------------------------------------------ */
export const logger: Logger = {
  /* ---------------- Core logging methods ---------------- */

  debug(message: string, meta?: LogMeta): void {
    winstonLogger.debug(message, meta);
  },

  info(message: string, meta?: LogMeta): void {
    winstonLogger.info(message, meta);
  },

  warn(message: string, meta?: LogMeta): void {
    winstonLogger.warn(message, meta);
  },

  error(message: string, error?: unknown, meta?: LogMeta): void {
    if (error instanceof Error) {
      winstonLogger.error(message, { error, ...meta });
    } else if (error !== undefined && error !== null) {
      // If error is not an Error instance, include it in meta
      winstonLogger.error(message, { error, ...meta });
    } else {
      winstonLogger.error(message, meta);
    }
  },

  /* ---------------- Access logging (like HTTP logs) ---------------- */

  access(data: AccessLogData): void {
    const { type, name, userId, teamId, channelId, duration, status, error, meta } = data;

    // Format like HTTP access log: TYPE NAME USER STATUS DURATION
    const durationStr = duration !== undefined ? `${duration}ms` : '-';
    const message = `${type.toUpperCase()} ${name} ${status}`;

    const logData: LogMeta = {
      type,
      name,
      userId,
      status,
      duration,
      ...meta,
    };

    if (teamId) logData.teamId = teamId;
    if (channelId) logData.channelId = channelId;

    if (status === 'failed' && error) {
      logData.error = error;
      winstonLogger.error(message, logData);
    } else if (status === 'completed') {
      winstonLogger.info(message, logData);
    } else {
      winstonLogger.debug(message, logData);
    }
  },

  /* ---------------- Domain-specific helpers ---------------- */

  action(actionId: string, userId: string, meta?: LogMeta): void {
    winstonLogger.info(`Action: ${actionId}`, {
      type: 'action',
      actionId,
      userId,
      ...meta
    });
  },

  view(viewId: string, userId: string, meta?: LogMeta): void {
    winstonLogger.info(`View: ${viewId}`, {
      type: 'view',
      viewId,
      userId,
      ...meta
    });
  },

  request(
    action: 'created' | 'approved' | 'rejected' | 'cancelled',
    requestId: string,
    userId: string,
    meta?: LogMeta
  ): void {
    winstonLogger.info(`Leave request ${action}`, {
      type: 'leave_request',
      action,
      requestId,
      userId,
      ...meta,
    });
  },

  slack(operation: string, meta?: LogMeta): void {
    winstonLogger.debug(`Slack: ${operation}`, {
      type: 'slack_api',
      operation,
      ...meta
    });
  },

  job(jobName: string, status: 'started' | 'completed' | 'failed', meta?: LogMeta): void {
    const level = status === 'failed' ? 'error' : status === 'completed' ? 'info' : 'debug';
    winstonLogger[level](`Job: ${jobName} ${status}`, {
      type: 'job',
      jobName,
      status,
      ...meta,
    });
  },

  /* ---------------- Child logger with label ---------------- */

  child(childLabel: string): Logger {
    const childWinston = winstonLogger.child({ label: `${APP_NAME}:${childLabel}` });

    const childLogger: Logger = {
      debug: (message: string, meta?: LogMeta) => childWinston.debug(message, meta),
      info: (message: string, meta?: LogMeta) => childWinston.info(message, meta),
      warn: (message: string, meta?: LogMeta) => childWinston.warn(message, meta),
      error: (message: string, error?: unknown, meta?: LogMeta) => {
        if (error instanceof Error) {
          childWinston.error(message, { error, ...meta });
        } else if (error !== undefined && error !== null) {
          childWinston.error(message, { error, ...meta });
        } else {
          childWinston.error(message, meta);
        }
      },
      access: logger.access.bind(logger),
      action: logger.action.bind(logger),
      view: logger.view.bind(logger),
      request: logger.request.bind(logger),
      slack: logger.slack.bind(logger),
      job: logger.job.bind(logger),
      child: (label: string) => logger.child(`${childLabel}:${label}`),
    };

    return childLogger;
  },
};

export default logger;
