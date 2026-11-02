import { PATH_CONFLICT, pathRequestErrorMessage } from '../shared/pagePath';

type ApiErrorBody = {
  error?: unknown;
};

export type PagePathRequestResult =
  | { ok: true; id: string }
  | { ok: false; status: number; code: string | null; message: string };

async function readError(response: Response): Promise<{ code: string | null; message: string }> {
  const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
  const code = typeof body?.error === 'string' ? body.error : null;
  return { code, message: pathRequestErrorMessage(response.status, code) };
}

export async function createPageByPath(title: string): Promise<PagePathRequestResult> {
  try {
    const response = await fetch('/api/pages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) {
      const error = await readError(response);
      return { ok: false, status: response.status, ...error };
    }
    const data = (await response.json()) as { page?: { id?: unknown } };
    const id = data.page?.id;
    if (typeof id !== 'string' || !id) {
      return {
        ok: false,
        status: response.status,
        code: null,
        message: '作成結果を確認できませんでした。',
      };
    }
    return { ok: true, id };
  } catch {
    return {
      ok: false,
      status: 0,
      code: null,
      message: 'ページを作成できませんでした。通信状態を確認してください。',
    };
  }
}

export async function updatePageTitleByPath(
  pageId: string,
  title: string,
): Promise<{ ok: true } | { ok: false; status: number; code: string | null; message: string }> {
  try {
    const response = await fetch(`/api/pages/${encodeURIComponent(pageId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ title }),
      keepalive: true,
    });
    if (!response.ok) {
      const error = await readError(response);
      return { ok: false, status: response.status, ...error };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      status: 0,
      code: null,
      message: 'タイトルを保存できませんでした。通信状態を確認してください。',
    };
  }
}

export function isPathConflict(code: string | null, status: number): boolean {
  return status === 409 || code === PATH_CONFLICT;
}
