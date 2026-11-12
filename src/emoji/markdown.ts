import type { CustomEmoji } from './client';
import type { WikiNode } from '../markdown/wiki';
import { maskCode } from '../markdown/wiki';
import type { AccountProfile } from './accountsClient';
export function remarkEmojis({
  emojis,
  shortcodes = {},
  accounts = [],
}: {
  emojis: CustomEmoji[];
  shortcodes?: Record<string, string>;
  accounts?: readonly AccountProfile[];
}) {
  const profiles = new Map(accounts.map((profile) => [profile.username, profile]));
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
        for (const match of child.value.matchAll(
          /:@([a-z0-9._-]{1,80}):|:([^:\r\n]{1,100}):|(?<![a-zA-Z0-9._%+/@:-])@([a-z0-9._-]{1,80})/gu,
        )) {
          const accountName = match[1] ?? match[3];
          const profile =
            accountName &&
            (profiles.get(accountName) ??
              (match[3] ? profiles.get(accountName.replace(/\.+$/, '')) : undefined));
          const name = match[2];
          const emoji = name && names.get(name);
          const unicode = name && Object.hasOwn(shortcodes, name) ? shortcodes[name] : undefined;
          if (!emoji && !unicode && !profile) continue;
          if (match.index > last)
            parts.push({ type: 'text', value: child.value.slice(last, match.index) });
          parts.push(
            profile
              ? {
                  type: 'text',
                  value: match[0],
                  data: {
                    hName: 'span',
                    hProperties: {
                      dataAuthzAccount: profile.username,
                      dataAccountIcon: Boolean(match[1]).toString(),
                    },
                  },
                }
              : emoji
                ? { type: 'image', url: emoji.image_url, alt: match[0] }
                : { type: 'text', value: unicode! },
          );
          last =
            match.index + (profile && match[3] ? profile.username.length + 1 : match[0].length);
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
  accounts: readonly AccountProfile[] = [],
) {
  const before = maskCode(markdown).slice(0, pos);
  const match = /(?:^|[\s(])(:([^:\s]{0,100}))$/u.exec(before);
  if (!match) return null;
  return {
    from: pos - match[1].length,
    to: markdown[pos] === ':' ? pos + 1 : pos,
    filter: false,
    options: [
      ...accounts
        .filter((account) => `@${account.username} ${account.display_name}`.includes(match[2]))
        .slice(0, 100)
        .map((account) => ({
          label: `:@${account.username}:`,
          detail: account.display_name,
          apply: `:@${account.username}:`,
          type: 'text',
        })),
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
