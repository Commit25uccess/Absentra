import type { ModalView, KnownBlock } from '@slack/types';
import { plainText, mrkdwn } from '../utils/blocks';

/**
 * Build view policy modal with optional edit button for admins
 */
export function buildViewPolicyModal(content: string, isAdmin: boolean = false): ModalView {
  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: plainText('📜 Leave Policy'),
    },
  ];

  // Add Edit button for admins at the top
  if (isAdmin) {
    blocks.push({
      type: 'section',
      text: mrkdwn(content),
      accessory: {
        type: 'button',
        text: plainText('✏️ Edit'),
        action_id: 'view_policy_edit',
      },
    });
  } else {
    blocks.push({
      type: 'section',
      text: mrkdwn(content),
    });
  }

  return {
    type: 'modal',
    title: plainText('Leave Policy'),
    close: plainText('Close'),
    blocks,
  };
}

/**
 * Build edit policy modal (admin only)
 */
export function buildEditPolicyModal(content: string): ModalView {
  // Slack has limits on initial_value length for plain_text_input (3000 chars)
  // For longer content, we show it in a preview section and provide an empty textarea
  const MAX_INITIAL_VALUE_LENGTH = 3000;
  const shouldPreview = content.length > MAX_INITIAL_VALUE_LENGTH;

  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: mrkdwn('Update the leave policy content. You can use Markdown formatting.'),
    },
    {
      type: 'divider',
    },
  ];

  // Show current content in preview section if it's too long for initial_value
  if (shouldPreview) {
    blocks.push({
      type: 'section',
      text: mrkdwn('*Current Policy Content:*\n' + content.substring(0, 2000) + (content.length > 2000 ? '\n\n_... (content truncated for display)_\n\n_Replace with full content below._' : '')),
    });
    blocks.push({
      type: 'divider',
    });
  }

  blocks.push({
    type: 'input',
    block_id: 'policy_content_block',
    label: plainText(shouldPreview ? 'New Policy Content' : 'Policy Content'),
    element: {
      type: 'plain_text_input',
      action_id: 'policy_content',
      ...(shouldPreview ? {} : { initial_value: content }),
      multiline: true,
      max_length: 3000,
    },
  });

  if (shouldPreview) {
    blocks.push({
      type: 'context',
      elements: [
        mrkdwn('_Current content is too large to display in editor. Please copy the full content above, make your changes, and paste it back here._'),
      ],
    });
  } else {
    blocks.push({
      type: 'context',
      elements: [
        mrkdwn('_Tip: Use Markdown for formatting. You can include headings, lists, links, etc._'),
      ],
    });
  }

  return {
    type: 'modal',
    callback_id: 'edit_policy_submit',
    title: plainText('Edit Policy'),
    submit: plainText('Save'),
    close: plainText('Cancel'),
    blocks,
  };
}
