import { defineHandler } from 'void';
import { getSessionUser } from '../../../../src/server/auth';
import { jsonError, pathParam, sameOrigin } from '../../../../src/server/http';
import { roomUpgrade } from '../../../../src/server/rooms';

export const GET = defineHandler(async (c) => {
  const user = await getSessionUser(c);
  if (!user) return jsonError(c, 401, 'login required');
  if (!sameOrigin(c)) return jsonError(c, 403, 'origin mismatch');
  return roomUpgrade(pathParam(c, 'id'), user);
});
