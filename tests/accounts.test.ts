import { expect, it, vi } from 'vite-plus/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountClient } from '../src/emoji/accountsClient';
const accounts = [
  {
    username: 'alice',
    display_name: 'AuthZ名',
    avatar_url: 'https://emoji.test/api/v1/account-images/' + 'a'.repeat(64),
  },
];
vi.mock('../src/emoji/useEmojis', () => ({
  useEmojis: () => ({ emojis: [], shortcodes: {}, accounts }),
}));
import { MarkdownView } from '../src/components/MarkdownView';
it('sanitized Markdown renders only AuthZ accounts, preserving unknown names, links and code', () => {
  const html = renderToStaticMarkup(
    createElement(MarkdownView, {
      markdown:
        ':@alice: @alice. :@unknown: @unknown `:@alice: @alice` [@alice](https://example.test)',
      pages: [],
      pageId: 'fixture',
      pageTitle: 'fixture',
      sidePanel: false,
      sidePanelOpen: false,
    }),
  );
  expect(html).toContain('aria-label=":@alice:"');
  expect(html).toContain('AuthZ名');
  expect(html).toContain(accounts[0].avatar_url);
  expect(html).toContain(':@unknown: @unknown');
  expect(html).toContain('<code>:@alice: @alice</code>');
  expect(html).toContain('>@alice</a>');
});
it('the private directory client coalesces requests, validates image URLs and clears profiles on failure', async () => {
  let calls = 0;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100000);
  const client = new AccountClient('http://emoji:3001/accounts', 'https://emoji.test', async () => {
    calls++;
    return Response.json({
      accounts:
        calls === 1 ? accounts : [{ ...accounts[0], avatar_url: 'https://untrusted.test/avatar' }],
    });
  });
  try {
    const [a, b] = await Promise.all([client.list(), client.list()]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    a[0].display_name = 'app profile';
    expect((await client.list())[0].display_name).toBe('AuthZ名');
    clock.mockReturnValue(161000);
    expect(await client.list()).toEqual([]);
  } finally {
    clock.mockRestore();
  }
});
