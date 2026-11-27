import { DurableObject } from 'cloudflare:workers';
import * as Y from 'yjs';
import { defineDurableObject } from 'void/durable';
import { createRevision, latestRevision, materializePage } from '../src/server/db';
import type { Env } from '../src/server/types';
import { decodeBase64, encodeBase64 } from '../src/shared/base64';
import {
  containsUpdate,
  MAX_STATE_IMPORT_BYTES,
  PayloadTooLargeError,
  readBoundedBytes,
  STATE_IMPORT_TIMEOUT_MS,
} from '../src/shared/yjs';

type ClientMessage =
  | { type: 'sync'; stateVector: string }
  | { type: 'update'; update: string; actor?: string; clientSeq?: number }
  | { type: 'awareness'; update: string };

const MATERIALIZE_DEBOUNCE_MS = 10_000;
const SEARCH_INTERVAL_MS = 60_000;
const REVISION_INTERVAL_MS = 30 * 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;
const SNAPSHOT_UPDATES = 300;

export class PageRoomObject extends DurableObject<Env> {
  private doc = new Y.Doc();
  private text = this.doc.getText('markdown');
  private readonly ready: Promise<void>;
  private pageId: string;
  private lastActorId: string | null = null;
  private lastSnapshotAt = 0;
  private lastSearchAt = 0;
  private alarmScheduled = false;
  private importing = false;
  // Alarm materialization and imports both touch DO storage and D1. Serialize
  // them so a slow alarm cannot write the pre-import document back to D1.
  private operationQueue: Promise<void> = Promise.resolve();

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
      CREATE TABLE IF NOT EXISTS doc_actor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        actor_id TEXT
      );
      CREATE TABLE IF NOT EXISTS doc_update (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        data BLOB NOT NULL,
        actor_id TEXT,
        created_at INTEGER NOT NULL
      );
    `);

    const actor = this.ctx.storage.sql
      .exec('SELECT actor_id FROM doc_actor WHERE id = 1')
      .toArray()[0] as { actor_id: string | null } | undefined;
    this.lastActorId = actor?.actor_id ?? null;
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

    if (url.pathname.endsWith('/ws')) {
      if (this.importing) return Response.json({ error: 'import in progress' }, { status: 409 });
      return this.openSocket(request, userId);
    }
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
      // Both routes write D1, so they must not interleave with an import's
      // materialization/revision or with each other. The flag is checked here
      // (not only inside the queue) because a request accepted during an
      // import must not run after the import clears it.
      if (this.importing) {
        return Response.json({ error: 'import in progress' }, { status: 409 });
      }
      return this.serialize(() => this.snapshot(userId));
    }
    if (url.pathname.endsWith('/replace') && request.method === 'POST') {
      if (this.importing) {
        return Response.json({ error: 'import in progress' }, { status: 409 });
      }
      return this.serialize(() => this.replace(request, userId, userName));
    }
    if (url.pathname.endsWith('/import-state') && request.method === 'POST') {
      return this.importState(request, userId, userName);
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
    server.serializeAttachment({ userId });
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
    const clientSeq =
      'clientSeq' in parsed && typeof parsed.clientSeq === 'number' ? parsed.clientSeq : undefined;

    await this.ready;

    // An import swaps the whole document. Never mix updates from the old state
    // into it: reject them so the client retries against the new state.
    if (this.importing) {
      if (clientSeq !== undefined) this.reply(socket, { type: 'nack', clientSeq });
      return;
    }

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

    try {
      const update = decodeBase64(parsed.update);
      // Validate on a copy first. A failed SQL write must never appear in later syncs.
      // Replays (including delete-only updates) need an ack, but no additional log row.
      if (!containsUpdate(this.doc, update)) {
        const attachment = socket.deserializeAttachment() as { userId?: unknown } | null;
        const actor = typeof attachment?.userId === 'string' ? attachment.userId : null;
        this.saveUpdate(update, actor);
        Y.applyUpdate(this.doc, update, 'remote');
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
    // The actor changes far less often than the document. Keep the row for
    // restarts, but do not add a second commit to every keystroke.
    if (this.lastActorId !== actorId) {
      this.ctx.storage.sql.exec(
        'INSERT INTO doc_actor (id, actor_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET actor_id = excluded.actor_id',
        actorId,
      );
      this.lastActorId = actorId;
    }
    this.scheduleMaterializeAlarm();
  }

  private scheduleMaterializeAlarm(): void {
    if (this.alarmScheduled) return;
    this.alarmScheduled = true;
    void this.ctx.storage.setAlarm(Date.now() + MATERIALIZE_DEBOUNCE_MS).catch(() => {
      // Allow a later write to retry scheduling instead of wedging the flag.
      this.alarmScheduled = false;
    });
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
    return this.serialize(() => this.runAlarm());
  }

  /** Run operations one at a time, even if an earlier operation failed. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(work, work);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async runAlarm(): Promise<void> {
    await this.ready;
    this.alarmScheduled = false;
    if (!this.pageId) return;

    const markdown = this.text.toJSON();
    const now = Date.now();
    const updateSearch = now - this.lastSearchAt >= SEARCH_INTERVAL_MS;
    await materializePage(this.env.DB, this.pageId, markdown, this.lastActorId, updateSearch);
    if (updateSearch) this.lastSearchAt = now;

    const latest = await latestRevision(this.env.DB, this.pageId);
    if (
      !latest ||
      (now - latest.createdAt >= REVISION_INTERVAL_MS && latest.markdown !== markdown)
    ) {
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
    await materializePage(this.env.DB, this.pageId, markdown, this.lastActorId);
    this.lastSearchAt = Date.now();
    const version = await createRevision(this.env.DB, this.pageId, markdown, userId, true);
    return Response.json({ version, markdown });
  }

  /**
   * Migration-only import of a raw Yjs update (the bytes returned by GET /state).
   * Unlike /replace this swaps the whole document, preserving the source client
   * ids instead of replaying a markdown diff through the current doc.
   */
  private async importState(request: Request, userId: string, userName: string): Promise<Response> {
    if (this.importing) {
      return Response.json({ error: 'import already in progress' }, { status: 409 });
    }
    // Clients keep their own Yjs state. Broadcasting an imported update would
    // merge it with stale structs, so refuse while anyone is connected.
    if (this.ctx.getWebSockets().length > 0) {
      return Response.json({ error: 'close websockets before importing' }, { status: 409 });
    }

    this.importing = true;
    try {
      const declaredLength = Number(request.headers.get('content-length') ?? '0');
      if (Number.isFinite(declaredLength) && declaredLength > MAX_STATE_IMPORT_BYTES) {
        return Response.json({ error: 'state is too large' }, { status: 413 });
      }

      let bytes: Uint8Array;
      try {
        bytes = await readBoundedBytes(
          request.body,
          MAX_STATE_IMPORT_BYTES,
          AbortSignal.timeout(STATE_IMPORT_TIMEOUT_MS),
        );
      } catch (error) {
        if (error instanceof PayloadTooLargeError) {
          return Response.json({ error: 'state is too large' }, { status: 413 });
        }
        return Response.json({ error: 'invalid state' }, { status: 400 });
      }

      // Validate on a separate doc first. Invalid bytes must never reach the
      // live doc or the durable log, just like the containsUpdate check in
      // webSocketMessage.
      const replacement = new Y.Doc();
      try {
        Y.applyUpdate(replacement, bytes, 'import');
      } catch {
        replacement.destroy();
        return Response.json({ error: 'invalid state' }, { status: 400 });
      }

      return await this.serialize(() => this.applyImport(replacement, bytes, userId, userName));
    } finally {
      this.importing = false;
    }
  }

  private async applyImport(
    replacement: Y.Doc,
    bytes: Uint8Array,
    userId: string,
    userName: string,
  ): Promise<Response> {
    const now = Date.now();
    try {
      // The imported state becomes the only source of truth. Clearing the log
      // and overwriting the snapshot in one transaction keeps load() from
      // replaying the previous document on the next start.
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec('DELETE FROM doc_update');
        this.ctx.storage.sql.exec(
          `INSERT INTO doc_snapshot (id, state, seq, created_at) VALUES (1, ?, 0, ?)
           ON CONFLICT(id) DO UPDATE SET state = excluded.state, seq = excluded.seq, created_at = excluded.created_at`,
          bytes,
          now,
        );
        this.ctx.storage.sql.exec(
          'INSERT INTO doc_actor (id, actor_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET actor_id = excluded.actor_id',
          userId,
        );
      });
    } catch (error) {
      replacement.destroy();
      throw error;
    }

    this.doc.destroy();
    this.doc = replacement;
    this.text = replacement.getText('markdown');
    this.lastActorId = userId;
    this.lastSnapshotAt = now;
    // No broadcast: connected clients were rejected with 409 above.

    const markdown = this.text.toJSON();
    try {
      await materializePage(this.env.DB, this.pageId, markdown, userId);
      this.lastSearchAt = Date.now();
      const version = await createRevision(this.env.DB, this.pageId, markdown, userId, true);
      return Response.json({ version, by: userName });
    } catch (error) {
      // The DO already holds the imported state and snapshot. If D1 is down,
      // schedule materialization so page_body is not stuck on the old text
      // until somebody edits the page again.
      this.scheduleMaterializeAlarm();
      throw error;
    }
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
    this.broadcast({ type: 'update', update: encodeBase64(update) });

    await materializePage(this.env.DB, this.pageId, this.text.toJSON(), userId);
    this.lastSearchAt = Date.now();
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
