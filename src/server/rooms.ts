import { PageRoom } from '../../durable-objects/page-room';
import type { SessionUser } from './types';

export function roomFetch(
  pageId: string,
  path: string,
  user: SessionUser,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('x-zeee-user', user.id);
  headers.set('x-zeee-name', user.displayName);
  return PageRoom.get(pageId).fetch(
    new Request(`https://page-room/pages/${pageId}${path}`, { ...init, headers }),
  );
}

export function roomUpgrade(pageId: string, user: SessionUser): Promise<Response> {
  const headers = new Headers({
    upgrade: 'websocket',
    connection: 'Upgrade',
    'x-zeee-user': user.id,
    'x-zeee-name': user.displayName,
  });
  return PageRoom.get(pageId).fetch(
    new Request(`https://page-room/pages/${pageId}/ws`, { headers }),
  );
}
