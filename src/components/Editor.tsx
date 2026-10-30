import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { yCollab } from 'y-codemirror.next';
import { Badge, Button, Empty, Input, LayerCard, Text } from '@cloudflare/kumo';
import { ClockCounterClockwiseIcon, FloppyDiskIcon, TrashIcon } from '@phosphor-icons/react';
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
    color: 'var(--text-color-kumo-default)',
  },
  '.cm-content': {
    caretColor: 'var(--color-kumo-brand)',
    fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
    fontSize: '14px',
    lineHeight: '1.8',
    padding: '1.25rem 1.5rem',
  },
  '.cm-line': {
    padding: '0 0.15rem',
  },
  '.cm-gutters': {
    display: 'none',
  },
  '.cm-activeLine': {
    backgroundColor: 'color-mix(in oklab, var(--color-kumo-contrast) 4%, transparent)',
  },
  '.cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in oklab, var(--color-kumo-brand) 22%, transparent) !important',
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
    <div className="flex flex-col gap-4">
      <form className="flex flex-col gap-3" onSubmit={saveTitle}>
        <div className="flex flex-col gap-1.5">
          <Text variant="mono-secondary">
            Page {page.id.slice(0, 8)} / {formatDate(page.createdAt)}
          </Text>
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-label="Title"
            size="lg"
            className="w-full text-xl font-semibold"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge appearance="dot" variant={badgeForStatus(status)}>
            {statusLabel(status)}
          </Badge>
          {users.map((item) => (
            <Badge variant="neutral" key={`${item.name}-${item.color}`}>
              {item.name}
            </Badge>
          ))}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button type="submit" variant="secondary" size="sm" disabled={busy}>
              タイトル保存
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              icon={<FloppyDiskIcon size={14} />}
              onClick={saveRevision}
              disabled={busy}
            >
              版を保存
            </Button>
            <Button
              type="button"
              variant="secondary-destructive"
              size="sm"
              icon={<TrashIcon size={14} />}
              onClick={remove}
              disabled={busy}
            >
              削除
            </Button>
          </div>
        </div>
      </form>

      {error ? (
        <Text variant="error" size="sm">
          {error}
        </Text>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <LayerCard className="overflow-hidden p-0">
          <div className="flex items-center justify-between border-b border-kumo-line px-4 py-2">
            <Text variant="mono-secondary">Markdown</Text>
            <Badge variant="outline">Yjs</Badge>
          </div>
          <div className="min-h-[55vh]" ref={editorRef} />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-kumo-line px-4 py-2">
            <Text variant="mono-secondary">{chars.toLocaleString('ja-JP')} chars</Text>
            <Text variant="mono-secondary">Auto-saved</Text>
          </div>
        </LayerCard>

        <LayerCard className="overflow-hidden p-0">
          <div className="flex items-center justify-between border-b border-kumo-line px-4 py-3">
            <Text variant="heading" as="h2">
              History
            </Text>
            <Badge variant="outline">{revisions.length}</Badge>
          </div>
          {revisions.length === 0 ? (
            <Empty
              size="sm"
              icon={<ClockCounterClockwiseIcon size={28} />}
              title="No versions"
              description="書き始めると、ここに時間が積もる。"
            />
          ) : (
            <ul className="divide-y divide-kumo-line">
              {revisions.map((revision) => (
                <li className="flex flex-col gap-2 px-4 py-3" key={revision.id}>
                  <div className="flex items-center gap-2">
                    <Text variant="mono">v{revision.version}</Text>
                    <Badge variant="outline">{revision.manual ? 'manual' : 'auto'}</Badge>
                  </div>
                  <Text variant="mono-secondary">{formatDate(revision.createdAt)}</Text>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    icon={<ClockCounterClockwiseIcon size={14} />}
                    onClick={() => restore(revision.version)}
                    disabled={busy}
                    className="w-fit"
                  >
                    この版に戻す
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </LayerCard>
      </div>
    </div>
  );
}

function statusLabel(status: ConnectionStatus): string {
  if (status === 'connected') return 'Connected';
  if (status === 'reconnecting') return 'Reconnecting';
  return 'Connecting';
}

function badgeForStatus(status: ConnectionStatus): 'success' | 'warning' | 'neutral' {
  if (status === 'connected') return 'success';
  if (status === 'reconnecting') return 'warning';
  return 'neutral';
}

function colorFor(name: string): string {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 360;
  return `hsl(${hash} 58% 38%)`;
}
