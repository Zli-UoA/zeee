import { defineHandler } from 'void';
import { getSessionUser } from '../../../../src/server/auth';
import { jsonError, pathParam } from '../../../../src/server/http';
import { roomFetch } from '../../../../src/server/rooms';

export const GET = defineHandler(async (c) => {
  const user = await getSessionUser(c);
  if (!user) return jsonError(c, 401, 'login required');
  return roomFetch(pathParam(c, 'id'), '/state', user);
});
