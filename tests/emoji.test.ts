import { describe, expect, it } from 'vite-plus/test';
import { remarkEmojis, emojiCompletion } from '../src/emoji/markdown';
import type { WikiNode } from '../src/markdown/wiki';
const emojis = [
  {
    id: 'cat',
    name: 'cat',
    aliases: ['neko', 'ねこ'],
    category: 'animals',
    image_url: 'https://emoji.test/images/' + 'a'.repeat(64),
    version: 1,
    updated_at: '',
  },
];
describe('shared custom emoji', () => {
  it('replaces known names and aliases only in ordinary text nodes', () => {
    const tree: WikiNode = {
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'text', value: ':cat: :neko: :unknown:' }] },
        { type: 'code', value: ':cat:' },
        { type: 'inlineCode', value: ':cat:' },
        {
          type: 'link',
          url: 'https://example.test/:cat:',
          children: [{ type: 'text', value: ':cat:' }],
        },
      ],
    };
    remarkEmojis({ emojis })(tree);
    expect(tree.children?.[0].children?.filter((n) => n.type === 'image')).toHaveLength(2);
    expect(tree.children?.[0].children?.at(-1)?.value).toBe(' :unknown:');
    expect(tree.children?.[1].value).toBe(':cat:');
    expect(tree.children?.[3].children?.[0].value).toBe(':cat:');
  });
  it('completes aliases and avoids code blocks', () => {
    expect(emojiCompletion(':ne', 3, emojis)?.options[0].apply).toBe(':cat:');
    expect(emojiCompletion(':ね', 2, emojis)?.options[0].apply).toBe(':cat:');
    expect(emojiCompletion('`:ne`', 4, emojis)).toBeNull();
    expect(emojiCompletion('```\n:ne', 7, emojis)).toBeNull();
    expect(emojiCompletion(':ne:', 3, emojis)?.to).toBe(4);
  });
});
