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

const editorTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--ink)',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.95rem',
    lineHeight: '1.9',
    padding: '0.8rem 0',
  },
  '.cm-line': {
    padding: '0 0.2rem',
  },
  '.cm-gutters': {
    display: 'none',
  },
  '.cm-activeLine': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 5%, transparent)',
  },
  '.cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 18%, transparent) !important',
  },
});

export function Editor({ page, user, revisions }: Props) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState(page.title);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [users, setUsers] = useState<Collaborator[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [chars, setChars] = useState(page.markdown.length);

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

      const updateChars = () => setChars(text.length);
      text.observe(updateChars);

      try {
        const response = await fetch(`/api/pages/${page.id}/state`);
        if (response.ok) {
          Y.applyUpdate(doc, new Uint8Array(await response.arrayBuffer()));
        }
        const seed = text.length === 0 && page.markdown.length > 0;
        if (seed) text.insert(0, page.markdown);
        updateChars();

        if (cancelled || !editorRef.current) {
          text.unobserve(updateChars);
          doc.destroy();
          return;
        }

        const view = new EditorView({
          doc: text.toJSON(),
          extensions: [
            basicSetup,
            markdown(),
            EditorView.lineWrapping,
            editorTheme,
            yCollab(text, awareness),
          ],
          parent: editorRef.current,
        });
        const provider = new ZeeeProvider(page.id, doc, awareness, seed, setStatus, setUsers);

        cleanup = () => {
          provider.destroy();
          view.destroy();
          awareness.destroy();
          text.unobserve(updateChars);
          doc.destroy();
        };
      } catch (loadError) {
        text.unobserve(updateChars);
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
        <form className="editor-head" onSubmit={saveTitle}>
          <div className="editor-title-wrap">
            <span className="editor-kicker">
              Page {page.id.slice(0, 8)} / {formatDate(page.createdAt)}
            </span>
            <input
              className="title-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              aria-label="タイトル"
            />
          </div>
          <div className="editor-actions">
            <span className={`connection connection-${status}`}>
              <i aria-hidden="true" />
              {statusLabel(status)}
            </span>
            <span className="collaborators" aria-label="編集中のメンバー">
              {users.map((item) => (
                <span className="collaborator" key={`${item.name}-${item.color}`}>
                  <i style={{ background: item.color }} aria-hidden="true" />
                  {item.name}
                </span>
              ))}
            </span>
            <span className="action-spacer" />
            <button type="submit" className="button" disabled={busy}>
              タイトル保存
            </button>
            <button type="button" className="button loud" onClick={saveRevision} disabled={busy}>
              版を保存 <span aria-hidden="true">↗</span>
            </button>
            <button type="button" className="button danger" onClick={remove} disabled={busy}>
              削除
            </button>
          </div>
        </form>

        {error ? <p className="error">{error}</p> : null}

        <div className="editor" ref={editorRef} />

        <div className="editor-foot">
          <span>{chars.toLocaleString('ja-JP')} chars</span>
          <span>Auto-saved / Yjs</span>
          <span>Markdown</span>
        </div>
      </section>

      <aside className="history">
        <div className="history-head">
          <span>History</span>
          <span>{String(revisions.length).padStart(2, '0')}</span>
        </div>
        {revisions.length === 0 ? (
          <p className="history-empty">まだ版はない。書き始めると、ここに時間が積もる。</p>
        ) : (
          <ol>
            {revisions.map((revision) => (
              <li key={revision.id}>
                <div className="history-line">
                  <span className="history-version">v{revision.version}</span>
                  <span className="badge">{revision.manual ? 'manual' : 'auto'}</span>
                </div>
                <time>{formatDate(revision.createdAt)}</time>
                <button
                  type="button"
                  className="history-restore"
                  onClick={() => restore(revision.version)}
                  disabled={busy}
                >
                  この版に戻す ↗
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
  if (status === 'connected') return 'Connected';
  if (status === 'reconnecting') return 'Reconnecting';
  return 'Connecting';
}

function colorFor(name: string): string {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 360;
  return `hsl(${hash} 58% 38%)`;
}
