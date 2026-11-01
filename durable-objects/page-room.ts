import { DurableObject } from 'cloudflare:workers';
import * as Y from 'yjs';
import { defineDurableObject } from 'void/durable';
import { createRevision, latestRevision, materializePage } from '../src/server/db';
import type { Env } from '../src/server/types';
import { decodeBase64, encodeBase64 } from '../src/shared/base64';
import { containsUpdate } from '../src/shared/yjs';

type ClientMessage =
  | { type: 'sync'; stateVector: string }
  | { type: 'update'; update: string; actor?: string; clientSeq?: number }
  | { type: 'awareness'; update: string };

const TEN_MINUTES = 10 * 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;
const SNAPSHOT_UPDATES = 300;

export class PageRoomObject extends DurableObject<Env> {
  private readonly doc = new Y.Doc();
  private readonly text = this.doc.getText('markdown');
  private readonly ready: Promise<void>;
  private pageId: string;
  private lastActorId: string | null = null;
  private lastSnapshotAt = 0;
  private alarmScheduled = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.pageId = ctx.id.name ?? '';
    this.ready = this.load();
    try {
      this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    } catch {
      // Not every runtime exposes the auto-response helper.
    }
  }

  private async load(): Promise<void> {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS doc_snapshot (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state BLOB NOT NULL,
        seq INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS doc_update (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        data BLOB NOT NULL,
        actor_id TEXT,
        created_at INTEGER NOT NULL
      );
    `);

    const snapshot = this.ctx.storage.sql
      .exec('SELECT state, created_at FROM doc_snapshot WHERE id = 1')
      .toArray()[0] as { state: ArrayBuffer; created_at: number } | undefined;
    if (snapshot) {
      Y.applyUpdate(this.doc, toBytes(snapshot.state));
      this.lastSnapshotAt = snapshot.created_at;
    }

    const updates = this.ctx.storage.sql
      .exec('SELECT data FROM doc_update ORDER BY seq')
      .toArray() as Array<{ data: ArrayBuffer }>;
    for (const update of updates) {
      Y.applyUpdate(this.doc, toBytes(update.data));
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!this.pageId) this.pageId = url.pathname.split('/')[2] ?? '';
    await this.ready;

    const userId = request.headers.get('x-zeee-user');
    const userName = request.headers.get('x-zeee-name') ?? 'someone';
    if (!userId) return new Response('Unauthorized', { status: 401 });

    if (url.pathname.endsWith('/ws')) return this.openSocket(request, userId);
    if (url.pathname.endsWith('/state')) {
      const state = Y.encodeStateAsUpdate(this.doc);
      const body = state.buffer.slice(
        state.byteOffset,
        state.byteOffset + state.byteLength,
      ) as ArrayBuffer;
      return new Response(body, {
        headers: { 'content-type': 'application/octet-stream' },
      });
    }
    if (url.pathname.endsWith('/snapshot') && request.method === 'POST') {
      return this.snapshot(userId);
    }
    if (url.pathname.endsWith('/replace') && request.method === 'POST') {
      return this.replace(request, userId, userName);
    }
    return new Response('Not found', { status: 404 });
  }

  private openSocket(request: Request, userId: string): Response {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    this.lastActorId = userId;
    server.send(
      JSON.stringify({ type: 'sync', update: encodeBase64(Y.encodeStateAsUpdate(this.doc)) }),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    if (message === 'ping') return;

    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(message) as ClientMessage;
    } catch {
      return;
    }

    await this.ready;

    if (parsed.type === 'sync') {
      const stateVector = decodeBase64(parsed.stateVector);
      const update = Y.encodeStateAsUpdate(this.doc, stateVector);
      socket.send(JSON.stringify({ type: 'sync', update: encodeBase64(update) }));
      return;
    }

    if (parsed.type === 'awareness') {
      this.broadcast({ type: 'awareness', update: parsed.update }, socket);
      return;
    }

    if (parsed.type !== 'update') return;

    const clientSeq = typeof parsed.clientSeq === 'number' ? parsed.clientSeq : undefined;
    try {
      const update = decodeBase64(parsed.update);
      // Validate on a copy first. A failed SQL write must never appear in later syncs.
      // Replays (including delete-only updates) need an ack, but no additional log row.
      if (!containsUpdate(this.doc, update)) {
        const actor = parsed.actor ?? this.lastActorId;
        this.saveUpdate(update, actor);
        Y.applyUpdate(this.doc, update, 'remote');
        this.lastActorId = actor;
        this.broadcast({ type: 'update', update: parsed.update }, socket);
      }
      if (clientSeq !== undefined) this.reply(socket, { type: 'ack', clientSeq });
    } catch {
      if (clientSeq !== undefined) this.reply(socket, { type: 'nack', clientSeq });
    }
  }

  private saveUpdate(update: Uint8Array, actorId: string | null): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO doc_update (data, actor_id, created_at) VALUES (?, ?, ?)',
      update,
      actorId,
      Date.now(),
    );
    if (!this.alarmScheduled) {
      this.alarmScheduled = true;
      void this.ctx.storage.setAlarm(Date.now() + 1000);
    }
  }

  private broadcast(payload: unknown, exclude?: WebSocket): void {
    const text = JSON.stringify(payload);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exclude) continue;
      try {
        socket.send(text);
      } catch {
        // The socket may have closed between the iteration and the send.
      }
    }
  }

  private reply(socket: WebSocket, payload: unknown): void {
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // A closed socket will resend its pending updates after reconnecting.
    }
  }

  async alarm(): Promise<void> {
    await this.ready;
    this.alarmScheduled = false;
    if (!this.pageId) return;

    const markdown = this.text.toJSON();
    await materializePage(this.env.DB, this.pageId, markdown);

    const now = Date.now();
    const latest = await latestRevision(this.env.DB, this.pageId);
    if (!latest || (now - latest.createdAt >= TEN_MINUTES && latest.markdown !== markdown)) {
      await createRevision(this.env.DB, this.pageId, markdown, this.lastActorId, false);
    }

    const stats = this.ctx.storage.sql
      .exec('SELECT COUNT(*) AS count, MAX(seq) AS max_seq FROM doc_update')
      .toArray()[0] as { count: number; max_seq: number | null };
    if (
      stats.count > 0 &&
      (stats.count >= SNAPSHOT_UPDATES || now - this.lastSnapshotAt >= FIVE_MINUTES)
    ) {
      const seq = stats.max_seq ?? 0;
      this.ctx.storage.sql.exec(
        `INSERT INTO doc_snapshot (id, state, seq, created_at) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, seq = excluded.seq, created_at = excluded.created_at`,
        Y.encodeStateAsUpdate(this.doc),
        seq,
        now,
      );
      this.ctx.storage.sql.exec('DELETE FROM doc_update WHERE seq <= ?', seq);
      this.lastSnapshotAt = now;
    }
  }

  private async snapshot(userId: string): Promise<Response> {
    const markdown = this.text.toJSON();
    await materializePage(this.env.DB, this.pageId, markdown);
    const version = await createRevision(this.env.DB, this.pageId, markdown, userId, true);
    return Response.json({ version, markdown });
  }

  private async replace(request: Request, userId: string, userName: string): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { markdown?: string } | null;
    if (!body || typeof body.markdown !== 'string') {
      return Response.json({ error: 'markdown is required' }, { status: 400 });
    }

    const replacement = new Y.Doc();
    let update: Uint8Array;
    try {
      Y.applyUpdate(replacement, Y.encodeStateAsUpdate(this.doc));
      const text = replacement.getText('markdown');
      const before = Y.encodeStateVector(replacement);
      replacement.transact(() => {
        text.delete(0, text.length);
        text.insert(0, body.markdown as string);
      });
      update = Y.encodeStateAsUpdate(replacement, before);
    } finally {
      replacement.destroy();
    }
    this.saveUpdate(update, userId);
    Y.applyUpdate(this.doc, update, 'remote');
    this.lastActorId = userId;
    this.broadcast({ type: 'update', update: encodeBase64(update) });

    await materializePage(this.env.DB, this.pageId, this.text.toJSON());
    const version = await createRevision(
      this.env.DB,
      this.pageId,
      this.text.toJSON(),
      userId,
      true,
    );
    return Response.json({ version, by: userName });
  }
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error('Unexpected SQLite BLOB value');
}

export const PageRoom = defineDurableObject({
  name: 'page-room',
  class: PageRoomObject,
});

export default PageRoom;
