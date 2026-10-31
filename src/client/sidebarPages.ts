import { RECENT_PAGES_SIDEBAR_LIMIT, type RecentPage } from './useRecentPages';
import type { PageSummary } from '../server/types';

export function sidebarPageLists(
  pages: PageSummary[],
  recentPages: RecentPage[],
  limit = RECENT_PAGES_SIDEBAR_LIMIT,
): { recentPages: RecentPage[]; otherPages: PageSummary[] } {
  const visibleRecentPages = recentPages.slice(0, limit);
  const recentIds = new Set(visibleRecentPages.map((page) => page.id));
  return {
    recentPages: visibleRecentPages,
    otherPages: pages.filter((page) => !recentIds.has(page.id)),
  };
}
