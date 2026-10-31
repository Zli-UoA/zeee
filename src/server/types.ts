export type Env = {
  DB: D1Database;
  ZEEE_DEV_AUTH?: string;
  AUTHZ_ISSUER?: string;
  AUTHZ_CLIENT_ID?: string;
  PUBLIC_ORIGIN?: string;
};

export const PAGE_LIST_LIMIT = 200;

export type PageSort = 'updated' | 'created' | 'title';

export type SessionUser = {
  id: string;
  username: string;
  displayName: string;
};

export type PageSummary = {
  id: string;
  title: string;
  createdAt: number;
  createdByName: string;
  excerpt: string;
  updatedAt: number;
};

export type PageRecord = PageSummary & {
  markdown: string;
  createdBy: string;
};

export type DeletedPageSummary = PageSummary & {
  deletedAt: number;
};

export type RevisionRecord = {
  id: string;
  pageId: string;
  version: number;
  markdown: string;
  authorId: string | null;
  manual: number;
  createdAt: number;
};

export type SearchResult = {
  id: string;
  title: string;
  excerpt: string;
  updatedAt: number;
};
