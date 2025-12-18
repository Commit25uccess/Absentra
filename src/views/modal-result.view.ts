import type { ModalView, KnownBlock } from '@slack/types';
import { plainText, mrkdwn } from '../utils/blocks';

export type ResultType = 'success' | 'error';

export interface ResultModalOptions {
  title: string;
  message: string;
  type: ResultType;
  details?: string[];
  blocks?: KnownBlock[];
  closeText?: string;
}

/**
 * Build a result modal (success or error) that displays feedback within the modal itself
 * This replaces ephemeral messages with in-modal feedback
 */
export function buildResultModal(options: ResultModalOptions): ModalView {
  const {
    title,
    message,
    type,
    details,
    blocks: customBlocks,
    closeText = 'Close',
  } = options;

  const emoji = type === 'success' ? '✅' : '❌';
  const colorHint = type === 'success' ? '🎉' : '⚠️';

  const resultBlocks: KnownBlock[] = [
    {
      type: 'header',
      text: plainText(`${emoji} ${title}`),
    },
    {
      type: 'section',
      text: mrkdwn(`${colorHint} ${message}`),
    },
  ];

  // Add details if provided
  if (details && details.length > 0) {
    resultBlocks.push({
      type: 'section',
      text: mrkdwn('*Details:*\n' + details.map((d) => `• ${d}`).join('\n')),
    });
  }

  // Add custom blocks if provided
  if (customBlocks && customBlocks.length > 0) {
    resultBlocks.push(...customBlocks);
  }

  // Add context hint
  if (type === 'error') {
    resultBlocks.push({
      type: 'context',
      elements: [mrkdwn('_If this issue persists, please contact your workspace admin._')],
    });
  }

  return {
    type: 'modal',
    title: plainText(type === 'success' ? 'Success' : 'Error'),
    close: plainText(closeText),
    blocks: resultBlocks,
  };
}

/**
 * Build a success modal
 */
export function buildSuccessModal(
  title: string,
  message: string,
  details?: string[],
  blocks?: KnownBlock[]
): ModalView {
  return buildResultModal({
    title,
    message,
    type: 'success',
    details,
    blocks,
  });
}

/**
 * Build an error modal
 */
export function buildErrorModal(
  title: string,
  message: string,
  details?: string[],
  blocks?: KnownBlock[]
): ModalView {
  return buildResultModal({
    title,
    message,
    type: 'error',
    details,
    blocks,
  });
}
