import { useCallback, useEffect, useState } from 'react';

export type RecentPage = {
  id: string;
  title: string;
  visitedAt: number;
};

export const RECENT_PAGES_STORAGE_KEY = 'zeee.recent-pages.v1';
export const RECENT_PAGES_LIMIT = 8;

export function normalizeRecentPages(value: unknown): RecentPage[] {
  if (!Array.isArray(value)) return [];

  const newest = new Map<string, RecentPage>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, title, visitedAt } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !id) continue;
    if (typeof title !== 'string') continue;
    if (typeof visitedAt !== 'number' || !Number.isFinite(visitedAt)) continue;

    const current = newest.get(id);
    if (!current || visitedAt > current.visitedAt) newest.set(id, { id, title, visitedAt });
  }

  return Array.from(newest.values())
    .sort((a, b) => b.visitedAt - a.visitedAt)
    .slice(0, RECENT_PAGES_LIMIT);
}

export function withRecentPage(
  pages: RecentPage[],
  page: { id: string; title: string },
  visitedAt = Date.now(),
): RecentPage[] {
  return [
    { id: page.id, title: page.title, visitedAt },
    ...pages.filter((entry) => entry.id !== page.id),
  ]
    .sort((a, b) => b.visitedAt - a.visitedAt)
    .slice(0, RECENT_PAGES_LIMIT);
}

function persistRecentPages(pages: RecentPage[]) {
  try {
    window.localStorage.setItem(RECENT_PAGES_STORAGE_KEY, JSON.stringify(pages));
  } catch {
    return;
  }
}

export function useRecentPages() {
  const [recentPages, setRecentPages] = useState<RecentPage[]>([]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(RECENT_PAGES_STORAGE_KEY);
      if (!raw) return;
      setRecentPages(normalizeRecentPages(JSON.parse(raw)));
    } catch {
      setRecentPages([]);
    }
  }, []);

  const recordVisit = useCallback((page: { id: string; title: string }) => {
    setRecentPages((current) => {
      const next = withRecentPage(current, page);
      persistRecentPages(next);
      return next;
    });
  }, []);

  return { recentPages, recordVisit };
}
