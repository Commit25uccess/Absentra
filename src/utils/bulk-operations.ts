/**
 * Bulk Operations Utility
 * Handles bulk operations with partial failure handling and graceful degradation
 */

import { prisma, executeWithRetry } from '../db/client';
import logger, { generateRequestId, runWithContextAsync } from './logger';

/* ------------------------------------------------------------------ */
/* Types and Interfaces                                                  */
/* ------------------------------------------------------------------ */

export interface BulkOperationResult<T = any> {
  success: boolean;
  totalItems: number;
  processedItems: number;
  failedItems: number;
  skippedItems: number;
  results: T[];
  errors: BulkOperationError[];
  duration: number;
  metadata?: Record<string, any>;
}

export interface BulkOperationError {
  index: number;
  item: any;
  error: string;
  errorType: 'validation' | 'business' | 'technical' | 'permission' | 'not_found';
  retryable: boolean;
  context?: Record<string, any>;
}

export interface BulkOperationConfig {
  batchSize?: number;
  maxRetries?: number;
  continueOnError?: boolean;
  validateBeforeExecution?: boolean;
  enablePartialSuccess?: boolean;
  transactionIsolation?: 'READ_UNCOMMITTED' | 'READ_COMMITTED' | 'REPEATABLE_READ' | 'SERIALIZABLE';
  timeoutMs?: number;
  retryDelayMs?: number;
  skipInvalidItems?: boolean;
}

export interface BulkItemProcessor<TInput, TOutput> {
  validate?: (item: TInput, index: number) => Promise<string | null>;
  process: (item: TInput, index: number) => Promise<TOutput>;
  onSuccess?: (item: TInput, result: TOutput, index: number) => Promise<void>;
  onError?: (item: TInput, error: BulkOperationError, index: number) => Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Default Configuration                                                  */
/* ------------------------------------------------------------------ */

const DEFAULT_CONFIG: Required<BulkOperationConfig> = {
  batchSize: 50,
  maxRetries: 3,
  continueOnError: true,
  validateBeforeExecution: true,
  enablePartialSuccess: true,
  transactionIsolation: 'READ_COMMITTED',
  timeoutMs: 30000, // 30 seconds
  retryDelayMs: 1000, // 1 second
  skipInvalidItems: true,
};

/* ------------------------------------------------------------------ */
/* Error Classification                                                   */
/* ------------------------------------------------------------------ */

function classifyError(error: unknown): BulkOperationError['errorType'] {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    
    if (message.includes('validation') || message.includes('invalid')) {
      return 'validation';
    }
    if (message.includes('permission') || message.includes('unauthorized') || message.includes('forbidden')) {
      return 'permission';
    }
    if (message.includes('not found') || message.includes('does not exist')) {
      return 'not_found';
    }
    if (message.includes('constraint') || message.includes('duplicate') || message.includes('conflict')) {
      return 'business';
    }
  }
  
  return 'technical';
}

function isRetryableError(errorType: BulkOperationError['errorType']): boolean {
  return errorType === 'technical' || errorType === 'business';
}

/* ------------------------------------------------------------------ */
/* Bulk Operation Executor                                               */
/* ------------------------------------------------------------------ */

export class BulkOperationExecutor<TInput, TOutput> {
  private config: Required<BulkOperationConfig>;
  private requestId: string;

  constructor(config: BulkOperationConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.requestId = generateRequestId();
  }

  /**
   * Execute bulk operation with partial failure handling
   */
  async execute(
    items: TInput[],
    processor: BulkItemProcessor<TInput, TOutput>
  ): Promise<BulkOperationResult<TOutput>> {
    const startTime = Date.now();
    
    await runWithContextAsync(
      { requestId: this.requestId, type: 'bulk_operation' as any, name: 'bulk_execute' },
      async () => {
        logger.info({
          event: 'bulk_operation_started',
          totalItems: items.length,
          batchSize: this.config.batchSize,
          continueOnError: this.config.continueOnError,
        });
      }
    );

    const result: BulkOperationResult<TOutput> = {
      success: false,
      totalItems: items.length,
      processedItems: 0,
      failedItems: 0,
      skippedItems: 0,
      results: [],
      errors: [],
      duration: 0,
    };

    try {
      // Pre-validate items if enabled
      if (this.config.validateBeforeExecution) {
        await this.validateItems(items, processor, result);
      }

      // Process items in batches
      await this.processBatches(items, processor, result);

      // Determine overall success
      result.success = this.config.enablePartialSuccess 
        ? result.failedItems === 0 
        : result.processedItems === result.totalItems;

      result.duration = Date.now() - startTime;

      await runWithContextAsync(
        { requestId: this.requestId, type: 'bulk_operation' as any, name: 'bulk_complete' },
        async () => {
          logger.info({
            event: 'bulk_operation_completed',
            success: result.success,
            totalItems: result.totalItems,
            processedItems: result.processedItems,
            failedItems: result.failedItems,
            skippedItems: result.skippedItems,
            duration: result.duration,
            errorTypes: result.errors.reduce((acc, err) => {
              acc[err.errorType] = (acc[err.errorType] || 0) + 1;
              return acc;
            }, {} as Record<string, number>),
          });
        }
      );

      return result;

    } catch (error) {
      result.duration = Date.now() - startTime;
      result.errors.push({
        index: -1,
        item: null,
        error: error instanceof Error ? error.message : String(error),
        errorType: 'technical',
        retryable: true,
        context: { phase: 'execution' },
      });

      await runWithContextAsync(
        { requestId: this.requestId, type: 'bulk_operation' as any, name: 'bulk_failed' },
        async () => {
          logger.error({
            event: 'bulk_operation_failed',
            totalItems: items.length,
            processedItems: result.processedItems,
            failedItems: result.failedItems,
          }, error);
        }
      );

      return result;
    }
  }

  /**
   * Validate all items before processing
   */
  private async validateItems(
    items: TInput[],
    processor: BulkItemProcessor<TInput, TOutput>,
    result: BulkOperationResult<TOutput>
  ): Promise<void> {
    if (!processor.validate) return;

    for (let i = 0; i < items.length; i++) {
      try {
        const validationError = await processor.validate(items[i]!, i);
        if (validationError) {
          const error: BulkOperationError = {
            index: i,
            item: items[i],
            error: validationError,
            errorType: 'validation',
            retryable: false,
            context: { phase: 'validation' },
          };

          result.errors.push(error);
          
          if (this.config.skipInvalidItems) {
            result.skippedItems++;
          } else {
            throw new Error(`Validation failed for item ${i}: ${validationError}`);
          }
        }
      } catch (error) {
        const validationError: BulkOperationError = {
          index: i,
          item: items[i],
          error: error instanceof Error ? error.message : String(error),
          errorType: 'validation',
          retryable: false,
          context: { phase: 'validation' },
        };

        result.errors.push(validationError);
        
        if (this.config.skipInvalidItems) {
          result.skippedItems++;
        } else {
          throw error;
        }
      }
    }
  }

  /**
   * Process items in batches with transaction management
   */
  private async processBatches(
    items: TInput[],
    processor: BulkItemProcessor<TInput, TOutput>,
    result: BulkOperationResult<TOutput>
  ): Promise<void> {
    const validItems = this.config.skipInvalidItems 
      ? items.filter((_, index) => !result.errors.some(err => err.index === index))
      : items;

    for (let batchStart = 0; batchStart < validItems.length; batchStart += this.config.batchSize) {
      const batchEnd = Math.min(batchStart + this.config.batchSize, validItems.length);
      const batch = validItems.slice(batchStart, batchEnd);

      await this.processBatch(batch, batchStart, processor, result);
    }
  }

  /**
   * Process a single batch with retry logic
   */
  private async processBatch(
    batch: TInput[],
    batchStartIndex: number,
    processor: BulkItemProcessor<TInput, TOutput>,
    result: BulkOperationResult<TOutput>
  ): Promise<void> {
    let attempts = 0;
    
    while (attempts <= this.config.maxRetries) {
      try {
        await executeWithRetry(
          async () => {
            // Process each item in the batch
            for (let i = 0; i < batch.length; i++) {
              const itemIndex = batchStartIndex + i;
              const item = batch[i];

              try {
                const processResult = await processor.process(item!, itemIndex);
                result.results.push(processResult!);
                result.processedItems++;

                // Call success callback if provided
                if (processor.onSuccess) {
                  await processor.onSuccess(item!, processResult!, itemIndex);
                }

              } catch (error) {
                const errorType = classifyError(error);
                const retryable = isRetryableError(errorType) && attempts < this.config.maxRetries;

                const operationError: BulkOperationError = {
                  index: itemIndex,
                  item,
                  error: error instanceof Error ? error.message : String(error),
                  errorType,
                  retryable,
                  context: { 
                    batchIndex: i, 
                    attempt: attempts + 1,
                    batchSize: batch.length 
                  },
                };

                result.errors.push(operationError);
                result.failedItems++;

                // Call error callback if provided
                if (processor.onError) {
                  await processor.onError(item as any, operationError, itemIndex);
                }

                // Stop processing if continueOnError is false
                if (!this.config.continueOnError && !retryable) {
                  throw error;
                }
              }
            }
          },
          `bulk_batch_${batchStartIndex}`
        );

        // Batch processed successfully, break retry loop
        break;

      } catch (error) {
        attempts++;
        
        if (attempts > this.config.maxRetries) {
          // Max retries exceeded, log and continue
          logger.error({
            event: 'batch_max_retries_exceeded',
            batchStartIndex,
            batchSize: batch.length,
            attempts,
          }, error);
          
          if (!this.config.continueOnError) {
            throw error;
          }
        } else {
          // Wait before retry
          await new Promise(resolve => (globalThis as any).setTimeout(resolve, this.config.retryDelayMs * attempts));

          logger.warn({
            event: 'batch_retrying',
            batchStartIndex,
            attempt: attempts,
            maxRetries: this.config.maxRetries,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Specialized Bulk Operations                                            */
/* ------------------------------------------------------------------ */

/**
 * Bulk user creation with partial failure handling
 */
export async function bulkCreateUsers(
  users: Array<{ slackId: string; email?: string; displayName: string }>,
  config: BulkOperationConfig = {}
): Promise<BulkOperationResult<any>> {
  const executor = new BulkOperationExecutor(config);

  return executor.execute(users, {
    validate: async (user: any, _index) => {
      if (!user.slackId) {
        return 'Slack ID is required';
      }
      if (!user.displayName) {
        return 'Display name is required';
      }
      return null;
    },

    process: async (user: any) => {
      return await prisma.user.create({
        data: {
          slackId: user.slackId,
          email: user.email,
          displayName: user.displayName,
        },
      });
    },

    onSuccess: async (user: any, result) => {
      logger.debug({
        event: 'user_created',
        userId: (result as any).id,
        slackId: user.slackId,
      });
    },

    onError: async (user: any, error) => {
      logger.warn({
        event: 'user_creation_failed',
        slackId: user.slackId,
        error: error.error,
        errorType: error.errorType,
        retryable: error.retryable,
      });
    },
  });
}

/**
 * Bulk leave balance updates with partial failure handling
 */
export async function bulkUpdateBalances(
  updates: Array<{ userId: string; leaveTypeId: string; year: number; adjustment: number }>,
  config: BulkOperationConfig = {}
): Promise<BulkOperationResult<any>> {
  const executor = new BulkOperationExecutor(config);
  
  return executor.execute(updates, {
    validate: async (update: any, _index) => {
      if (!update.userId) {
        return 'User ID is required';
      }
      if (!update.leaveTypeId) {
        return 'Leave type ID is required';
      }
      if (typeof update.year !== 'number' || update.year < 2000 || update.year > 2100) {
        return 'Valid year is required';
      }
      if (typeof update.adjustment !== 'number') {
        return 'Adjustment must be a number';
      }
      return null;
    },
    
    process: async (update: any) => {
      return await prisma.leaveBalance.upsert({
        where: {
          userId_leaveTypeId_year: {
            userId: update.userId,
            leaveTypeId: update.leaveTypeId,
            year: update.year,
          },
        },
        update: {
          adjustment: {
            increment: update.adjustment,
          },
        },
        create: {
          userId: update.userId,
          leaveTypeId: update.leaveTypeId,
          year: update.year,
          allowance: update.adjustment,
          adjustment: update.adjustment,
        },
      });
    },

    onSuccess: async (update: any, result) => {
      logger.debug({
        event: 'balance_updated',
        userId: update.userId,
        leaveTypeId: update.leaveTypeId,
        year: update.year,
        newBalance: (result as any).allowance,
      });
    },

    onError: async (update: any, error) => {
      logger.warn({
        event: 'balance_update_failed',
        userId: update.userId,
        leaveTypeId: update.leaveTypeId,
        year: update.year,
        error: error.error,
        errorType: error.errorType,
      });
    },
  });
}

/**
 * Bulk leave request status updates with partial failure handling
 */
export async function bulkUpdateRequestStatuses(
  updates: Array<{ requestId: string; status: string; approverId?: string; approverNote?: string }>,
  config: BulkOperationConfig = {}
): Promise<BulkOperationResult<any>> {
  const executor = new BulkOperationExecutor(config);

  return executor.execute(updates, {
    validate: async (update: any, _index) => {
      if (!update.requestId) {
        return 'Request ID is required';
      }
      if (!update.status || !['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].includes(update.status)) {
        return 'Valid status is required';
      }
      if (['APPROVED', 'REJECTED'].includes(update.status) && !update.approverId) {
        return 'Approver ID is required for approval/rejection';
      }
      return null;
    },

    process: async (update: any) => {
      const updateData: any = {
        status: update.status,
        approvedAt: ['APPROVED', 'REJECTED'].includes(update.status) ? new Date() : undefined,
      };

      if (update.approverId) {
        updateData.approverId = update.approverId;
      }
      if (update.approverNote) {
        updateData.approverNote = update.approverNote;
      }

      return await prisma.leaveRequest.update({
        where: { id: update.requestId },
        data: updateData,
      });
    },

    onSuccess: async (update: any, result) => {
      logger.info({
        event: 'request_status_updated',
        requestId: update.requestId,
        oldStatus: (result as any).status,
        newStatus: update.status,
        approverId: update.approverId,
      });
    },

    onError: async (update: any, error) => {
      logger.warn({
        event: 'request_status_update_failed',
        requestId: update.requestId,
        status: update.status,
        error: error.error,
        errorType: error.errorType,
      });
    },
  });
}

/* ------------------------------------------------------------------ */
/* Exports                                                               */
/* ------------------------------------------------------------------ */
