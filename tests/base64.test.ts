import { describe, expect, it } from 'vite-plus/test';
import { decodeBase64, encodeBase64 } from '../src/shared/base64';

describe('base64', () => {
  it('round trips UTF-8 bytes', () => {
    const source = 'Zeee 共同編集';
    const bytes = new TextEncoder().encode(source);
    const decoded = new TextDecoder().decode(decodeBase64(encodeBase64(bytes)));
    expect(decoded).toBe(source);
  });
});
