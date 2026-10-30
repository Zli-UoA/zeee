import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { decodeBase64, encodeBase64 } from '../shared/base64';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';

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

export class ZeeeProvider {
  private socket: WebSocket | null = null;
  private closed = false;
  private reconnectDelay = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly updateHandler: (update: Uint8Array, origin: unknown) => void;
  private readonly awarenessHandler: (change: AwarenessChange) => void;

  constructor(
    private readonly pageId: string,
    private readonly doc: Y.Doc,
    private readonly awareness: Awareness,
    private seed: boolean,
    private readonly onStatus: (status: ConnectionStatus) => void,
    private readonly onUsers: (users: Collaborator[]) => void,
  ) {
    this.updateHandler = (update, origin) => {
      if (origin === 'remote') return;
      this.send({ type: 'update', update: encodeBase64(update) });
    };
    this.awarenessHandler = ({ added, updated, removed }) => {
      const update = encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]);
      this.send({ type: 'awareness', update: encodeBase64(update) });
      this.publishUsers();
    };

    doc.on('update', this.updateHandler);
    awareness.on('update', this.awarenessHandler);
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    this.onStatus(this.socket ? 'reconnecting' : 'connecting');

    const url = new URL(`/api/pages/${this.pageId}/ws`, window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.reconnectDelay = 500;
      this.onStatus('connected');
      if (this.seed) {
        this.seed = false;
        this.send({ type: 'update', update: encodeBase64(Y.encodeStateAsUpdate(this.doc)) });
      }
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
      let message: { type?: string; update?: string };
      try {
        message = JSON.parse(event.data);
      } catch {
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
      this.onStatus('reconnecting');
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
    });

    socket.addEventListener('error', () => socket.close());
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
