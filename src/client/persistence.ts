export type StoredUpdate = {
  id: string;
  sessionId: string;
  scope: [string, string];
  update: string;
};

type Checkpoint = { sessionId: string; scope: [string, string]; state: Uint8Array };

const DATABASE = 'zeee-pending-updates';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      const updates = request.result.createObjectStore('updates', { keyPath: 'id' });
      updates.createIndex('scope', 'scope');
      updates.createIndex('sessionId', 'sessionId');
      const checkpoints = request.result.createObjectStore('checkpoints', { keyPath: 'sessionId' });
      checkpoints.createIndex('scope', 'scope');
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error('IndexedDB upgrade is blocked'));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) {
        db.close();
        return;
      }
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error);
  });
}

/** Only individual acknowledged rows are removed, including when several tabs replay the same rows. */
export class PendingUpdateStore {
  private readonly scope: [string, string];

  constructor(userId: string, pageId: string) {
    this.scope = [userId, pageId];
  }

  async load(): Promise<{ updates: StoredUpdate[]; states: Uint8Array[] }> {
    const db = await openDatabase();
    try {
      const transaction = db.transaction(['updates', 'checkpoints'], 'readonly');
      const updates = transaction.objectStore('updates').index('scope').getAll(this.scope);
      const checkpoints = transaction.objectStore('checkpoints').index('scope').getAll(this.scope);
      await completed(transaction);
      return {
        updates: updates.result as StoredUpdate[],
        states: (checkpoints.result as Checkpoint[]).map((checkpoint) => checkpoint.state),
      };
    } finally {
      db.close();
    }
  }

  async put(update: StoredUpdate, state: Uint8Array): Promise<void> {
    const db = await openDatabase();
    try {
      const transaction = db.transaction(['updates', 'checkpoints'], 'readwrite', {
        durability: 'strict',
      });
      transaction.objectStore('updates').put({ ...update, scope: this.scope });
      // The checkpoint retains dependencies from already acknowledged edits and remote updates.
      transaction.objectStore('checkpoints').put({
        sessionId: update.sessionId,
        scope: this.scope,
        state,
      } satisfies Checkpoint);
      await completed(transaction);
    } finally {
      db.close();
    }
  }

  async remove(update: StoredUpdate): Promise<void> {
    const db = await openDatabase();
    try {
      const transaction = db.transaction(['updates', 'checkpoints'], 'readwrite', {
        durability: 'strict',
      });
      const updates = transaction.objectStore('updates');
      updates.delete(update.id);
      const remaining = updates.index('sessionId').count(update.sessionId);
      remaining.onsuccess = () => {
        if (remaining.result === 0) transaction.objectStore('checkpoints').delete(update.sessionId);
      };
      await completed(transaction);
    } finally {
      db.close();
    }
  }
}
