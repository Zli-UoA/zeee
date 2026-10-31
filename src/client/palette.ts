import type { RecentPage } from './useRecentPages';

export type PaletteIntent = 'search' | 'create';

export type PaletteSearchResult = {
  id: string;
  title: string;
  excerpt: string;
  updatedAt?: number;
};

export type PaletteAction =
  | { kind: 'recent'; page: RecentPage }
  | { kind: 'create'; title: string }
  | { kind: 'result'; result: PaletteSearchResult }
  | { kind: 'all'; query: string };

type BuildPaletteActionsInput = {
  trimmedQuery: string;
  results: PaletteSearchResult[];
  resultsQuery: string | null;
  loading: boolean;
  error: string | null;
  intent: PaletteIntent;
  recentPages: RecentPage[];
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
  intent,
  recentPages,
}: BuildPaletteActionsInput): PaletteAction[] {
  if (trimmedQuery) {
    if (loading || error || resultsQuery !== trimmedQuery) return [];

    const createAction: PaletteAction = { kind: 'create', title: trimmedQuery };
    const allAction: PaletteAction = { kind: 'all', query: trimmedQuery };
    const resultActions = results.map((result): PaletteAction => ({ kind: 'result', result }));

    return resultActions.length > 0
      ? [...resultActions, allAction, createAction]
      : [createAction, allAction];
  }

  if (intent === 'create') return [{ kind: 'create', title: '' }];
  return recentPages.map((page): PaletteAction => ({ kind: 'recent', page }));
}
