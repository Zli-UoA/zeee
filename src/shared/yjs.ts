import * as Y from 'yjs';

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
