import { prisma } from '../db/client';

export interface WorkspaceSettings {
  notificationChannelId?: string | null;
  requireApproval?: boolean;
  allowNegativeBalance?: boolean;
  digestEnabled?: boolean;
  digestHour?: number;
  digestMinute?: number;
  digestWeekdaysOnly?: boolean;
}

/**
 * Get workspace settings
 */
export async function getSettings() {
  return prisma.settings.findUnique({
    where: { id: 'default' },
  });
}

/**
 * Update workspace settings
 */
export async function updateSettings(data: WorkspaceSettings) {
  return prisma.settings.update({
    where: { id: 'default' },
    data,
  });
}
