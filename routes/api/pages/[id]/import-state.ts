import { defineHandler } from 'void';
import { getSessionUser } from '../../../../src/server/auth';
import { recordAudit } from '../../../../src/server/db';
import { jsonError, pathParam, sameOrigin } from '../../../../src/server/http';
import { roomFetch } from '../../../../src/server/rooms';
import type { Env } from '../../../../src/server/types';
import {
  MAX_STATE_IMPORT_BYTES,
  PayloadTooLargeError,
  readBoundedBytes,
  STATE_IMPORT_TIMEOUT_MS,
} from '../../../../src/shared/yjs';

export const POST = defineHandler(async (c) => {
  const env = c.env as Env;
  // Migration-only endpoint. It must not be reachable during normal operation.
  if (env.ZEEE_MIGRATION_IMPORT !== '1') return jsonError(c, 404, 'not found');

  const user = await getSessionUser(c);
  if (!user) return jsonError(c, 401, 'login required');
  if (!sameOrigin(c)) return jsonError(c, 403, 'origin mismatch');
  const pageId = pathParam(c, 'id');

  try {
    let bytes: Uint8Array | null = null;
    let tooLarge = false;
    try {
      const declaredLength = Number(c.req.header('content-length') ?? '0');
      if (Number.isFinite(declaredLength) && declaredLength > MAX_STATE_IMPORT_BYTES) {
        tooLarge = true;
      } else {
        // Count bytes while reading: Content-Length is advisory only.
        bytes = await readBoundedBytes(
          c.req.raw.body,
          MAX_STATE_IMPORT_BYTES,
          AbortSignal.timeout(STATE_IMPORT_TIMEOUT_MS),
        );
      }
    } catch (error) {
      if (error instanceof PayloadTooLargeError) tooLarge = true;
    }

    if (tooLarge) return jsonError(c, 413, 'state is too large');
    if (!bytes) return jsonError(c, 400, 'invalid state');

    return await roomFetch(pageId, '/import-state', user, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    });
  } finally {
    // Audit every authenticated attempt, including 400/409/413 rejections.
    // A failed audit write must never turn a successful import into a 500.
    try {
      await recordAudit(env.DB, user.id, 'page.state_import', 'page', pageId);
    } catch (error) {
      console.error('failed to record page.state_import audit', error);
    }
  }
});
