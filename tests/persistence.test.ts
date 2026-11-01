import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { PendingUpdateStore, type StoredUpdate } from '../src/client/persistence';

const entry = (id: string): StoredUpdate => ({
  id,
  sessionId: 'session-1',
  scope: ['user-1', 'page-1'],
  update: id,
});

beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('PendingUpdateStore transactions', () => {
  it('rolls back the outbox row when the checkpoint transaction aborts', async () => {
    const store = new PendingUpdateStore('user-1', 'page-1');
    // The original method is explicitly bound with call below.
    // oxlint-disable-next-line typescript/unbound-method
    const original = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value,
      key,
    ) {
      if (this.name === 'checkpoints') {
        this.transaction.abort();
        throw new Error('checkpoint failed');
      }
      return original.call(this, value, key);
    });
    await expect(store.put(entry('one'), new Uint8Array([1]))).rejects.toThrow('checkpoint failed');
    put.mockRestore();
    expect(await store.load()).toEqual({ updates: [], states: [] });
  });

  it('retains the latest checkpoint until the last row is removed, tolerating duplicate cleanup', async () => {
    const store = new PendingUpdateStore('user-1', 'page-1');
    await store.put(entry('one'), new Uint8Array([1]));
    await store.put(entry('two'), new Uint8Array([1, 2]));
    await Promise.all([store.remove(entry('one')), store.remove(entry('one'))]);
    expect(await store.load()).toEqual({
      updates: [entry('two')],
      states: [new Uint8Array([1, 2])],
    });
    await store.remove(entry('two'));
    expect(await store.load()).toEqual({ updates: [], states: [] });
  });
});
