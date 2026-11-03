import type { RecentPage } from './useRecentPages';

export const PALETTE_RESULT_LIMIT = 5;

export type PaletteSearchResult = {
  id: string;
  title: string;
  excerpt: string;
  updatedAt?: number;
};

export type PaletteAction =
  | { kind: 'recent'; page: RecentPage }
  | { kind: 'result'; result: PaletteSearchResult }
  | { kind: 'all'; query: string };

type BuildPaletteActionsInput = {
  trimmedQuery: string;
  results: PaletteSearchResult[];
  resultsQuery: string | null;
  loading: boolean;
  error: string | null;
  recentPages: RecentPage[];
  hasMore: boolean;
};

export function normalizeSearchResults(value: unknown): PaletteSearchResult[] {
  if (!Array.isArray(value)) return [];

  const results: PaletteSearchResult[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, title, excerpt, updatedAt } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !id) continue;
    if (typeof title !== 'string') continue;
    results.push({
      id,
      title,
      excerpt: typeof excerpt === 'string' ? excerpt : '',
      ...(typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? { updatedAt } : {}),
    });
  }
  return results;
}

export function buildPaletteActions({
  trimmedQuery,
  results,
  resultsQuery,
  loading,
  error,
  recentPages,
  hasMore,
}: BuildPaletteActionsInput): PaletteAction[] {
  if (trimmedQuery) {
    if (loading || error || resultsQuery !== trimmedQuery) return [];

    const resultActions = results
      .slice(0, PALETTE_RESULT_LIMIT)
      .map((result): PaletteAction => ({ kind: 'result', result }));
    if (!hasMore) return resultActions;
    return [...resultActions, { kind: 'all', query: trimmedQuery }];
  }

  return recentPages.map((page): PaletteAction => ({ kind: 'recent', page }));
}
