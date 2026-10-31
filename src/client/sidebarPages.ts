import { RECENT_PAGES_SIDEBAR_LIMIT, type RecentPage } from './useRecentPages';
import type { PageSummary } from '../server/types';

export function sidebarPageLists(
  pages: PageSummary[],
  recentPages: RecentPage[],
  limit = RECENT_PAGES_SIDEBAR_LIMIT,
): { recentPages: RecentPage[]; allPages: PageSummary[] } {
  return {
    recentPages: recentPages.slice(0, limit),
    allPages: pages,
  };
}
