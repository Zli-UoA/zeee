import { useCallback, useEffect, useRef, useState } from 'react';
import {
  encodeRecentPageIds,
  recentPagesCookieName,
  RECENT_PAGES_LIMIT,
  RECENT_PAGES_SIDEBAR_LIMIT,
  type RecentPage,
} from '../shared/recent';

export { RECENT_PAGES_LIMIT, RECENT_PAGES_SIDEBAR_LIMIT };
export type { RecentPage };

export const RECENT_PAGES_STORAGE_KEY = 'zeee.recent-pages.v1';

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

function mergeRecentPages(primary: RecentPage[], secondary: RecentPage[]): RecentPage[] {
  const seen = new Set<string>();
  const merged: RecentPage[] = [];
  for (const page of [...primary, ...secondary]) {
    if (seen.has(page.id)) continue;
    seen.add(page.id);
    merged.push(page);
    if (merged.length === RECENT_PAGES_LIMIT) break;
  }
  return merged;
}

function saveRecentCookie(userId: string, pages: RecentPage[]) {
  if (typeof document === 'undefined') return;
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${recentPagesCookieName(userId)}=${encodeURIComponent(
    encodeRecentPageIds(pages),
  )}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}

type RecentPagesState = {
  userId: string;
  pages: RecentPage[];
};

export function useRecentPages(userId: string | undefined, initialPages: RecentPage[] = []) {
  const initialState = userId ? { userId, pages: initialPages } : null;
  const [state, setState] = useState<RecentPagesState | null>(initialState);
  const stateRef = useRef<RecentPagesState | null>(initialState);

  useEffect(() => {
    clearLegacyRecentPages(window.localStorage);
  }, []);

  useEffect(() => {
    const next = userId ? { userId, pages: initialPages } : null;
    stateRef.current = next;
    setState(next);
  }, [userId, initialPages]);

  const recordVisit = useCallback(
    (page: { id: string; title: string }) => {
      if (!userId) return;
      const current = stateRef.current;
      const currentPages = current?.userId === userId ? current.pages : [];
      const stored = loadRecentPages(window.localStorage, userId);
      const next = withRecentPage(currentPages, page);
      const persisted = withRecentPage(mergeRecentPages(currentPages, stored), page);
      const nextState = { userId, pages: next };
      stateRef.current = nextState;
      setState(nextState);
      saveRecentPages(window.localStorage, userId, persisted);
      saveRecentCookie(userId, persisted);
    },
    [userId],
  );

  return {
    recentPages: state && state.userId === userId ? state.pages : [],
    recordVisit,
  };
}
