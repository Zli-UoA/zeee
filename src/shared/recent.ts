export type RecentPage = {
  id: string;
  title: string;
  visitedAt: number;
};

export const RECENT_PAGES_COOKIE_PREFIX = 'zeee_recent_pages';
export const RECENT_PAGES_LIMIT = 8;
export const RECENT_PAGES_SIDEBAR_LIMIT = 5;

export function recentPagesCookieName(userId: string): string {
  return `${RECENT_PAGES_COOKIE_PREFIX}_${userId}`;
}

export function encodeRecentPageIds(pages: RecentPage[]): string {
  const ids = new Set<string>();
  for (const page of pages) {
    if (!page.id) continue;
    ids.add(page.id);
    if (ids.size === RECENT_PAGES_LIMIT) break;
  }
  return Array.from(ids).join(',');
}

export function parseRecentPageIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of raw.split(',')) {
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length === RECENT_PAGES_LIMIT) break;
  }
  return ids;
}

export function recentPagesFromIds(
  pages: Array<{ id: string; title: string }>,
  ids: string[],
): RecentPage[] {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const recent: RecentPage[] = [];
  for (const id of ids) {
    const page = byId.get(id);
    if (!page) continue;
    recent.push({ id: page.id, title: page.title, visitedAt: ids.length - recent.length });
    if (recent.length === RECENT_PAGES_LIMIT) break;
  }
  return recent;
}
