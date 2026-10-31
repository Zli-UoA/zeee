import { excerptFromMarkdown } from './db';
import { findWikiReference, wikiPlainText } from '../markdown/wiki';

export type Backlink = {
  id: string;
  title: string;
  excerpt: string;
  authorName: string;
  updatedAt: number;
};

type BacklinkRow = {
  id: string;
  title: string;
  author_name: string | null;
  updated_at: number;
  markdown: string | null;
};

const CANDIDATE_LIMIT = 50;
const RESULT_LIMIT = 20;
const EXCERPT_CONTEXT = 80;
const EXCERPT_LENGTH = 160;

export async function listBacklinks(db: D1Database, pageId: string): Promise<Backlink[]> {
  const target = await db
    .prepare('SELECT title FROM page WHERE id = ? AND deleted_at IS NULL')
    .bind(pageId)
    .first<{ title: string }>();
  const title = target?.title?.trim();
  if (!title) return [];

  const like = `%[[%${escapeLike(title)}%`;
  const result = await db
    .prepare(
      `SELECT p.id, p.title, p.updated_at, u.display_name AS author_name,
              COALESCE(b.markdown, '') AS markdown
       FROM page p
       JOIN page_body b ON b.page_id = p.id
       LEFT JOIN app_user u ON u.id = p.created_by
       WHERE p.deleted_at IS NULL AND p.id <> ?
         AND b.markdown LIKE ? ESCAPE '\\'
       ORDER BY p.updated_at DESC, p.id ASC
       LIMIT ${CANDIDATE_LIMIT}`,
    )
    .bind(pageId, like)
    .all<BacklinkRow>();

  const backlinks: Backlink[] = [];
  for (const row of result.results ?? []) {
    const markdown = row.markdown ?? '';
    const reference = findWikiReference(markdown, title);
    if (!reference) continue;
    backlinks.push({
      id: row.id,
      title: row.title,
      excerpt: excerptAround(markdown, reference),
      authorName: row.author_name ?? '',
      updatedAt: row.updated_at,
    });
    if (backlinks.length >= RESULT_LIMIT) break;
  }
  return backlinks;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function excerptAround(markdown: string, reference: { index: number; length: number }): string {
  const start = Math.max(0, reference.index - EXCERPT_CONTEXT);
  const end = Math.min(markdown.length, reference.index + reference.length + EXCERPT_CONTEXT);
  const text = excerptFromMarkdown(wikiPlainText(markdown.slice(start, end)), EXCERPT_LENGTH);
  return `${start > 0 ? '…' : ''}${text}${end < markdown.length ? '…' : ''}`;
}
