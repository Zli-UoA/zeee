import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { decodeBase64, encodeBase64 } from '../shared/base64';
import { containsUpdate } from '../shared/yjs';
import { PendingUpdateStore, type StoredUpdate } from './persistence';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';

export type SaveStatus = {
  state: 'saved' | 'saving' | 'unsent' | 'failed';
  pending: number;
};

export type Collaborator = {
  name: string;
  color: string;
};

type AwarenessUser = Collaborator;

type AwarenessChange = {
  added: number[];
  updated: number[];
  removed: number[];
};

type ServerMessage = {
  type?: 'sync' | 'update' | 'awareness' | 'ack' | 'nack';
  update?: string;
  clientSeq?: number;
};

type PendingUpdate = {
  stored: StoredUpdate;
  state?: Uint8Array;
  durable: boolean;
  acknowledged: boolean;
  busy: boolean;
  failed: boolean;
};

export class ZeeeProvider {
  private socket: WebSocket | null = null;
  private closed = false;
  private connection: ConnectionStatus = 'connecting';
  private reconnectDelay = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pending = new Map<number, PendingUpdate>();
  private nextClientSeq = 1;
  private readonly store: PendingUpdateStore;
  private readonly sessionId = crypto.randomUUID();
  private remoteDoc = new Y.Doc();
  private readonly sent = new Set<number>();
  private synced = false;
  private initialized = false;
  private initializing = false;
  private initializationFailed = false;
  readonly ready: Promise<void>;
  private readonly updateHandler: (update: Uint8Array, origin: unknown) => void;
  private readonly awarenessHandler: (change: AwarenessChange) => void;

  constructor(
    private readonly pageId: string,
    private readonly doc: Y.Doc,
    private readonly awareness: Awareness,
    private readonly seed: boolean | string,
    private readonly onStatus: (status: ConnectionStatus) => void,
    private readonly onUsers: (users: Collaborator[]) => void,
    private readonly onSaveStatus: (status: SaveStatus) => void,
    private readonly userId: string,
  ) {
    this.store = new PendingUpdateStore(userId, pageId);
    this.updateHandler = (update, origin) => {
      if (origin === 'remote') return;
      this.queueUpdate(update);
    };
    this.awarenessHandler = ({ added, updated, removed }) => {
      const update = encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]);
      this.send({ type: 'awareness', update: encodeBase64(update) });
      this.publishUsers();
    };

    doc.on('update', this.updateHandler);
    awareness.on('update', this.awarenessHandler);
    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    if (this.initializing || this.closed) return;
    this.initializing = true;
    try {
      const restored = await this.store.load();
      if (this.closed) return;
      for (const state of restored.states) Y.applyUpdate(this.doc, state, 'remote');
      for (const stored of restored.updates) {
        Y.applyUpdate(this.doc, decodeBase64(stored.update), 'remote');
        this.pending.set(this.nextClientSeq++, {
          stored,
          durable: true,
          acknowledged: false,
          busy: false,
          failed: false,
        });
      }
      this.initialized = true;
      this.initializationFailed = false;
      if (this.seed === true) this.queueUpdate(Y.encodeStateAsUpdate(this.doc));
      else if (
        this.seed &&
        restored.updates.length === 0 &&
        Y.decodeStateVector(Y.encodeStateVector(this.doc)).size === 0
      ) {
        this.doc.getText('markdown').insert(0, this.seed);
      }
      for (const [seq, entry] of this.pending) this.persist(seq, entry);
      this.connect();
    } catch {
      this.initializationFailed = true;
      this.notifySaveStatus();
    } finally {
      this.initializing = false;
    }
  }

  private connect(): void {
    if (this.closed) return;
    if (this.connection !== 'connecting') this.connection = 'reconnecting';
    this.onStatus(this.connection);
    this.notifySaveStatus();

    const url = new URL(`/api/pages/${this.pageId}/ws`, window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    this.socket = socket;
    this.synced = false;
    this.sent.clear();
    // Each connection starts with the server's full, durable sync snapshot.
    this.remoteDoc.destroy();
    this.remoteDoc = new Y.Doc();

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.reconnectDelay = 500;
      this.connection = 'connected';
      this.onStatus('connected');
      this.notifySaveStatus();
      this.send({
        type: 'sync',
        stateVector: encodeBase64(Y.encodeStateVector(this.doc)),
      });
      this.send({
        type: 'awareness',
        update: encodeBase64(encodeAwarenessUpdate(this.awareness, [this.awareness.clientID])),
      });
      this.publishUsers();
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.sendRaw('ping'), 25_000);
    });

    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      if (typeof event.data !== 'string' || event.data === 'pong') return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === 'ack') {
        if (typeof message.clientSeq !== 'number') return;
        const entry = this.pending.get(message.clientSeq);
        if (entry && this.sent.has(message.clientSeq)) this.acknowledge(message.clientSeq, entry);
        return;
      }
      if (message.type === 'nack') {
        if (typeof message.clientSeq !== 'number' || !this.pending.has(message.clientSeq)) return;
        this.pending.get(message.clientSeq)!.failed = true;
        this.sent.delete(message.clientSeq);
        this.notifySaveStatus();
        return;
      }
      if (message.type === 'sync' || message.type === 'update') {
        if (!message.update) return;
        const update = decodeBase64(message.update);
        Y.applyUpdate(this.remoteDoc, update);
        Y.applyUpdate(this.doc, update, 'remote');
        if (message.type === 'sync') this.synced = true;
        if (this.synced) {
          for (const [seq, entry] of this.pending) {
            if (containsUpdate(this.remoteDoc, decodeBase64(entry.stored.update))) {
              this.acknowledge(seq, entry);
            } else {
              this.transmit(seq, entry);
            }
          }
        }
        return;
      }
      if (message.type === 'awareness' && message.update) {
        applyAwarenessUpdate(this.awareness, decodeBase64(message.update), 'remote');
        this.publishUsers();
      }
    });

    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.socket = null;
      if (this.closed) return;
      this.connection = 'reconnecting';
      this.onStatus('reconnecting');
      this.notifySaveStatus();
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
    });

    socket.addEventListener('error', () => {
      if (this.socket === socket) socket.close();
    });
  }

  retry(): void {
    if (!this.initialized) {
      void this.initialize();
      return;
    }
    for (const [seq, entry] of this.pending) {
      entry.failed = false;
      if (entry.acknowledged) this.acknowledge(seq, entry);
      else this.persist(seq, entry);
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.notifySaveStatus();
      return;
    }
    if (this.socket?.readyState === WebSocket.CONNECTING) {
      this.notifySaveStatus();
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connect();
  }

  private queueUpdate(update: Uint8Array): void {
    const clientSeq = this.nextClientSeq;
    this.nextClientSeq += 1;
    const entry: PendingUpdate = {
      stored: {
        id: crypto.randomUUID(),
        sessionId: this.sessionId,
        scope: [this.userId, this.pageId],
        update: encodeBase64(update),
      },
      durable: false,
      state: Y.encodeStateAsUpdate(this.doc),
      acknowledged: false,
      busy: false,
      failed: false,
    };
    this.pending.set(clientSeq, entry);
    this.notifySaveStatus();
    if (this.initialized) this.persist(clientSeq, entry);
  }

  private persist(clientSeq: number, entry: PendingUpdate): void {
    if (entry.busy) return;
    if (entry.durable) {
      this.transmit(clientSeq, entry);
      return;
    }
    // Commit local edits in order. A later checkpoint must never become durable
    // while a dependency exists only in a failed/in-flight earlier outbox write.
    for (const pending of this.pending.values()) {
      if (pending === entry) break;
      if (!pending.durable && !pending.acknowledged) return;
    }
    entry.busy = true;
    void this.store
      .put(entry.stored, entry.state!)
      .then(() => {
        entry.durable = true;
        entry.state = undefined;
        entry.busy = false;
        if (entry.acknowledged) this.acknowledge(clientSeq, entry);
        else this.transmit(clientSeq, entry);
        this.persistNext();
      })
      .catch(() => {
        entry.busy = false;
        entry.failed = true;
        this.notifySaveStatus();
      });
  }

  private persistNext(): void {
    for (const [seq, entry] of this.pending) {
      if (!entry.durable && !entry.acknowledged) {
        if (!entry.failed) this.persist(seq, entry);
        break;
      }
    }
  }

  private acknowledge(clientSeq: number, entry: PendingUpdate): void {
    entry.acknowledged = true;
    if (entry.busy) return;
    // A write may still be in flight when a sync proves an update is already durable remotely.
    entry.busy = true;
    void this.store
      .remove(entry.stored)
      .then(() => {
        this.pending.delete(clientSeq);
        this.sent.delete(clientSeq);
        this.persistNext();
        this.notifySaveStatus();
      })
      .catch(() => {
        entry.busy = false;
        entry.failed = true;
        this.notifySaveStatus();
      });
  }

  private transmit(clientSeq: number, entry: PendingUpdate): void {
    const socket = this.socket;
    if (
      this.closed ||
      !this.synced ||
      !entry.durable ||
      entry.acknowledged ||
      this.sent.has(clientSeq)
    )
      return;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type: 'update', update: entry.stored.update, clientSeq }));
      this.sent.add(clientSeq);
    } catch {
      entry.failed = true;
      this.notifySaveStatus();
    }
  }

  private notifySaveStatus(): void {
    if (this.closed) return;
    const pending = this.pending.size;
    const state =
      this.initializationFailed || [...this.pending.values()].some((entry) => entry.failed)
        ? 'failed'
        : pending > 0
          ? this.connection === 'connected'
            ? 'saving'
            : 'unsent'
          : 'saved';
    this.onSaveStatus({ state, pending });
  }

  private send(message: unknown): void {
    this.sendRaw(JSON.stringify(message));
  }

  private sendRaw(value: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(value);
  }

  private publishUsers(): void {
    const users: Collaborator[] = [];
    for (const state of this.awareness.getStates().values()) {
      const user = (state as { user?: AwarenessUser }).user;
      if (user?.name) users.push(user);
    }
    this.onUsers(users);
  }

  destroy(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.doc.off('update', this.updateHandler);
    this.awareness.off('update', this.awarenessHandler);
    this.socket?.close();
    this.socket = null;
    this.remoteDoc.destroy();
  }
}
