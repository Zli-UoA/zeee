import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { EditorView, basicSetup } from 'codemirror';
import { Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { markdown as markdownLanguage } from '@codemirror/lang-markdown';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { Badge, Button, DropdownMenu, Empty, Input, LayerCard, Text } from '@cloudflare/kumo';
import {
  ArrowCounterClockwiseIcon,
  ClockCounterClockwiseIcon,
  DotsThreeIcon,
  EyeIcon,
  FloppyDiskIcon,
  PencilSimpleIcon,
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

type Collaboration = {
  text: Y.Text;
  awareness: Awareness;
  undoManager: Y.UndoManager;
};

type Mode = 'read' | 'edit';

const markdownComponents: Components = {
  a({ href, children }) {
    const external = href?.startsWith('http://') || href?.startsWith('https://');
    return (
      <a
        href={href}
        target={external ? '_blank' : undefined}
        rel={external ? 'noreferrer noopener' : undefined}
      >
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="zeee-table">
        <table>{children}</table>
      </div>
    );
  },
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
    padding: '0',
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
  const renderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mode, setMode] = useState<Mode>('read');
  const [markdown, setMarkdown] = useState(page.markdown);
  const [collaboration, setCollaboration] = useState<Collaboration | null>(null);
  const [title, setTitle] = useState(page.title);
  const [savedTitle, setSavedTitle] = useState(page.title);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [users, setUsers] = useState<Collaborator[]>([]);
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let provider: ZeeeProvider | undefined;
    let observer: (() => void) | undefined;
    const doc = new Y.Doc();
    const text = doc.getText('markdown');
    const awareness = new Awareness(doc);
    const undoManager = new Y.UndoManager(text);
    awareness.setLocalStateField('user', {
      name: user.displayName,
      color: colorFor(user.displayName),
    });

    void (async () => {
      try {
        const response = await fetch(`/api/pages/${page.id}/state`);
        if (response.ok) {
          Y.applyUpdate(doc, new Uint8Array(await response.arrayBuffer()));
        }
        const seed = text.length === 0 && page.markdown.length > 0;
        if (seed) text.insert(0, page.markdown);
        if (cancelled) {
          doc.destroy();
          return;
        }

        setMarkdown(text.toJSON());
        observer = () => {
          if (renderTimerRef.current) clearTimeout(renderTimerRef.current);
          renderTimerRef.current = setTimeout(() => setMarkdown(text.toJSON()), 120);
        };
        text.observe(observer);

        provider = new ZeeeProvider(page.id, doc, awareness, seed, setStatus, setUsers);
        setCollaboration({ text, awareness, undoManager });
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : '本文を読み込めませんでした');
        doc.destroy();
      }
    })();

    return () => {
      cancelled = true;
      if (renderTimerRef.current) {
        clearTimeout(renderTimerRef.current);
        renderTimerRef.current = null;
      }
      if (observer) text.unobserve(observer);
      provider?.destroy();
      undoManager.destroy();
      awareness.destroy();
      doc.destroy();
      setCollaboration(null);
    };
  }, [page.id]);

  useEffect(() => {
    if (mode !== 'edit' || !collaboration || !editorRef.current) return;
    const view = new EditorView({
      doc: collaboration.text.toJSON(),
      extensions: [
        basicSetup,
        Prec.high(keymap.of(yUndoManagerKeymap)),
        markdownLanguage(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': '本文' }),
        editorTheme,
        yCollab(collaboration.text, collaboration.awareness, {
          undoManager: collaboration.undoManager,
        }),
      ],
      parent: editorRef.current,
    });
    return () => view.destroy();
  }, [mode, collaboration]);

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
      <div
        className={
          historyOpen ? 'flex flex-col gap-3 xl:pe-[calc(280px+1rem)]' : 'flex flex-col gap-3'
        }
      >
        <div className="zeee-column flex flex-col gap-2 px-5 sm:flex-row sm:items-center sm:gap-3 sm:px-0">
          <div className="min-w-0 sm:flex-1">
            {mode === 'edit' ? (
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
            ) : (
              <div className="flex h-10 items-center">
                <h1
                  className="w-full truncate text-2xl font-semibold tracking-tight text-kumo-strong"
                  title={title}
                >
                  {title || '無題'}
                </h1>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
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

            <div className="ml-auto flex shrink-0 items-center gap-1 sm:ml-0">
              <Button
                type="button"
                variant={mode === 'read' ? 'primary' : 'secondary'}
                icon={mode === 'read' ? <PencilSimpleIcon size={15} /> : <EyeIcon size={15} />}
                onClick={() => {
                  if (mode === 'edit') {
                    collaboration?.awareness.setLocalStateField('cursor', null);
                    setMarkdown(collaboration?.text.toJSON() ?? markdown);
                  }
                  setMode(mode === 'read' ? 'edit' : 'read');
                }}
              >
                {mode === 'read' ? '編集' : '閲覧'}
              </Button>
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
                    <Button
                      type="button"
                      variant="ghost"
                      shape="square"
                      aria-label="ページメニュー"
                    >
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
      </div>

      {error ? (
        <div className={historyOpen ? 'xl:pe-[calc(280px+1rem)]' : undefined}>
          <Text variant="error" size="sm">
            {error}
          </Text>
        </div>
      ) : null}

      <div
        className={
          historyOpen
            ? 'grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_280px]'
            : 'grid grid-cols-1 gap-4'
        }
      >
        <LayerCard className="overflow-hidden p-0">
          {mode === 'read' ? (
            <div className="min-h-[60svh] px-5 py-7 sm:px-8 sm:py-9 lg:min-h-[calc(100vh-18rem)]">
              {markdown.trim() ? (
                <article className="zeee-prose">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeSanitize]}
                    components={markdownComponents}
                  >
                    {markdown}
                  </ReactMarkdown>
                </article>
              ) : (
                <Empty
                  icon={<PencilSimpleIcon size={28} />}
                  title="本文はまだありません"
                  description="編集モードで書き始めましょう。"
                  contents={
                    <Button
                      type="button"
                      variant="primary"
                      icon={<PencilSimpleIcon size={15} />}
                      onClick={() => setMode('edit')}
                    >
                      本文を書く
                    </Button>
                  }
                />
              )}
            </div>
          ) : (
            <div className="flex min-h-[60svh] flex-col px-5 py-7 sm:px-8 sm:py-9 lg:min-h-[calc(100vh-18rem)]">
              <div
                className="zeee-column min-h-[calc(60svh-3.5rem)] flex-1 lg:min-h-[calc(100vh-18rem-4.5rem)]"
                ref={editorRef}
              />
            </div>
          )}
        </LayerCard>

        {historyOpen ? (
          <div ref={historyRef} className="scroll-mt-20 self-start xl:sticky xl:top-20">
            <LayerCard className="overflow-hidden p-0">
              <div className="xl:max-h-[calc(100vh-6rem)] xl:overflow-y-auto">
                <div className="flex items-center justify-between px-3 pt-2">
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
              </div>
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
