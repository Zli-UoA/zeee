import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { yCollab } from 'y-codemirror.next';
import { ZeeeProvider, type Collaborator, type ConnectionStatus } from '../client/provider';
import type { PageRecord, RevisionRecord, SessionUser } from '../server/types';
import { formatDate } from '../shared/format';

type Props = {
  page: PageRecord;
  user: SessionUser;
  revisions: RevisionRecord[];
};

export function Editor({ page, user, revisions }: Props) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState(page.title);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [users, setUsers] = useState<Collaborator[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    void (async () => {
      const doc = new Y.Doc();
      const text = doc.getText('markdown');
      const awareness = new Awareness(doc);
      awareness.setLocalStateField('user', {
        name: user.displayName,
        color: colorFor(user.displayName),
      });

      try {
        const response = await fetch(`/api/pages/${page.id}/state`);
        if (response.ok) {
          Y.applyUpdate(doc, new Uint8Array(await response.arrayBuffer()));
        }
        const seed = text.length === 0 && page.markdown.length > 0;
        if (seed) text.insert(0, page.markdown);

        if (cancelled || !editorRef.current) {
          doc.destroy();
          return;
        }

        const view = new EditorView({
          doc: text.toJSON(),
          extensions: [basicSetup, markdown(), EditorView.lineWrapping, yCollab(text, awareness)],
          parent: editorRef.current,
        });
        const provider = new ZeeeProvider(page.id, doc, awareness, seed, setStatus, setUsers);

        cleanup = () => {
          provider.destroy();
          view.destroy();
          awareness.destroy();
          doc.destroy();
        };
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : '本文を読み込めませんでした');
        doc.destroy();
      }
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [page.id]);

  async function saveTitle(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const response = await fetch(`/api/pages/${page.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) setError('タイトルを保存できませんでした');
    setBusy(false);
  }

  async function saveRevision() {
    setBusy(true);
    setError('');
    const response = await fetch(`/api/pages/${page.id}/snapshot`, { method: 'POST' });
    if (!response.ok) {
      setError('版を保存できませんでした');
      setBusy(false);
      return;
    }
    window.location.reload();
  }

  async function restore(version: number) {
    if (!window.confirm(`v${version} の内容に戻しますか？`)) return;
    setBusy(true);
    setError('');
    const response = await fetch(`/api/pages/${page.id}/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version }),
    });
    if (!response.ok) {
      setError('復元できませんでした');
      setBusy(false);
      return;
    }
    window.location.reload();
  }

  async function remove() {
    if (!window.confirm('このページを削除しますか？')) return;
    setBusy(true);
    const response = await fetch(`/api/pages/${page.id}`, { method: 'DELETE' });
    if (!response.ok) {
      setError('削除できませんでした');
      setBusy(false);
      return;
    }
    window.location.href = '/';
  }

  return (
    <div className="editor-shell">
      <section className="editor-main">
        <form className="editor-toolbar" onSubmit={saveTitle}>
          <input
            className="title-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-label="タイトル"
          />
          <button type="submit" disabled={busy}>
            タイトル保存
          </button>
          <span className={`connection connection-${status}`}>{statusLabel(status)}</span>
          <span className="collaborators" aria-label="編集中のメンバー">
            {users.map((item) => (
              <span className="collaborator" key={`${item.name}-${item.color}`}>
                <i style={{ background: item.color }} />
                {item.name}
              </span>
            ))}
          </span>
          <button type="button" onClick={saveRevision} disabled={busy}>
            版を保存
          </button>
          <button type="button" className="danger" onClick={remove} disabled={busy}>
            削除
          </button>
        </form>

        {error ? <p className="error">{error}</p> : null}
        <div className="editor" ref={editorRef} />
        <p className="hint">
          Markdown をそのまま共同編集します。変更は自動保存され、10 分ごとに履歴が残ります。
        </p>
      </section>

      <aside className="history">
        <div className="history-head">
          <h2>履歴</h2>
          <span>{revisions.length}</span>
        </div>
        {revisions.length === 0 ? (
          <p className="empty">まだ履歴はありません。</p>
        ) : (
          <ol>
            {revisions.map((revision) => (
              <li key={revision.id}>
                <div>
                  <strong>v{revision.version}</strong>
                  <span className="badge">{revision.manual ? '手動' : '自動'}</span>
                </div>
                <time>{formatDate(revision.createdAt)}</time>
                <button type="button" onClick={() => restore(revision.version)} disabled={busy}>
                  この版に戻す
                </button>
              </li>
            ))}
          </ol>
        )}
      </aside>
    </div>
  );
}

function statusLabel(status: ConnectionStatus): string {
  if (status === 'connected') return '接続済み';
  if (status === 'reconnecting') return '再接続中';
  return '接続中';
}

function colorFor(name: string): string {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 360;
  return `hsl(${hash} 72% 42%)`;
}
