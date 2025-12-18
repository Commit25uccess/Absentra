import logger from './logger';

const rateLimitLogger = logger.child('slack-rate-limiter');

/**
 * Slack API rate limit configuration
 */
interface RateLimitConfig {
  maxRetries: number;
  baseDelay: number; // Base delay in milliseconds
  maxDelay: number; // Maximum delay in milliseconds
  backoffMultiplier: number;
}

const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  maxRetries: 5,
  baseDelay: 1000, // 1 second
  maxDelay: 60000, // 1 minute
  backoffMultiplier: 2,
};

/**
 * Slack API error types
 */
interface SlackApiError extends Error {
  code?: string;
  response?: {
    status?: number;
    headers?: {
      'retry-after'?: string;
    };
    data?: {
      error?: string;
      error_description?: string;
    };
  };
}

/**
 * Check if an error is a rate limit error
 */
function isRateLimitError(error: unknown): error is SlackApiError {
  if (error && typeof error === 'object') {
    const slackError = error as SlackApiError;
    return (
      slackError.code === 'rate_limited' ||
      slackError.response?.status === 429 ||
      slackError.response?.data?.error === 'rate_limited'
    );
  }
  return false;
}

/**
 * Check if an error is a server error that should be retried
 */
function isRetryableServerError(error: unknown): error is SlackApiError {
  if (error && typeof error === 'object') {
    const slackError = error as SlackApiError;
    const status = slackError.response?.status;
    return status === 500 || status === 502 || status === 503 || status === 504;
  }
  return false;
}

/**
 * Get retry delay from error headers or calculate exponential backoff
 */
function getRetryDelay(error: SlackApiError, attempt: number, config: RateLimitConfig): number {
  // Check for Retry-After header (Slack's recommended retry time)
  const retryAfterHeader = error.response?.headers?.['retry-after'];
  if (retryAfterHeader) {
    const retryAfter = parseInt(retryAfterHeader, 10);
    if (!isNaN(retryAfter)) {
      return Math.min(retryAfter * 1000, config.maxDelay); // Convert to milliseconds
    }
  }

  // Use exponential backoff with jitter
  const exponentialDelay = config.baseDelay * Math.pow(config.backoffMultiplier, attempt - 1);
  const jitter = Math.random() * 0.1 * exponentialDelay; // Add 10% jitter
  return Math.min(exponentialDelay + jitter, config.maxDelay);
}

/**
 * Execute a Slack API call with rate limit handling and retry logic
 */
export async function executeSlackApiCall<T>(
  apiCall: () => Promise<T>,
  operationName: string = 'Slack API call',
  config: Partial<RateLimitConfig> = {}
): Promise<T> {
  const finalConfig = { ...DEFAULT_RATE_LIMIT_CONFIG, ...config };
  let lastError: unknown;

  for (let attempt = 1; attempt <= finalConfig.maxRetries; attempt++) {
    try {
      const result = await apiCall();
      
      // Log successful call after previous retries
      if (attempt > 1) {
        rateLimitLogger.info({
          event: 'slack_api_call_succeeded_after_retries',
          operationName,
          attempt,
          totalAttempts: finalConfig.maxRetries,
        });
      }
      
      return result;
    } catch (error) {
      lastError = error;

      // Check if this error is retryable
      if (!isRateLimitError(error) && !isRetryableServerError(error)) {
        rateLimitLogger.error({
          event: 'slack_api_error_non_retryable',
          operationName,
          attempt,
        }, error);
        throw error;
      }

      // If we've reached max attempts, give up
      if (attempt === finalConfig.maxRetries) {
        rateLimitLogger.error({
          event: 'slack_api_call_failed_all_retries',
          operationName,
          attempt,
          totalAttempts: finalConfig.maxRetries,
        }, error);
        throw error;
      }

      // Calculate delay and wait
      const delay = getRetryDelay(error as SlackApiError, attempt, finalConfig);
      
      const errorType = isRateLimitError(error) ? 'rate_limited' : 'server_error';
      rateLimitLogger.warn({
        event: `slack_api_${errorType}_retrying`,
        operationName,
        attempt,
        totalAttempts: finalConfig.maxRetries,
        delayMs: delay,
        error: error instanceof Error ? error.message : String(error),
        ...(isRateLimitError(error) && {
          rateLimitInfo: {
            code: (error as SlackApiError).code,
            status: (error as SlackApiError).response?.status,
          },
        }),
      });

      await new Promise<void>(resolve => setTimeout(resolve, delay));
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError!;
}

/**
 * Execute multiple Slack API calls in parallel with rate limit awareness
 * This is useful for bulk operations like sending notifications to multiple users
 */
export async function executeParallelSlackCalls<T>(
  calls: Array<() => Promise<T>>,
  operationName: string = 'parallel Slack API calls',
  concurrencyLimit: number = 5
): Promise<Array<{ success: boolean; result?: T; error?: unknown }>> {
  const results: Array<{ success: boolean; result?: T; error?: unknown }> = [];
  
  // Process calls in batches to respect rate limits
  for (let i = 0; i < calls.length; i += concurrencyLimit) {
    const batch = calls.slice(i, i + concurrencyLimit);
    
    const batchPromises = batch.map(async (call, index) => {
      try {
        const result = await executeSlackApiCall(
          call,
          `${operationName} (item ${i + index + 1})`
        );
        return { success: true, result };
      } catch (error) {
        rateLimitLogger.warn({
          event: 'parallel_slack_call_failed',
          operationName,
          itemIndex: i + index + 1,
          error: error instanceof Error ? error.message : String(error),
        });
        return { success: false, error };
      }
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    // Add a small delay between batches to be extra cautious with rate limits
    if (i + concurrencyLimit < calls.length) {
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
  }

  const successCount = results.filter(r => r.success).length;
  rateLimitLogger.info({
    event: 'parallel_slack_calls_completed',
    operationName,
    totalCalls: calls.length,
    successCount,
    failureCount: calls.length - successCount,
  });

  return results;
}

/**
 * Create a wrapped Slack client with automatic rate limit handling
 */
export function createRateLimitedSlackClient(slackClient: any): any {
  const wrappedClient: any = {};

  // Wrap all common methods that might hit rate limits
  const methodsToWrap = [
    'chat.postMessage',
    'chat.postEphemeral',
    'chat.update',
    'conversations.open',
    'users.info',
    'views.open',
    'views.push',
    'views.update',
  ];

  for (const method of methodsToWrap) {
    if (typeof slackClient[method] === 'function') {
      wrappedClient[method] = (...args: any[]) => 
        executeSlackApiCall(
          () => slackClient[method](...args),
          method
        );
    }
  }

  // For any other methods, pass through directly
  return new Proxy(slackClient, {
    get(target, prop) {
      if (prop in wrappedClient) {
        return wrappedClient[prop];
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Circuit breaker for Slack API calls
 * Prevents cascading failures when Slack is having issues
 */
export class SlackCircuitBreaker {
  private failureCount = 0;
  private lastFailureTime = 0;
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  
  constructor(
    private readonly failureThreshold = 5,
    private readonly recoveryTimeout = 60000 // 1 minute
  ) {}

  async execute<T>(apiCall: () => Promise<T>, operationName: string): Promise<T> {
    // Check if circuit should be OPEN
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime < this.recoveryTimeout) {
        throw new Error(`Circuit breaker is OPEN for ${operationName}. Slack API appears to be experiencing issues.`);
      }
      this.state = 'HALF_OPEN';
      rateLimitLogger.info({ event: 'circuit_breaker_half_open', operationName });
    }

    try {
      const result = await executeSlackApiCall(apiCall, operationName);
      this.onSuccess(operationName);
      return result;
    } catch (error) {
      this.onFailure(operationName);
      throw error;
    }
  }

  private onSuccess(operationName: string): void {
    if (this.state === 'HALF_OPEN') {
      this.failureCount = 0;
      this.state = 'CLOSED';
      rateLimitLogger.info({ event: 'circuit_breaker_closed', operationName });
    } else if (this.state === 'CLOSED') {
      this.failureCount = 0;
    }
  }

  private onFailure(operationName: string): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN' || this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      rateLimitLogger.warn({
        event: 'circuit_breaker_opened',
        operationName,
        failureCount: this.failureCount,
        failureThreshold: this.failureThreshold,
      });
    }
  }

  getState(): string {
    return this.state;
  }

  reset(): void {
    this.failureCount = 0;
    this.lastFailureTime = 0;
    this.state = 'CLOSED';
    rateLimitLogger.info({ event: 'circuit_breaker_reset' });
  }
}

// Global circuit breaker instance for Slack API calls
export const globalSlackCircuitBreaker = new SlackCircuitBreaker();
