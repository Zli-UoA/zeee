import { maskCode, type LinkTarget } from './wiki';

export type WikiCompletionContext = {
  from: number;
  query: string;
};

export type WikiCompletionCandidate = {
  title: string;
  aliases: string[];
  updatedAt: number;
  matchedAlias?: string;
};

const CLOSING_WIKI_LINK = /^\]\]/;
const INVALID_QUERY = /[[\]|\n]/;

export function findWikiCompletionContext(
  markdown: string,
  pos: number,
): WikiCompletionContext | null {
  if (pos < 0 || pos > markdown.length) return null;

  const lineStart = markdown.lastIndexOf('\n', pos - 1) + 1;
  const rawLine = markdown.slice(lineStart, pos);
  if (!rawLine.includes('[[')) return null;

  const masked = maskCode(markdown);
  const maskedLine = masked.slice(lineStart, pos);
  const open = maskedLine.lastIndexOf('[[');
  if (open === -1 || maskedLine[open - 1] === '[') return null;

  const query = markdown.slice(lineStart + open + 2, pos);
  if (INVALID_QUERY.test(query)) return null;

  return { from: lineStart + open, query };
}

export function wikiCompletionTo(markdown: string, pos: number): number {
  return CLOSING_WIKI_LINK.test(markdown.slice(pos, pos + 2)) ? pos + 2 : pos;
}

export function wikiCompletionText(title: string): string {
  return `[[${title}]]`;
}

export function uniqueWikiTargets(targets: LinkTarget[]): LinkTarget[] {
  const byTitle = new Map<string, LinkTarget>();
  for (const target of targets) {
    const title = target.title.trim();
    if (!title) continue;
    const normalized: LinkTarget = {
      ...target,
      title,
      aliases: target.aliases.map((alias) => alias.trim()).filter(Boolean),
    };
    const current = byTitle.get(title);
    if (!current || normalized.updatedAt > current.updatedAt) byTitle.set(title, normalized);
  }
  return [...byTitle.values()];
}

export function filterWikiCompletions(
  targets: LinkTarget[],
  query: string,
): WikiCompletionCandidate[] {
  const needle = query.trim().toLocaleLowerCase();
  const candidates: WikiCompletionCandidate[] = [];

  for (const target of uniqueWikiTargets(targets)) {
    const titleMatches = target.title.toLocaleLowerCase().includes(needle);
    const matchedAlias = needle
      ? target.aliases.find((alias) => alias.toLocaleLowerCase().includes(needle))
      : undefined;
    if (!titleMatches && !matchedAlias) continue;
    candidates.push({
      ...target,
      matchedAlias: titleMatches ? undefined : matchedAlias,
    });
  }

  return candidates;
}
