import type { KnownBlock } from '@slack/types';
import { context } from './blocks';

export interface PaginationOptions {
  page: number;
  pageSize: number;
  totalItems: number;
  actionPrefix: string;
}

export interface PaginationResult<T> {
  items: T[];
  startIdx: number;
  endIdx: number;
  totalPages: number;
}

/**
 * Paginate an array of items
 */
export function paginate<T>(items: T[], page: number, pageSize: number): PaginationResult<T> {
  const totalItems = items.length;
  const totalPages = Math.ceil(totalItems / pageSize);
  const startIdx = page * pageSize;
  const endIdx = Math.min(startIdx + pageSize, totalItems);

  return {
    items: items.slice(startIdx, endIdx),
    startIdx,
    endIdx,
    totalPages,
  };
}

/**
 * Check if navigation to a page is valid
 */
export function canNavigateToPage(targetPage: number, totalItems: number, pageSize: number): boolean {
  const totalPages = Math.ceil(totalItems / pageSize);
  return targetPage >= 0 && targetPage < totalPages;
}

/**
 * Build pagination control blocks with both buttons (gray/disabled style when at boundaries)
 * Buttons at boundaries use action_id suffix '_disabled' to be ignored by handlers
 *
 * Note: Slack only supports 3 button styles: default (light), primary (green), danger (red)
 * Disabled buttons use default style (no style property) which appears lighter/greyer
 */
export function buildPaginationBlocks(options: PaginationOptions): KnownBlock[] {
  const { page, pageSize, totalItems, actionPrefix } = options;
  const totalPages = Math.ceil(totalItems / pageSize);

  if (totalPages <= 1) {
    return [];
  }

  const startIdx = page * pageSize;
  const endIdx = Math.min(startIdx + pageSize, totalItems);

  const hasPrevious = page > 0;
  const hasNext = page < totalPages - 1;

  // Use visual indicators for disabled state since Slack doesn't support custom button colors
  const prevText = hasPrevious ? '← Previous' : '◁ Previous';
  const nextText = hasNext ? 'Next →' : 'Next ▷';

  const blocks: KnownBlock[] = [
    {
      type: 'actions',
      block_id: `${actionPrefix}_pagination`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: prevText, emoji: true },
          // Use disabled action_id when no previous page, keeps same page value for safety
          action_id: hasPrevious ? `${actionPrefix}_prev_page` : `${actionPrefix}_prev_disabled`,
          value: hasPrevious ? String(page - 1) : String(page),
          ...(hasPrevious ? { style: 'primary' } : {}),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: nextText, emoji: true },
          // Use disabled action_id when no next page, keeps same page value for safety
          action_id: hasNext ? `${actionPrefix}_next_page` : `${actionPrefix}_next_disabled`,
          value: hasNext ? String(page + 1) : String(page),
          ...(hasNext ? { style: 'primary' } : {}),
        },
      ],
    } as KnownBlock,
    context([`Page ${page + 1} of ${totalPages} • Showing ${startIdx + 1}-${endIdx} of ${totalItems}`]),
  ];

  return blocks;
}
