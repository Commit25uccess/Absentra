import type { KnownBlock, Block, PlainTextElement, MrkdwnElement } from '@slack/types';

/**
 * Helper functions for building Slack Block Kit UI elements
 * Provides a clean API for creating beautiful, consistent UI
 */

// Text helpers
export function plainText(text: string, emoji = true): PlainTextElement {
  return { type: 'plain_text', text, emoji };
}

export function mrkdwn(text: string): MrkdwnElement {
  return { type: 'mrkdwn', text };
}

// Block helpers
export function section(text: string, accessory?: Block): KnownBlock {
  const block: KnownBlock = {
    type: 'section',
    text: mrkdwn(text),
  };
  if (accessory) {
    (block as any).accessory = accessory;
  }
  return block;
}

export function sectionWithFields(fields: string[]): KnownBlock {
  return {
    type: 'section',
    fields: fields.map((f) => mrkdwn(f)),
  };
}

export function header(text: string): KnownBlock {
  return {
    type: 'header',
    text: plainText(text),
  };
}

export function divider(): KnownBlock {
  return { type: 'divider' };
}

export function context(elements: string[]): KnownBlock {
  return {
    type: 'context',
    elements: elements.map((e) => mrkdwn(e)),
  };
}

export function actions(elements: any[], blockId?: string): KnownBlock {
  const block: any = {
    type: 'actions',
    elements,
  };
  if (blockId) {
    block.block_id = blockId;
  }
  return block;
}

export function image(imageUrl: string, altText: string, title?: string): KnownBlock {
  const block: any = {
    type: 'image',
    image_url: imageUrl,
    alt_text: altText,
  };
  if (title) {
    block.title = plainText(title);
  }
  return block;
}

// Interactive element helpers
export function button(
  text: string,
  actionId: string,
  options: {
    value?: string;
    style?: 'primary' | 'danger';
    url?: string;
    confirm?: {
      title: string;
      text: string;
      confirm: string;
      deny: string;
    };
  } = {}
): any {
  const btn: any = {
    type: 'button',
    text: plainText(text),
    action_id: actionId,
  };
  if (options.value) btn.value = options.value;
  if (options.style) btn.style = options.style;
  if (options.url) btn.url = options.url;
  if (options.confirm) {
    btn.confirm = {
      title: plainText(options.confirm.title),
      text: mrkdwn(options.confirm.text),
      confirm: plainText(options.confirm.confirm),
      deny: plainText(options.confirm.deny),
    };
  }
  return btn;
}

export function staticSelect(
  placeholder: string,
  actionId: string,
  options: Array<{ text: string; value: string }>,
  initialOption?: { text: string; value: string }
): any {
  const select: any = {
    type: 'static_select',
    placeholder: plainText(placeholder),
    action_id: actionId,
    options: options.map((opt) => ({
      text: plainText(opt.text),
      value: opt.value,
    })),
  };
  if (initialOption) {
    select.initial_option = {
      text: plainText(initialOption.text),
      value: initialOption.value,
    };
  }
  return select;
}

export function datePicker(
  placeholder: string,
  actionId: string,
  initialDate?: string
): any {
  const picker: any = {
    type: 'datepicker',
    placeholder: plainText(placeholder),
    action_id: actionId,
  };
  if (initialDate) {
    picker.initial_date = initialDate;
  }
  return picker;
}

export function usersSelect(
  placeholder: string,
  actionId: string,
  initialUser?: string
): any {
  const select: any = {
    type: 'users_select',
    placeholder: plainText(placeholder),
    action_id: actionId,
  };
  if (initialUser) {
    select.initial_user = initialUser;
  }
  return select;
}

export function multiUsersSelect(
  placeholder: string,
  actionId: string,
  initialUsers?: string[]
): any {
  const select: any = {
    type: 'multi_users_select',
    placeholder: plainText(placeholder),
    action_id: actionId,
  };
  if (initialUsers && initialUsers.length > 0) {
    select.initial_users = initialUsers;
  }
  return select;
}

export function checkboxes(
  actionId: string,
  options: Array<{ text: string; value: string; description?: string }>,
  initialOptions?: Array<{ text: string; value: string }>
): any {
  const cb: any = {
    type: 'checkboxes',
    action_id: actionId,
    options: options.map((opt) => {
      const option: any = {
        text: mrkdwn(opt.text),
        value: opt.value,
      };
      if (opt.description) {
        option.description = plainText(opt.description);
      }
      return option;
    }),
  };
  if (initialOptions && initialOptions.length > 0) {
    cb.initial_options = initialOptions.map((opt) => ({
      text: mrkdwn(opt.text),
      value: opt.value,
    }));
  }
  return cb;
}

// Input block for modals
export function inputBlock(
  label: string,
  blockId: string,
  element: any,
  options: {
    optional?: boolean;
    hint?: string;
    dispatchAction?: boolean;
  } = {}
): KnownBlock {
  const block: any = {
    type: 'input',
    block_id: blockId,
    label: plainText(label),
    element,
    optional: options.optional ?? false,
  };
  if (options.hint) {
    block.hint = plainText(options.hint);
  }
  if (options.dispatchAction) {
    block.dispatch_action = true;
  }
  return block;
}

export function textInput(
  actionId: string,
  options: {
    placeholder?: string;
    initialValue?: string;
    multiline?: boolean;
    maxLength?: number;
  } = {}
): any {
  const input: any = {
    type: 'plain_text_input',
    action_id: actionId,
  };
  if (options.placeholder) {
    input.placeholder = plainText(options.placeholder);
  }
  if (options.initialValue) {
    input.initial_value = options.initialValue;
  }
  if (options.multiline) {
    input.multiline = true;
  }
  if (options.maxLength) {
    input.max_length = options.maxLength;
  }
  return input;
}

// Status indicator helpers
export function statusEmoji(status: string): string {
  switch (status.toUpperCase()) {
    case 'PENDING':
      return '⏳';
    case 'APPROVED':
      return '✅';
    case 'REJECTED':
      return '❌';
    case 'CANCELLED':
      return '🚫';
    default:
      return '📋';
  }
}

export function statusLabel(status: string): string {
  switch (status.toUpperCase()) {
    case 'PENDING':
      return 'Pending Approval';
    case 'APPROVED':
      return 'Approved';
    case 'REJECTED':
      return 'Rejected';
    case 'CANCELLED':
      return 'Cancelled';
    default:
      return status;
  }
}

// ============================================
// Formatting helpers
// ============================================

/**
 * Pluralize a word based on count
 */
export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}

/**
 * Format duration in days (e.g., "1 day", "5 days")
 */
export function formatDuration(days: number): string {
  return `${days} ${pluralize(days, 'day')}`;
}

/**
 * Format status with emoji and label
 */
export function formatStatus(status: string): string {
  return `${statusEmoji(status)} ${statusLabel(status)}`;
}
