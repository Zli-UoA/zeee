export type HighlightPart = {
  text: string;
  match: boolean;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function splitHighlight(text: string, query: string): HighlightPart[] {
  const terms = Array.from(new Set(query.trim().split(/\s+/).filter(Boolean))).sort(
    (a, b) => b.length - a.length,
  );
  if (!text || terms.length === 0) return [{ text, match: false }];

  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi');
  const parts: HighlightPart[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push({ text: text.slice(lastIndex, index), match: false });
    if (match[0]) parts.push({ text: match[0], match: true });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) parts.push({ text: text.slice(lastIndex), match: false });
  return parts.length > 0 ? parts : [{ text, match: false }];
}
