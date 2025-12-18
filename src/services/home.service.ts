import { getUserBalances } from './balance.service';
import { getWhosOut, getUpcomingLeaves, getPendingRequestsForApprover } from './leave-request.service';
import { getOrCreateUser, isUserAdmin, isUserManager } from './user.service';
import type { HomeViewData } from '../views/home.view';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

/**
 * Slack user info object (subset of fields we need)
 */
interface SlackUserInfo {
  id: string;
  name?: string;
  real_name?: string;
  profile?: {
    display_name?: string;
    real_name?: string;
    image_72?: string;
    email?: string;
  };
}

/* ------------------------------------------------------------------ */
/* Home View Data Service                                               */
/* ------------------------------------------------------------------ */

/**
 * Fetches all data required to render the App Home tab
 * 
 * @param slackUserInfo - User info object from Slack API (client.users.info)
 * @returns HomeViewData containing user details, balances, leave info, and permissions
 */
export async function getHomeViewData(slackUserInfo: SlackUserInfo): Promise<HomeViewData> {
  const userId = slackUserInfo.id;

  // Ensure user exists in our database
  const user = await getOrCreateUser(slackUserInfo as any);

  // Fetch all data needed for the home view in parallel
  const [balances, whosOutToday, upcomingLeaves, isAdmin, isManager] = await Promise.all([
    getUserBalances(userId),
    getWhosOut(),
    getUpcomingLeaves(7),
    isUserAdmin(userId),
    isUserManager(userId),
  ]);

  // Get pending count for managers/admins
  let pendingCount = 0;
  if (isAdmin || isManager) {
    const pendingRequests = await getPendingRequestsForApprover(userId);
    pendingCount = pendingRequests.length;
  }

  return {
    userName: user.displayName,
    isAdmin,
    isManager,
    balances,
    whosOutToday,
    upcomingLeaves,
    pendingCount,
  };
}
