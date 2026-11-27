import { describe, expect, it } from 'vite-plus/test';
import { MAX_STATE_IMPORT_BYTES, PayloadTooLargeError, readBoundedBytes } from '../src/shared/yjs';

describe('readBoundedBytes', () => {
  it('caps the stream before it buffers more than the limit', async () => {
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    await expect(readBoundedBytes(body, 2048)).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(chunks).toBeLessThanOrEqual(4);
  });

  it('gives up on a stalled body when the signal aborts', async () => {
    const controller = new AbortController();
    // A body that never produces a chunk models a client that stopped sending.
    const body = new ReadableStream<Uint8Array>({ start() {} });
    const reading = readBoundedBytes(body, MAX_STATE_IMPORT_BYTES, controller.signal);
    controller.abort();
    await expect(reading).rejects.toThrow();
  });
});
