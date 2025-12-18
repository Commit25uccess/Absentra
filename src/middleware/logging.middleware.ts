import type {
  App,
  Middleware,
  AnyMiddlewareArgs,
} from '@slack/bolt';
import logger, {
  generateRequestId,
  runWithContextAsync,
  RequestContext,
} from '../utils/logger';
import { prisma } from '../db/client';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */
type RequestType = 'command' | 'action' | 'view' | 'event' | 'shortcut';

interface RequestInfo {
  type: RequestType;
  name: string;
  userId: string;
  teamId?: string;
  channelId?: string;
}

/* ------------------------------------------------------------------ */
/* Extract request info from different Slack payload types              */
/* ------------------------------------------------------------------ */
function extractRequestInfo(args: AnyMiddlewareArgs): RequestInfo | null {
  const { body } = args;

  // Command
  if ('command' in args && args.command) {
    const cmd = args.command;
    return {
      type: 'command',
      name: cmd.command,
      userId: cmd.user_id,
      teamId: cmd.team_id,
      channelId: cmd.channel_id,
    };
  }

  // Action
  if ('action' in args && args.action) {
    const action = args.action as any;
    const actionBody = body as any;
    return {
      type: 'action',
      name: action.action_id || action.callback_id || 'unknown_action',
      userId: actionBody.user?.id || 'unknown',
      teamId: actionBody.team?.id,
      channelId: actionBody.channel?.id,
    };
  }

  // View submission/closed
  if ('view' in args && args.view) {
    const viewBody = body as any;
    return {
      type: 'view',
      name: args.view.callback_id || 'unknown_view',
      userId: viewBody.user?.id || 'unknown',
      teamId: viewBody.team?.id,
    };
  }

  // Event
  if ('event' in args && args.event) {
    const event = args.event as any;
    const eventBody = body as any;
    return {
      type: 'event',
      name: event.type || 'unknown_event',
      userId: event.user || eventBody.event?.user || 'system',
      teamId: eventBody.team_id,
      channelId: event.channel,
    };
  }

  // Shortcut
  if ('shortcut' in args && args.shortcut) {
    const shortcut = args.shortcut as any;
    const shortcutBody = body as any;
    return {
      type: 'shortcut',
      name: shortcut.callback_id || 'unknown_shortcut',
      userId: shortcutBody.user?.id || 'unknown',
      teamId: shortcutBody.team?.id,
    };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Fetch user display name from database (with caching)                  */
/* ------------------------------------------------------------------ */
const userNameCache = new Map<string, { name: string; expires: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getUserName(userId: string): Promise<string | undefined> {
  // Check cache first
  const cached = userNameCache.get(userId);
  if (cached && cached.expires > Date.now()) {
    return cached.name;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { slackId: userId },
      select: { displayName: true },
    });

    if (user?.displayName) {
      userNameCache.set(userId, {
        name: user.displayName,
        expires: Date.now() + CACHE_TTL,
      });
      return user.displayName;
    }
  } catch {
    // Ignore errors, just return undefined
  }

  return undefined;
}

/* ------------------------------------------------------------------ */
/* Create logging middleware for any Slack request type                 */
/* ------------------------------------------------------------------ */
function createLoggingMiddleware<T extends AnyMiddlewareArgs>(): Middleware<T> {
  return async (args) => {
    const { next } = args;
    const startTime = Date.now();
    const requestId = generateRequestId();
    const requestInfo = extractRequestInfo(args);

    if (!requestInfo) {
      // If we can't extract info, just pass through
      await next();
      return;
    }

    // Fetch userName from database (non-blocking for started log)
    const userNamePromise = getUserName(requestInfo.userId);

    const context: RequestContext = {
      requestId,
      userId: requestInfo.userId,
      type: requestInfo.type,
      name: requestInfo.name,
      startTime,
    };

    try {
      // Run the handler within the request context
      await runWithContextAsync(context, async () => {
        await next();
      });

      // Log successful completion with userName
      const duration = Date.now() - startTime;
      const userName = await userNamePromise;
      logger.access({
        type: requestInfo.type,
        name: requestInfo.name,
        userId: requestInfo.userId,
        status: 'completed',
        userName,
        duration,
        teamId: requestInfo.teamId,
        channelId: requestInfo.channelId,
      });
    } catch (error) {
      // Log failure with userName
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const userName = await userNamePromise;

      logger.access({
        type: requestInfo.type,
        name: requestInfo.name,
        userId: requestInfo.userId,
        status: 'failed',
        userName,
        duration,
        teamId: requestInfo.teamId,
        channelId: requestInfo.channelId,
        error: errorMessage,
      });

      // Re-throw to let Bolt handle it
      throw error;
    }
  };
}

/* ------------------------------------------------------------------ */
/* Register global logging middleware on the app                        */
/* ------------------------------------------------------------------ */
export function registerLoggingMiddleware(app: App): void {
  // Use global middleware that applies to all requests
  app.use(createLoggingMiddleware());

  logger.info({ event: 'logging_middleware_registered' });
}

/* ------------------------------------------------------------------ */
/* Export individual middleware for specific use cases                  */
/* ------------------------------------------------------------------ */
export const loggingMiddleware = createLoggingMiddleware();
