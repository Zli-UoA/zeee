export function slugifyHeading(text: string): string {
  const slug = text
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[^\p{L}\p{N}_-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

export function createHeadingSlugger(): (text: string) => string {
  const used = new Set<string>();
  return (text: string) => {
    const base = slugifyHeading(text);
    let slug = base;
    let count = 2;
    while (used.has(slug)) {
      slug = `${base}-${count}`;
      count += 1;
    }
    used.add(slug);
    return slug;
  };
}

export type HeadingNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HeadingNode[];
  [key: string]: unknown;
};

export function transformHeadings(tree: HeadingNode): void {
  const slugger = createHeadingSlugger();

  function visit(node: HeadingNode) {
    if (!node.children) return;
    for (const child of node.children) {
      if (typeof child.tagName === 'string' && /^h[1-6]$/.test(child.tagName)) {
        if (child.tagName === 'h1') child.tagName = 'h2';
        const text = textContent(child).trim();
        const id = slugger(text);
        child.properties = { ...child.properties, id };
      }
      visit(child);
    }
  }

  visit(tree);
}

function textContent(node: HeadingNode): string {
  let text = typeof node.value === 'string' ? node.value : '';
  for (const child of node.children ?? []) text += textContent(child);
  return text;
}

export function rehypeHeadings() {
  return (tree: HeadingNode) => transformHeadings(tree);
}
