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

it('renders gemoji Unicode after custom resolution and preserves code and links', () => {
  const tree: WikiNode = {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [{ type: 'text', value: ':cat: :+1: :woman_technologist: :unknown:' }],
      },
      { type: 'inlineCode', value: ':+1:' },
      {
        type: 'link',
        url: 'https://example.test/:+1:',
        children: [{ type: 'text', value: ':+1:' }],
      },
    ],
  };
  const shortcodes = { cat: '🐈', '+1': '👍', woman_technologist: '👩‍💻' };
  remarkEmojis({ emojis, shortcodes })(tree);
  const nodes = tree.children![0].children!;
  expect(nodes.find((n) => n.type === 'image')?.url).toBe(emojis[0].image_url);
  expect(
    nodes
      .filter((n) => n.type === 'text')
      .map((n) => n.value)
      .join(''),
  ).toBe(' 👍 👩‍💻 :unknown:');
  expect(tree.children![1].value).toBe(':+1:');
  expect(tree.children![2].children![0].value).toBe(':+1:');
  expect(
    emojiCompletion(':cat', 4, emojis, shortcodes)?.options.filter((e) => e.label === ':cat:'),
  ).toHaveLength(1);
  expect(emojiCompletion(':+', 2, emojis, shortcodes)?.options[0].apply).toBe(':+1:');
  expect(emojiCompletion('`:+`', 3, emojis, shortcodes)).toBeNull();
});
