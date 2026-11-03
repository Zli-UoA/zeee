import type { CustomEmoji } from './client';
import type { WikiNode } from '../markdown/wiki';
import { maskCode } from '../markdown/wiki';
export function remarkEmojis({ emojis }: { emojis: CustomEmoji[] }) {
  const names = new Map<string, CustomEmoji>();
  for (const emoji of emojis)
    for (const name of [emoji.name, ...emoji.aliases]) names.set(name, emoji);
  return (tree: WikiNode) => {
    function walk(node: WikiNode) {
      if (['code', 'inlineCode', 'link', 'image', 'html', 'definition'].includes(node.type ?? ''))
        return;
      node.children = node.children?.flatMap((child) => {
        if (child.type !== 'text' || typeof child.value !== 'string') {
          walk(child);
          return [child];
        }
        const parts: WikiNode[] = [];
        let last = 0;
        for (const match of child.value.matchAll(/:([a-z0-9_-]{1,64}):/g)) {
          const emoji = names.get(match[1]);
          if (!emoji) continue;
          if (match.index > last)
            parts.push({ type: 'text', value: child.value.slice(last, match.index) });
          parts.push({ type: 'image', url: emoji.image_url, alt: match[0] });
          last = match.index + match[0].length;
        }
        if (!last) return [child];
        if (last < child.value.length) parts.push({ type: 'text', value: child.value.slice(last) });
        return parts;
      });
    }
    walk(tree);
  };
}
export function emojiCompletion(markdown: string, pos: number, emojis: CustomEmoji[]) {
  const before = maskCode(markdown).slice(0, pos);
  const match = /(?:^|[\s(])(:([a-z0-9_-]{0,64}))$/.exec(before);
  if (!match) return null;
  return {
    from: pos - match[1].length,
    to: markdown[pos] === ':' ? pos + 1 : pos,
    filter: false,
    options: emojis
      .filter((e) => [e.name, ...e.aliases].some((n) => n.includes(match[2])))
      .map((e) => ({
        label: `:${e.name}:`,
        detail: [e.category, ...e.aliases].filter(Boolean).join(' · '),
        apply: `:${e.name}:`,
        type: 'text',
      })),
  };
}
