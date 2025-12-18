// src/utils/guards.ts
import { isUserAdmin } from '../services/user.service';

type SlackClient = any;

export async function requireAdmin(
  client: SlackClient,
  userId: string,
  channelId?: string
): Promise<boolean> {
  const isAdmin = await isUserAdmin(userId);
  if (!isAdmin) {
    await client.chat.postEphemeral({
      channel: channelId || userId,
      user: userId,
      text: '⚠️ You need to be an admin to perform this action.',
    });
  }
  return isAdmin;
}
