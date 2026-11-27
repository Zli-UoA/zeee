import * as Y from 'yjs';

/** Upper bound for migration-only raw state imports (GET /state bytes). */
export const MAX_STATE_IMPORT_BYTES = 5 * 1024 * 1024;

/** Give up on a stalled import body instead of holding its buffer indefinitely. */
export const STATE_IMPORT_TIMEOUT_MS = 30_000;

/** A body exceeded MAX_STATE_IMPORT_BYTES; callers map this to HTTP 413. */
export class PayloadTooLargeError extends Error {
  constructor() {
    super('state is too large');
    this.name = 'PayloadTooLargeError';
  }
}

/**
 * Some runtimes ignore the `signal` option on reader.read(), so race the read
 * explicitly. The caller cancels the reader on failure, settling a pending
 * read before releasing the lock.
 */
function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const read = reader.read();
  if (!signal) return read;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('Aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    read.then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Read a body incrementally so an oversized stream is aborted as soon as the
 * limit is crossed instead of buffering all of it before returning 413.
 */
export async function readBoundedBytes(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number = MAX_STATE_IMPORT_BYTES,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      // A stalled client must not keep the partially buffered state alive.
      const { done, value } = await readChunk(reader, signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new PayloadTooLargeError();
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** State vectors alone cannot establish whether a delete-only update was applied. */
export function containsUpdate(doc: Y.Doc, update: Uint8Array): boolean {
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateAsUpdate(copy);
    Y.applyUpdate(copy, update);
    const after = Y.encodeStateAsUpdate(copy);
    return before.length === after.length && before.every((byte, index) => byte === after[index]);
  } finally {
    copy.destroy();
  }
}
