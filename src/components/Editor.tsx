import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { yCollab } from 'y-codemirror.next';
import { Badge, Button, DropdownMenu, Empty, Input, LayerCard, Text } from '@cloudflare/kumo';
import {
  ArrowCounterClockwiseIcon,
  ClockCounterClockwiseIcon,
  DotsThreeIcon,
  FloppyDiskIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react';
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
    fontSize: '15px',
    lineHeight: '1.9',
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
  const historyRef = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState(page.title);
  const [savedTitle, setSavedTitle] = useState(page.title);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [users, setUsers] = useState<Collaborator[]>([]);
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
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
          extensions: [
            basicSetup,
            markdown(),
            EditorView.lineWrapping,
            EditorView.contentAttributes.of({ 'aria-label': '本文' }),
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

  useEffect(() => {
    if (!historyOpen) return;
    if (window.matchMedia('(max-width: 1279px)').matches) {
      historyRef.current?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
        block: 'start',
      });
    }
  }, [historyOpen]);

  async function saveTitle() {
    const next = title.trim();
    if (!next) {
      setTitle(savedTitle);
      return;
    }
    if (next === savedTitle) return;

    setError('');
    const response = await fetch(`/api/pages/${page.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: next }),
      keepalive: true,
    });
    if (!response.ok) {
      setError('タイトルを保存できませんでした');
      return;
    }
    setTitle(next);
    setSavedTitle(next);
    window.dispatchEvent(
      new CustomEvent('zeee:page-renamed', { detail: { id: page.id, title: next } }),
    );
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
    if (!window.confirm('このページと履歴を削除します。元に戻せません。')) return;
    setBusy(true);
    const response = await fetch(`/api/pages/${page.id}`, { method: 'DELETE' });
    if (!response.ok) {
      setError('削除できませんでした');
      setBusy(false);
      return;
    }
    window.location.href = '/';
  }

  const others = users.filter((item) => item.name !== user.displayName);

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-3">
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void saveTitle()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          aria-label="タイトル"
          enterKeyHint="done"
          size="lg"
          className="w-full border-0 bg-transparent px-0 py-0 text-2xl font-semibold shadow-none ring-0 focus:ring-2 focus:ring-kumo-focus/40"
        />

        <div className="flex flex-wrap items-center gap-2">
          {status !== 'connected' ? (
            <Badge appearance="dot" variant={badgeForStatus(status)} aria-live="polite">
              {statusLabel(status)}
            </Badge>
          ) : null}
          {others.map((item) => (
            <Badge variant="neutral" key={`${item.name}-${item.color}`}>
              {item.name}
            </Badge>
          ))}

          <div className="ml-auto flex items-center gap-1">
            <Button
              type="button"
              variant="secondary"
              icon={<ClockCounterClockwiseIcon size={15} />}
              onClick={() => setHistoryOpen((open) => !open)}
              aria-pressed={historyOpen}
            >
              履歴
            </Button>
            <DropdownMenu>
              <DropdownMenu.Trigger
                render={
                  <Button type="button" variant="ghost" shape="square" aria-label="ページメニュー">
                    <DotsThreeIcon size={18} />
                  </Button>
                }
              />
              <DropdownMenu.Content>
                <DropdownMenu.Item
                  variant="danger"
                  icon={<TrashIcon size={16} />}
                  onClick={() => void remove()}
                  disabled={busy}
                >
                  ページを削除
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {error ? (
        <Text variant="error" size="sm">
          {error}
        </Text>
      ) : null}

      <div
        className={
          historyOpen
            ? 'grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_280px]'
            : 'grid grid-cols-1 gap-4'
        }
      >
        <LayerCard className="overflow-hidden p-0">
          <div className="min-h-[60svh] lg:min-h-[calc(100vh-18rem)]" ref={editorRef} />
        </LayerCard>

        {historyOpen ? (
          <div
            ref={historyRef}
            className="scroll-mt-20 self-start xl:sticky xl:top-20 xl:max-h-[calc(100vh-6rem)] xl:overflow-y-auto"
          >
            <LayerCard className="overflow-hidden p-0">
              <div className="flex items-center justify-between border-b border-kumo-line px-3 py-2">
                <div className="flex items-center gap-2">
                  <Text variant="heading" as="h2">
                    履歴
                  </Text>
                  <Badge variant="outline">{revisions.length}</Badge>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  shape="square"
                  aria-label="履歴を閉じる"
                  onClick={() => setHistoryOpen(false)}
                >
                  <XIcon size={16} />
                </Button>
              </div>

              <div className="border-b border-kumo-line p-3">
                <Button
                  type="button"
                  variant="secondary"
                  icon={<FloppyDiskIcon size={15} />}
                  onClick={saveRevision}
                  disabled={busy}
                  className="w-full"
                >
                  現在の版を保存
                </Button>
              </div>

              {revisions.length === 0 ? (
                <Empty
                  size="sm"
                  icon={<ClockCounterClockwiseIcon size={28} />}
                  title="履歴はまだありません"
                  description="編集内容は自動で保存されます。"
                />
              ) : (
                <ul className="divide-y divide-kumo-line">
                  {revisions.map((revision) => (
                    <li
                      className="flex items-start justify-between gap-2 px-3 py-2"
                      key={revision.id}
                    >
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <div className="flex items-center gap-1.5">
                          <Text variant="mono">v{revision.version}</Text>
                          {revision.manual ? <Badge variant="outline">手動</Badge> : null}
                        </div>
                        <Text variant="mono-secondary">{formatDate(revision.createdAt)}</Text>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        icon={<ArrowCounterClockwiseIcon size={15} />}
                        onClick={() => restore(revision.version)}
                        disabled={busy}
                        aria-label={`v${revision.version} に戻す`}
                      >
                        戻す
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </LayerCard>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function statusLabel(status: ConnectionStatus): string {
  if (status === 'connected') return '接続済み';
  if (status === 'reconnecting') return '再接続中';
  return '接続中';
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
