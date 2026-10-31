import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { decodeBase64, encodeBase64 } from '../shared/base64';

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

export class ZeeeProvider {
  private socket: WebSocket | null = null;
  private closed = false;
  private connection: ConnectionStatus = 'connecting';
  private reconnectDelay = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pending = new Map<number, string>();
  private nextClientSeq = 1;
  private failed = false;
  private readonly updateHandler: (update: Uint8Array, origin: unknown) => void;
  private readonly awarenessHandler: (change: AwarenessChange) => void;

  constructor(
    private readonly pageId: string,
    private readonly doc: Y.Doc,
    private readonly awareness: Awareness,
    seed: boolean,
    private readonly onStatus: (status: ConnectionStatus) => void,
    private readonly onUsers: (users: Collaborator[]) => void,
    private readonly onSaveStatus: (status: SaveStatus) => void,
  ) {
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
    if (seed) this.queueUpdate(Y.encodeStateAsUpdate(doc));
    this.connect();
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

    socket.addEventListener('open', () => {
      this.reconnectDelay = 500;
      this.connection = 'connected';
      this.onStatus('connected');
      for (const [clientSeq, update] of this.pending) this.transmit(clientSeq, update);
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
      if (typeof event.data !== 'string' || event.data === 'pong') return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === 'ack') {
        if (typeof message.clientSeq !== 'number') return;
        if (!this.pending.delete(message.clientSeq)) return;
        if (this.pending.size === 0) this.failed = false;
        this.notifySaveStatus();
        return;
      }
      if (message.type === 'nack') {
        if (typeof message.clientSeq !== 'number' || !this.pending.has(message.clientSeq)) return;
        this.failed = true;
        this.notifySaveStatus();
        return;
      }
      if (message.type === 'sync' || message.type === 'update') {
        if (!message.update) return;
        Y.applyUpdate(this.doc, decodeBase64(message.update), 'remote');
        return;
      }
      if (message.type === 'awareness' && message.update) {
        applyAwarenessUpdate(this.awareness, decodeBase64(message.update), 'remote');
        this.publishUsers();
      }
    });

    socket.addEventListener('close', () => {
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

    socket.addEventListener('error', () => socket.close());
  }

  retry(): void {
    this.failed = false;
    if (this.socket?.readyState === WebSocket.OPEN) {
      for (const [clientSeq, update] of this.pending) this.transmit(clientSeq, update);
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
    const encoded = encodeBase64(update);
    this.pending.set(clientSeq, encoded);
    this.notifySaveStatus();
    this.transmit(clientSeq, encoded);
  }

  private transmit(clientSeq: number, update: string): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type: 'update', update, clientSeq }));
    } catch {
      this.failed = true;
      this.notifySaveStatus();
    }
  }

  private notifySaveStatus(): void {
    const pending = this.pending.size;
    const state = this.failed
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
  }
}
