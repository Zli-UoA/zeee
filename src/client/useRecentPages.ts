import { useCallback, useEffect, useState } from 'react';

export type RecentPage = {
  id: string;
  title: string;
  visitedAt: number;
};

export const RECENT_PAGES_STORAGE_KEY = 'zeee.recent-pages.v1';
export const RECENT_PAGES_LIMIT = 8;
export const RECENT_PAGES_SIDEBAR_LIMIT = 5;

type RecentPagesStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function recentPagesStorageKey(userId: string): string {
  return `${RECENT_PAGES_STORAGE_KEY}:${userId}`;
}

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

export function loadRecentPages(storage: RecentPagesStorage, userId: string): RecentPage[] {
  try {
    const raw = storage.getItem(recentPagesStorageKey(userId));
    if (!raw) return [];
    return normalizeRecentPages(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function saveRecentPages(storage: RecentPagesStorage, userId: string, pages: RecentPage[]) {
  try {
    storage.setItem(recentPagesStorageKey(userId), JSON.stringify(pages));
  } catch {
    return;
  }
}

export function clearLegacyRecentPages(storage: RecentPagesStorage) {
  try {
    storage.removeItem(RECENT_PAGES_STORAGE_KEY);
  } catch {
    return;
  }
}

type RecentPagesState = {
  userId: string;
  pages: RecentPage[];
};

export function useRecentPages(userId: string | undefined) {
  const [state, setState] = useState<RecentPagesState | null>(null);

  useEffect(() => {
    clearLegacyRecentPages(window.localStorage);
    if (!userId) {
      setState(null);
      return;
    }
    setState({ userId, pages: loadRecentPages(window.localStorage, userId) });
  }, [userId]);

  const recordVisit = useCallback(
    (page: { id: string; title: string }) => {
      if (!userId) return;
      setState((current) => {
        const pages =
          current?.userId === userId ? current.pages : loadRecentPages(window.localStorage, userId);
        const next = withRecentPage(pages, page);
        saveRecentPages(window.localStorage, userId, next);
        return { userId, pages: next };
      });
    },
    [userId],
  );

  return {
    recentPages: state && state.userId === userId ? state.pages : [],
    recordVisit,
  };
}
