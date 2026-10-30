export type Env = {
  DB: D1Database;
  ZEEE_DEV_AUTH?: string;
  AUTHZ_ISSUER?: string;
  AUTHZ_CLIENT_ID?: string;
  PUBLIC_ORIGIN?: string;
};

export type SessionUser = {
  id: string;
  username: string;
  displayName: string;
};

export type PageSummary = {
  id: string;
  title: string;
  updatedAt: number;
};

export type PageRecord = PageSummary & {
  markdown: string;
  createdAt: number;
  createdBy: string;
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
};
