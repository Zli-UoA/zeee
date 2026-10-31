import type { CloudContext } from 'void';
import { readCookie } from './cookies';
import {
  parseRecentPageIds,
  RECENT_PAGES_COOKIE,
  recentPagesFromIds,
  type RecentPage,
} from '../shared/recent';
import type { PageSummary } from './types';

export function readRecentPages(
  c: CloudContext,
  pages: PageSummary[],
  activePageId?: string,
): RecentPage[] {
  const ids = parseRecentPageIds(readCookie(c, RECENT_PAGES_COOKIE));
  const ordered = activePageId ? [activePageId, ...ids.filter((id) => id !== activePageId)] : ids;
  return recentPagesFromIds(pages, ordered);
}
