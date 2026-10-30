import { describe, expect, it } from 'vite-plus/test';
import { formatDate } from '../src/shared/format';

describe('formatDate', () => {
  it('formats in Asia/Tokyo', () => {
    expect(formatDate(Date.UTC(2026, 0, 2, 3, 4))).toContain('2026');
  });
});
