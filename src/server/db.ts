import { randomToken, sha256Base64Url, uuid } from './crypto';
import { ensureSchema } from './schema';
import {
  PAGE_LIST_LIMIT,
  type DeletedPageSummary,
  type LinkTarget,
  type PageRecord,
  type PageSort,
  type PageSummary,
  type RevisionRecord,
  type SearchResult,
  type SessionUser,
} from './types';

const EXCERPT_LENGTH = 180;
const EXCERPT_SOURCE_LENGTH = 1000;

const UPSERT_PAGE_ALIAS = `INSERT INTO page_alias (alias, page_id, created_at) VALUES (?, ?, ?)
  ON CONFLICT(alias) DO UPDATE SET page_id = excluded.page_id, created_at = excluded.created_at`;

type UserRow = {
  id: string;
  issuer: string;
  subject: string;
  username: string;
  display_name: string;
};

type PageRow = {
  id: string;
  title: string;
  created_by: string;
  created_at: number;
  updated_at: number;
};

type PageSummaryRow = {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  created_by_name: string | null;
  excerpt_source: string | null;
};

type DeletedPageRow = PageSummaryRow & {
  deleted_at: number;
};

type SearchRow = {
  id: string;
  title: string;
  excerpt: string | null;
  updated_at: number;
};

type LinkTargetRow = {
  id: string;
  title: string;
  updated_at: number;
  alias: string | null;
};

type RevisionRow = {
  id: string;
  page_id: string;
  version: number;
  markdown: string;
  author_id: string | null;
  manual: number;
  created_at: number;
};

export type UpsertUserInput = {
  issuer: string;
  subject: string;
  username: string;
  displayName: string;
};

export async function upsertUser(db: D1Database, input: UpsertUserInput): Promise<SessionUser> {
  await ensureSchema(db);
  const existing = await db
    .prepare(
      'SELECT id, issuer, subject, username, display_name FROM app_user WHERE issuer = ? AND subject = ?',
    )
    .bind(input.issuer, input.subject)
    .first<UserRow>();

  const timestamp = Date.now();
  if (existing) {
    await db
      .prepare('UPDATE app_user SET username = ?, display_name = ?, updated_at = ? WHERE id = ?')
      .bind(input.username, input.displayName, timestamp, existing.id)
      .run();
    return {
      id: existing.id,
      username: input.username,
      displayName: input.displayName,
    };
  }

  const id = uuid();
  await db
    .prepare(
      'INSERT INTO app_user (id, issuer, subject, username, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(id, input.issuer, input.subject, input.username, input.displayName, timestamp, timestamp)
    .run();
  return { id, username: input.username, displayName: input.displayName };
}

export async function createSession(db: D1Database, userId: string): Promise<string> {
  await ensureSchema(db);
  const token = randomToken();
  const id = await sha256Base64Url(token);
  const timestamp = Date.now();
  const expiresAt = timestamp + 1000 * 60 * 60 * 24 * 7;
  await db
    .prepare(
      'INSERT INTO session (id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(id, userId, timestamp, expiresAt, timestamp)
    .run();
  return token;
}

export async function getUserBySession(db: D1Database, token: string): Promise<SessionUser | null> {
  await ensureSchema(db);
  const id = await sha256Base64Url(token);
  const row = await db
    .prepare(
      `SELECT u.id, u.username, u.display_name, s.expires_at
       FROM session s JOIN app_user u ON u.id = s.user_id
       WHERE s.id = ?`,
    )
    .bind(id)
    .first<{ id: string; username: string; display_name: string; expires_at: number }>();

  if (!row) return null;
  const timestamp = Date.now();
  if (row.expires_at <= timestamp) {
    await db.prepare('DELETE FROM session WHERE id = ?').bind(id).run();
    return null;
  }
  await db.prepare('UPDATE session SET last_seen_at = ? WHERE id = ?').bind(timestamp, id).run();
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
  };
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
  await ensureSchema(db);
  const id = await sha256Base64Url(token);
  await db.prepare('DELETE FROM session WHERE id = ?').bind(id).run();
}

export type LoginFlowInput = {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
};

export async function createLoginFlow(db: D1Database, input: LoginFlowInput): Promise<void> {
  await ensureSchema(db);
  const timestamp = Date.now();
  await db
    .prepare(
      'INSERT INTO login_flow (state, nonce, code_verifier, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(
      input.state,
      input.nonce,
      input.codeVerifier,
      input.returnTo,
      timestamp,
      timestamp + 10 * 60 * 1000,
    )
    .run();
}

export async function consumeLoginFlow(
  db: D1Database,
  state: string,
): Promise<{ nonce: string; codeVerifier: string; returnTo: string } | null> {
  await ensureSchema(db);
  const row = await db
    .prepare('SELECT nonce, code_verifier, return_to, expires_at FROM login_flow WHERE state = ?')
    .bind(state)
    .first<{ nonce: string; code_verifier: string; return_to: string; expires_at: number }>();
  await db.prepare('DELETE FROM login_flow WHERE state = ?').bind(state).run();
  if (!row || row.expires_at <= Date.now()) return null;
  return { nonce: row.nonce, codeVerifier: row.code_verifier, returnTo: row.return_to };
}

export async function listPages(db: D1Database): Promise<PageSummary[]> {
  await ensureSchema(db);
  const result = await db
    .prepare(
      `SELECT p.id, p.title, p.created_at, p.updated_at,
              u.display_name AS created_by_name,
              substr(COALESCE(b.markdown, ''), 1, ${EXCERPT_SOURCE_LENGTH}) AS excerpt_source
       FROM page p
       LEFT JOIN app_user u ON u.id = p.created_by
       LEFT JOIN page_body b ON b.page_id = p.id
       WHERE p.deleted_at IS NULL
       ORDER BY p.updated_at DESC
       LIMIT ${PAGE_LIST_LIMIT}`,
    )
    .all<PageSummaryRow>();
  return (result.results ?? []).map(toPageSummary);
}

export async function listLinkTargets(db: D1Database): Promise<LinkTarget[]> {
  await ensureSchema(db);
  const result = await db
    .prepare(
      `WITH targets AS (
         SELECT id, title, updated_at FROM page
         WHERE deleted_at IS NULL
         ORDER BY updated_at DESC
         LIMIT ${PAGE_LIST_LIMIT}
       )
       SELECT t.id, t.title, t.updated_at, a.alias
       FROM targets t
       LEFT JOIN page_alias a
         ON a.page_id = t.id
        AND a.alias NOT IN (SELECT title FROM page WHERE deleted_at IS NULL)
       ORDER BY t.updated_at DESC, t.id ASC, a.created_at DESC, a.alias ASC`,
    )
    .all<LinkTargetRow>();

  const targets = new Map<string, LinkTarget>();
  for (const row of result.results ?? []) {
    let target = targets.get(row.id);
    if (!target) {
      target = { id: row.id, title: row.title, updatedAt: row.updated_at, aliases: [] };
      targets.set(row.id, target);
    }
    if (row.alias) target.aliases.push(row.alias);
  }
  return [...targets.values()];
}

export async function listDeletedPages(db: D1Database): Promise<DeletedPageSummary[]> {
  await ensureSchema(db);
  const result = await db
    .prepare(
      `SELECT p.id, p.title, p.created_at, p.updated_at, p.deleted_at,
              u.display_name AS created_by_name,
              substr(COALESCE(b.markdown, ''), 1, ${EXCERPT_SOURCE_LENGTH}) AS excerpt_source
       FROM page p
       LEFT JOIN app_user u ON u.id = p.created_by
       LEFT JOIN page_body b ON b.page_id = p.id
       WHERE p.deleted_at IS NOT NULL
       ORDER BY p.deleted_at DESC
       LIMIT ${PAGE_LIST_LIMIT}`,
    )
    .all<DeletedPageRow>();
  return (result.results ?? []).map(toDeletedPageSummary);
}

export function sortPageSummaries(pages: PageSummary[], sort: PageSort): PageSummary[] {
  const sorted = [...pages];
  if (sort === 'title') {
    sorted.sort(
      (a, b) =>
        a.title.localeCompare(b.title, 'ja', { numeric: true, sensitivity: 'base' }) ||
        b.updatedAt - a.updatedAt ||
        a.id.localeCompare(b.id),
    );
  } else if (sort === 'created') {
    sorted.sort(
      (a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
    );
  } else {
    sorted.sort(
      (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id),
    );
  }
  return sorted;
}

export function excerptFromMarkdown(markdown: string, maxLength = EXCERPT_LENGTH): string {
  const plain = markdown
    .replace(/\r\n?/g, '\n')
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, '$1')
    .replace(/~~~[^\n]*\n?([\s\S]*?)~~~/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/gm, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/~~/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const characters = Array.from(plain);
  if (characters.length <= maxLength) return plain;
  return `${characters.slice(0, maxLength).join('').trimEnd()}…`;
}

function toPageSummary(row: PageSummaryRow): PageSummary {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    createdByName: row.created_by_name ?? '',
    excerpt: excerptFromMarkdown(row.excerpt_source ?? ''),
    updatedAt: row.updated_at,
  };
}

function toDeletedPageSummary(row: DeletedPageRow): DeletedPageSummary {
  return {
    ...toPageSummary(row),
    deletedAt: row.deleted_at,
  };
}

export async function getPage(db: D1Database, pageId: string): Promise<PageRecord | null> {
  await ensureSchema(db);
  const row = await db
    .prepare(
      `SELECT p.id, p.title, p.created_by, p.created_at, p.updated_at,
              u.display_name AS created_by_name,
              COALESCE(b.markdown, '') AS markdown
       FROM page p
       LEFT JOIN app_user u ON u.id = p.created_by
       LEFT JOIN page_body b ON b.page_id = p.id
       WHERE p.id = ? AND p.deleted_at IS NULL`,
    )
    .bind(pageId)
    .first<PageRow & { created_by_name: string | null; markdown: string }>();
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    createdBy: row.created_by,
    createdByName: row.created_by_name ?? '',
    createdAt: row.created_at,
    excerpt: excerptFromMarkdown(row.markdown),
    updatedAt: row.updated_at,
    markdown: row.markdown,
  };
}

export async function createPage(
  db: D1Database,
  title: string,
  userId: string,
): Promise<PageSummary> {
  await ensureSchema(db);
  const id = uuid();
  const timestamp = Date.now();
  const author = await db
    .prepare('SELECT display_name FROM app_user WHERE id = ?')
    .bind(userId)
    .first<{ display_name: string }>();
  await db.batch([
    db
      .prepare(
        'INSERT INTO page (id, title, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(id, title, userId, timestamp, timestamp),
    db
      .prepare('INSERT INTO page_body (page_id, markdown, updated_at) VALUES (?, ?, ?)')
      .bind(id, '', timestamp),
    db.prepare('DELETE FROM page_fts WHERE page_id = ?').bind(id),
    db.prepare('INSERT INTO page_fts (page_id, title, body) VALUES (?, ?, ?)').bind(id, title, ''),
  ]);
  return {
    id,
    title,
    createdAt: timestamp,
    createdByName: author?.display_name ?? '',
    excerpt: '',
    updatedAt: timestamp,
  };
}

export async function addPageAlias(db: D1Database, pageId: string, title: string): Promise<void> {
  await ensureSchema(db);
  const alias = title.trim();
  if (!alias) return;
  await db.prepare(UPSERT_PAGE_ALIAS).bind(alias, pageId, Date.now()).run();
}

export async function updatePageTitle(
  db: D1Database,
  pageId: string,
  title: string,
  previousTitle?: string,
): Promise<void> {
  await ensureSchema(db);
  const timestamp = Date.now();
  const previous = previousTitle?.trim() ?? '';
  const statements: D1PreparedStatement[] = [];
  if (previous && previous !== title) {
    statements.push(db.prepare(UPSERT_PAGE_ALIAS).bind(previous, pageId, timestamp));
  }
  statements.push(
    db
      .prepare('UPDATE page SET title = ?, updated_at = ? WHERE id = ?')
      .bind(title, timestamp, pageId),
    db.prepare('DELETE FROM page_fts WHERE page_id = ?').bind(pageId),
    db
      .prepare(
        `INSERT INTO page_fts (page_id, title, body)
         SELECT p.id, p.title, COALESCE(b.markdown, '') FROM page p
         LEFT JOIN page_body b ON b.page_id = p.id WHERE p.id = ?`,
      )
      .bind(pageId),
  );
  await db.batch(statements);
}

export async function softDeletePage(db: D1Database, pageId: string): Promise<void> {
  await ensureSchema(db);
  const timestamp = Date.now();
  await db.batch([
    db
      .prepare('UPDATE page SET deleted_at = ?, updated_at = ? WHERE id = ?')
      .bind(timestamp, timestamp, pageId),
    db.prepare('DELETE FROM page_fts WHERE page_id = ?').bind(pageId),
  ]);
}

export async function undeletePage(db: D1Database, pageId: string): Promise<boolean> {
  await ensureSchema(db);
  const timestamp = Date.now();
  const results = await db.batch([
    db
      .prepare(
        'UPDATE page SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL',
      )
      .bind(timestamp, pageId),
    db
      .prepare(
        `DELETE FROM page_fts WHERE page_id = ?
         AND EXISTS (SELECT 1 FROM page WHERE id = ? AND deleted_at IS NULL AND updated_at = ?)`,
      )
      .bind(pageId, pageId, timestamp),
    db
      .prepare(
        `INSERT INTO page_fts (page_id, title, body)
         SELECT p.id, p.title, COALESCE(b.markdown, '') FROM page p
         LEFT JOIN page_body b ON b.page_id = p.id
         WHERE p.id = ? AND p.deleted_at IS NULL AND p.updated_at = ?`,
      )
      .bind(pageId, timestamp),
  ]);
  return (results[0]?.meta.changes ?? 0) > 0;
}

export async function permanentlyDeletePage(db: D1Database, pageId: string): Promise<boolean> {
  await ensureSchema(db);
  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM revision WHERE page_id = ?
         AND EXISTS (SELECT 1 FROM page WHERE id = ? AND deleted_at IS NOT NULL)`,
      )
      .bind(pageId, pageId),
    db
      .prepare(
        `DELETE FROM page_fts WHERE page_id = ?
         AND EXISTS (SELECT 1 FROM page WHERE id = ? AND deleted_at IS NOT NULL)`,
      )
      .bind(pageId, pageId),
    db
      .prepare(
        `DELETE FROM page_body WHERE page_id = ?
         AND EXISTS (SELECT 1 FROM page WHERE id = ? AND deleted_at IS NOT NULL)`,
      )
      .bind(pageId, pageId),
    db.prepare('DELETE FROM page WHERE id = ? AND deleted_at IS NOT NULL').bind(pageId),
  ]);
  return (results[results.length - 1]?.meta.changes ?? 0) > 0;
}

export async function materializePage(
  db: D1Database,
  pageId: string,
  markdown: string,
): Promise<string> {
  await ensureSchema(db);
  const timestamp = Date.now();
  const page = await db
    .prepare('SELECT title FROM page WHERE id = ?')
    .bind(pageId)
    .first<{ title: string }>();
  const title = page?.title ?? 'Untitled';
  await db.batch([
    db
      .prepare(
        `INSERT INTO page_body (page_id, markdown, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(page_id) DO UPDATE SET markdown = excluded.markdown, updated_at = excluded.updated_at`,
      )
      .bind(pageId, markdown, timestamp),
    db.prepare('UPDATE page SET updated_at = ? WHERE id = ?').bind(timestamp, pageId),
    db.prepare('DELETE FROM page_fts WHERE page_id = ?').bind(pageId),
    db
      .prepare('INSERT INTO page_fts (page_id, title, body) VALUES (?, ?, ?)')
      .bind(pageId, title, markdown),
  ]);
  return title;
}

export async function createRevision(
  db: D1Database,
  pageId: string,
  markdown: string,
  authorId: string | null,
  manual: boolean,
): Promise<number> {
  await ensureSchema(db);
  const current = await db
    .prepare('SELECT COALESCE(MAX(version), 0) + 1 AS version FROM revision WHERE page_id = ?')
    .bind(pageId)
    .first<{ version: number }>();
  const version = current?.version ?? 1;
  await db.batch([
    db
      .prepare(
        'INSERT INTO revision (id, page_id, version, markdown, author_id, manual, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(uuid(), pageId, version, markdown, authorId, manual ? 1 : 0, Date.now()),
    db.prepare('UPDATE page SET updated_at = ? WHERE id = ?').bind(Date.now(), pageId),
  ]);
  return version;
}

export async function latestRevision(
  db: D1Database,
  pageId: string,
): Promise<RevisionRecord | null> {
  await ensureSchema(db);
  const row = await db
    .prepare('SELECT * FROM revision WHERE page_id = ? ORDER BY version DESC LIMIT 1')
    .bind(pageId)
    .first<RevisionRow>();
  return row ? toRevision(row) : null;
}

export async function getRevision(
  db: D1Database,
  pageId: string,
  version: number,
): Promise<RevisionRecord | null> {
  await ensureSchema(db);
  const row = await db
    .prepare('SELECT * FROM revision WHERE page_id = ? AND version = ?')
    .bind(pageId, version)
    .first<RevisionRow>();
  return row ? toRevision(row) : null;
}

export async function listRevisions(db: D1Database, pageId: string): Promise<RevisionRecord[]> {
  await ensureSchema(db);
  const result = await db
    .prepare('SELECT * FROM revision WHERE page_id = ? ORDER BY version DESC LIMIT 50')
    .bind(pageId)
    .all<RevisionRow>();
  return (result.results ?? []).map(toRevision);
}

function toRevision(row: RevisionRow): RevisionRecord {
  return {
    id: row.id,
    pageId: row.page_id,
    version: row.version,
    markdown: row.markdown,
    authorId: row.author_id,
    manual: row.manual,
    createdAt: row.created_at,
  };
}

export async function searchPages(db: D1Database, query: string): Promise<SearchResult[]> {
  await ensureSchema(db);
  const trimmed = query.trim();
  if (!trimmed) return [];

  if (Array.from(trimmed).length >= 3) {
    try {
      const match = `"${trimmed.replaceAll('"', '""')}"`;
      const result = await db
        .prepare(
          `SELECT f.page_id AS id, f.title AS title,
                  snippet(page_fts, 2, '', '', '…', 16) AS excerpt,
                  p.updated_at AS updated_at
           FROM page_fts f JOIN page p ON p.id = f.page_id
           WHERE page_fts MATCH ? AND p.deleted_at IS NULL
           ORDER BY rank LIMIT 20`,
        )
        .bind(match)
        .all<SearchRow>();
      return (result.results ?? []).map(toSearchResult);
    } catch {
      // Fall through to LIKE for stores without a usable FTS tokenizer.
    }
  }

  const like = `%${trimmed}%`;
  const result = await db
    .prepare(
      `SELECT p.id, p.title,
              substr(COALESCE(b.markdown, ''), 1, ${EXCERPT_SOURCE_LENGTH}) AS excerpt,
              p.updated_at AS updated_at
       FROM page p LEFT JOIN page_body b ON b.page_id = p.id
       WHERE p.deleted_at IS NULL AND (p.title LIKE ? OR b.markdown LIKE ?)
       ORDER BY p.updated_at DESC LIMIT 20`,
    )
    .bind(like, like)
    .all<SearchRow>();
  return (result.results ?? []).map(toSearchResult);
}

function toSearchResult(row: SearchRow): SearchResult {
  return {
    id: row.id,
    title: row.title,
    excerpt: excerptFromMarkdown(row.excerpt ?? ''),
    updatedAt: row.updated_at,
  };
}

export async function recordAudit(
  db: D1Database,
  actorId: string | null,
  action: string,
  targetType: string,
  targetId: string | null,
): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare(
      'INSERT INTO audit_event (id, actor_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(uuid(), actorId, action, targetType, targetId, Date.now())
    .run();
}
