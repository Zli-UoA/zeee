import type { CloudContext } from 'void';
import { readCookie } from './cookies';
import {
  parseRecentPageIds,
  recentPagesCookieName,
  recentPagesFromIds,
  type RecentPage,
} from '../shared/recent';
import type { PageNavigation } from './types';

export function readRecentPages(
  c: CloudContext,
  pages: PageNavigation[],
  userId: string,
  activePageId?: string,
): RecentPage[] {
  const ids = parseRecentPageIds(readCookie(c, recentPagesCookieName(userId)));
  const ordered = activePageId ? [activePageId, ...ids.filter((id) => id !== activePageId)] : ids;
  return recentPagesFromIds(pages, ordered);
}
