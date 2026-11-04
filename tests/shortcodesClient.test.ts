import { expect, it } from 'vite-plus/test';
import { ShortcodeClient } from '../src/emoji/shortcodesClient';
it('coalesces and revalidates the standard catalog and retains the last valid dictionary', async () => {
  let calls = 0,
    mode = 'ok';
  const client = new ShortcodeClient('https://emoji.test', async (url, options) => {
    calls++;
    expect(url).toBe('https://emoji.test/api/v1/shortcodes');
    if (mode === '304') {
      expect(new Headers(options?.headers).get('If-None-Match')).toBe('"v1"');
      return new Response(null, { status: 304 });
    }
    if (mode === 'fail') throw Error('offline');
    if (mode === 'invalid') return Response.json({ shortcodes: { smile: 7 } });
    return Response.json(
      { shortcodes: { '+1': '👍', woman_technologist: '👩‍💻' }, source: { license: 'MIT' } },
      { headers: { etag: '"v1"' } },
    );
  });
  const [a, b] = await Promise.all([client.list(), client.list()]);
  expect(client.source).toEqual({ license: 'MIT' });
  expect(calls).toBe(1);
  expect(a).toEqual(b);
  a['+1'] = 'bad';
  expect((await client.list())['+1']).toBe('👍');
  mode = '304';
  expect((await client.list(true))['+1']).toBe('👍');
  mode = 'invalid';
  expect((await client.list(true))['+1']).toBe('👍');
  mode = 'fail';
  expect((await client.list(true)).woman_technologist).toBe('👩‍💻');
  const empty = new ShortcodeClient('https://emoji.test', async () => {
    throw Error('offline');
  });
  await expect(empty.list()).rejects.toThrow('offline');
});
