import { decodeBase64, encodeBase64 } from '../shared/base64';
import type { PageSlice, PageSort, PaginationOptions } from './types';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_SEARCH_SIZE = 20;

export class PaginationError extends Error {}

type CursorKind = PageSort | 'trash' | 'fts' | 'like';
export type Cursor = {
  v: 1;
  kind: CursorKind;
  query: string;
  keys: Array<string | number>;
};

export function pageSize(options: PaginationOptions, fallback = DEFAULT_PAGE_SIZE): number {
  const limit = options.limit ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new PaginationError(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}`);
  }
  return limit;
}

export function parsePagination(params: URLSearchParams): PaginationOptions {
  const raw = params.get('limit');
  if (raw !== null && !/^[1-9]\d*$/.test(raw)) throw new PaginationError('invalid limit');
  const options = { cursor: params.get('cursor'), limit: raw === null ? undefined : Number(raw) };
  pageSize(options);
  return options;
}

export function parsePageSort(value: string | null): PageSort {
  if (value === null || value === 'updated') return 'updated';
  if (value === 'created' || value === 'title') return value;
  throw new PaginationError('sort must be updated, created, or title');
}

export function encodeCursor(cursor: Cursor): string {
  return encodeBase64(new TextEncoder().encode(JSON.stringify(cursor)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export function readCursor(
  value: string | null | undefined,
  kinds: CursorKind[],
  query = '',
): Cursor | null {
  if (value == null) return null;
  try {
    if (value.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        decodeBase64(value.replaceAll('-', '+').replaceAll('_', '/')),
      ),
    ) as Cursor;
    if (cursor.v !== 1 || !kinds.includes(cursor.kind) || cursor.query !== query) throw new Error();
    const types =
      cursor.kind === 'title'
        ? ['string', 'number', 'string']
        : cursor.kind === 'updated' || cursor.kind === 'created'
          ? ['number', 'number', 'string']
          : ['number', 'string'];
    if (!Array.isArray(cursor.keys) || cursor.keys.length !== types.length) throw new Error();
    if (
      cursor.keys.some(
        (key, i) => typeof key !== types[i] || (typeof key === 'number' && !Number.isFinite(key)),
      )
    )
      throw new Error();
    if (!cursor.keys.at(-1)) throw new Error();
    return cursor;
  } catch {
    throw new PaginationError('invalid cursor for this query or sort');
  }
}

export function pageSlice<T>(
  rows: T[],
  limit: number,
  cursorFor: (row: T) => Cursor,
): PageSlice<T> {
  const items = rows.slice(0, limit);
  return {
    items,
    limit,
    nextCursor: rows.length > limit ? encodeCursor(cursorFor(items[items.length - 1])) : null,
  };
}
