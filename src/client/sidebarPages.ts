import { RECENT_PAGES_SIDEBAR_LIMIT, type RecentPage } from './useRecentPages';
import type { PageNavigation } from '../server/types';

export function sidebarPageLists(
  pages: PageNavigation[],
  recentPages: RecentPage[],
  limit = RECENT_PAGES_SIDEBAR_LIMIT,
): { recentPages: RecentPage[]; allPages: PageNavigation[] } {
  return {
    recentPages: recentPages.slice(0, limit),
    allPages: pages,
  };
}
