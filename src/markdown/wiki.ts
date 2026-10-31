export type LinkTarget = {
  id: string;
  title: string;
  updatedAt: number;
  aliases: string[];
};

export type WikiLinkPage = LinkTarget;

export type WikiTextSegment =
  | { type: 'text'; value: string }
  | { type: 'wiki'; title: string; label: string; target: WikiLinkPage | null };

export type WikiNode = {
  type?: string;
  value?: string;
  url?: string;
  data?: { hProperties?: Record<string, unknown> };
  children?: WikiNode[];
  [key: string]: unknown;
};

const WIKI_LINK_PATTERN = /\[\[([^[\]\n]+?)\]\]/g;
const SKIPPED_CONTAINERS = new Set(['code', 'inlineCode', 'link', 'image', 'html', 'definition']);
const WIKI_LINK_PLACEHOLDER = /\[\[([^[\]\n|]+)(?:\|([^[\]\n]*))?\]\]/g;

export function parseWikiLinkInner(inner: string): { title: string; label: string } | null {
  const separator = inner.indexOf('|');
  const title = (separator === -1 ? inner : inner.slice(0, separator)).trim();
  if (!title) return null;
  const label = (separator === -1 ? title : inner.slice(separator + 1).trim()) || title;
  return { title, label };
}

export function createWikiResolver(pages: WikiLinkPage[]): (title: string) => WikiLinkPage | null {
  const byTitle = new Map<string, WikiLinkPage>();
  const byAlias = new Map<string, WikiLinkPage>();

  for (const page of pages) {
    const title = page.title.trim();
    if (title) {
      const current = byTitle.get(title);
      if (!current || page.updatedAt > current.updatedAt) byTitle.set(title, page);
    }
    for (const value of page.aliases ?? []) {
      const alias = value.trim();
      if (!alias) continue;
      const current = byAlias.get(alias);
      if (!current || page.updatedAt > current.updatedAt) byAlias.set(alias, page);
    }
  }

  return (title) => {
    const key = title.trim();
    return byTitle.get(key) ?? byAlias.get(key) ?? null;
  };
}

export function splitWikiText(
  value: string,
  resolve: (title: string) => WikiLinkPage | null,
): WikiTextSegment[] {
  const segments: WikiTextSegment[] = [];
  let lastIndex = 0;

  for (const match of value.matchAll(WIKI_LINK_PATTERN)) {
    const index = match.index ?? 0;
    const parsed = parseWikiLinkInner(match[1]);
    if (!parsed) continue;
    if (index > lastIndex) segments.push({ type: 'text', value: value.slice(lastIndex, index) });
    segments.push({ ...parsed, type: 'wiki', target: resolve(parsed.title) });
    lastIndex = index + match[0].length;
  }

  if (lastIndex === 0) return [{ type: 'text', value }];
  if (lastIndex < value.length) segments.push({ type: 'text', value: value.slice(lastIndex) });
  return segments;
}

export function transformWikiLinks(
  tree: WikiNode,
  resolve: (title: string) => WikiLinkPage | null,
): void {
  function visit(node: WikiNode) {
    if (!node.children) return;
    const next: WikiNode[] = [];
    for (const child of node.children) {
      if (child.type === 'text' && typeof child.value === 'string') {
        const segments = splitWikiText(child.value, resolve);
        if (segments.length === 1 && segments[0].type === 'text') {
          next.push(child);
          continue;
        }
        for (const segment of segments) {
          if (segment.type === 'text') next.push({ type: 'text', value: segment.value });
          else next.push(toWikiLinkNode(segment));
        }
        continue;
      }
      if (!SKIPPED_CONTAINERS.has(child.type ?? '')) visit(child);
      next.push(child);
    }
    node.children = next;
  }

  visit(tree);
}

function toWikiLinkNode(segment: Extract<WikiTextSegment, { type: 'wiki' }>): WikiNode {
  return {
    type: 'link',
    url: segment.target ? `/pages/${encodeURIComponent(segment.target.id)}` : '#',
    data: {
      hProperties: {
        dataWikiState: segment.target ? 'resolved' : 'missing',
        dataWikiTitle: segment.title,
      },
    },
    children: [{ type: 'text', value: segment.label }],
  };
}

export function remarkWikiLinks(options: { resolve: (title: string) => WikiLinkPage | null }) {
  return (tree: WikiNode) => transformWikiLinks(tree, options.resolve);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function maskCode(markdown: string): string {
  const lines = markdown.split('\n');
  let fence: { char: string; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (closing && closing[1][0] === fence.char && closing[1].length >= fence.length) {
        fence = null;
      }
      lines[index] = ' '.repeat(line.length);
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) {
      fence = { char: opening[1][0], length: opening[1].length };
      lines[index] = ' '.repeat(line.length);
    }
  }

  return lines.join('\n').replace(/(`+)([\s\S]*?)\1/g, (match) => match.replace(/[^\n]/g, ' '));
}

export function findWikiReference(
  markdown: string,
  title: string,
): { index: number; length: number } | null {
  if (!title.trim()) return null;
  const pattern = new RegExp(
    `\\[\\[[ \\t]*${escapeRegExp(title)}(?:[ \\t]*\\|[^[\\]\\n]*)?[ \\t]*\\]\\]`,
  );
  const match = pattern.exec(maskCode(markdown));
  return match ? { index: match.index, length: match[0].length } : null;
}

export function containsWikiLink(markdown: string, title: string): boolean {
  return findWikiReference(markdown, title) !== null;
}

export function wikiPlainText(value: string): string {
  return value.replace(WIKI_LINK_PLACEHOLDER, (_match, title: string, label?: string) => {
    return (label?.trim() || title.trim()) ?? '';
  });
}
