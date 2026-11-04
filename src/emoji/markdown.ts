import type { CustomEmoji } from './client';
import type { WikiNode } from '../markdown/wiki';
import { maskCode } from '../markdown/wiki';
export function remarkEmojis({
  emojis,
  shortcodes = {},
}: {
  emojis: CustomEmoji[];
  shortcodes?: Record<string, string>;
}) {
  const names = new Map<string, CustomEmoji>();
  for (const emoji of emojis)
    for (const name of [emoji.name, ...emoji.aliases]) names.set(name, emoji);
  return (tree: WikiNode) => {
    function walk(node: WikiNode) {
      if (
        [
          'code',
          'inlineCode',
          'link',
          'linkReference',
          'image',
          'imageReference',
          'html',
          'definition',
        ].includes(node.type ?? '')
      )
        return;
      node.children = node.children?.flatMap((child) => {
        if (child.type !== 'text' || typeof child.value !== 'string') {
          walk(child);
          return [child];
        }
        const parts: WikiNode[] = [];
        let last = 0;
        for (const match of child.value.matchAll(/:([^:\r\n]{1,100}):/gu)) {
          const emoji = names.get(match[1]);
          const unicode = Object.hasOwn(shortcodes, match[1]) ? shortcodes[match[1]] : undefined;
          if (!emoji && !unicode) continue;
          if (match.index > last)
            parts.push({ type: 'text', value: child.value.slice(last, match.index) });
          parts.push(
            emoji
              ? { type: 'image', url: emoji.image_url, alt: match[0] }
              : { type: 'text', value: unicode! },
          );
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
export function emojiCompletion(
  markdown: string,
  pos: number,
  emojis: CustomEmoji[],
  shortcodes: Record<string, string> = {},
) {
  const before = maskCode(markdown).slice(0, pos);
  const match = /(?:^|[\s(])(:([^:\s]{0,100}))$/u.exec(before);
  if (!match) return null;
  return {
    from: pos - match[1].length,
    to: markdown[pos] === ':' ? pos + 1 : pos,
    filter: false,
    options: [
      ...emojis
        .filter((e) => [e.name, ...e.aliases].some((n) => n.includes(match[2])))
        .map((e) => ({
          label: `:${e.name}:`,
          detail: [e.category, ...e.aliases].filter(Boolean).join(' · '),
          apply: `:${e.name}:`,
          type: 'text',
        })),
      ...Object.entries(shortcodes)
        .filter(
          ([name]) =>
            name.includes(match[2]) &&
            !emojis.some((e) => e.name === name || e.aliases.includes(name)),
        )
        .slice(0, 100)
        .map(([name, unicode]) => ({
          label: `:${name}:`,
          detail: unicode,
          apply: `:${name}:`,
          type: 'text',
        })),
    ],
  };
}
