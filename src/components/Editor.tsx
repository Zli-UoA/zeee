import { useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import {
  autocompletion,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { EditorView, basicSetup } from 'codemirror';
import { Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { markdown as markdownLanguage } from '@codemirror/lang-markdown';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { Badge, Button, DropdownMenu, Empty, Input, LayerCard, Text } from '@cloudflare/kumo';
import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  ClockCounterClockwiseIcon,
  DotsThreeIcon,
  EyeIcon,
  FloppyDiskIcon,
  PencilSimpleIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react';
import {
  ZeeeProvider,
  type Collaborator,
  type ConnectionStatus,
  type SaveStatus,
} from '../client/provider';
import type { PageRecord, PageSummary, RevisionRecord, SessionUser } from '../server/types';
import {
  filterWikiCompletions,
  findWikiCompletionContext,
  wikiCompletionText,
  wikiCompletionTo,
} from '../markdown/autocomplete';
import type { LinkTarget } from '../markdown/wiki';
import { formatDate } from '../shared/format';
import { MarkdownView } from './MarkdownView';
import { RevisionPreview } from './RevisionPreview';

type Props = {
  page: PageRecord;
  user: SessionUser;
  revisions: RevisionRecord[];
  pages: PageSummary[];
  linkTargets?: LinkTarget[];
};

type Collaboration = {
  text: Y.Text;
  awareness: Awareness;
  undoManager: Y.UndoManager;
};

type Mode = 'read' | 'edit';

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

export function Editor({ page, user, revisions, pages, linkTargets }: Props) {
  const editorRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const renderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const providerRef = useRef<ZeeeProvider | null>(null);
  const composingRef = useRef(false);
  const titleSaveSeqRef = useRef(0);
  const [mode, setMode] = useState<Mode>('read');
  const [markdown, setMarkdown] = useState(page.markdown);
  const [collaboration, setCollaboration] = useState<Collaboration | null>(null);
  const [title, setTitle] = useState(page.title);
  const [savedTitle, setSavedTitle] = useState(page.title);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ state: 'saved', pending: 0 });
  const [users, setUsers] = useState<Collaborator[]>([]);
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [previewRevision, setPreviewRevision] = useState<RevisionRecord | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [error, setError] = useState('');
  const targets = useMemo<LinkTarget[]>(
    () => linkTargets ?? pages.map((item) => ({ ...item, aliases: [] as string[] })),
    [linkTargets, pages],
  );

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
        undoManager.clear();

        setMarkdown(text.toJSON());
        observer = () => {
          if (renderTimerRef.current) clearTimeout(renderTimerRef.current);
          renderTimerRef.current = setTimeout(() => setMarkdown(text.toJSON()), 120);
        };
        text.observe(observer);

        provider = new ZeeeProvider(
          page.id,
          doc,
          awareness,
          seed,
          setStatus,
          setUsers,
          setSaveStatus,
        );
        providerRef.current = provider;
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
      providerRef.current = null;
      undoManager.destroy();
      awareness.destroy();
      doc.destroy();
      setCollaboration(null);
    };
  }, [page.id]);

  useEffect(() => {
    const start = () => {
      composingRef.current = true;
    };
    const end = () => {
      composingRef.current = false;
    };
    window.addEventListener('compositionstart', start, true);
    window.addEventListener('compositionend', end, true);
    return () => {
      window.removeEventListener('compositionstart', start, true);
      window.removeEventListener('compositionend', end, true);
    };
  }, []);

  useEffect(() => {
    if (title === savedTitle) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [title, savedTitle]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || composingRef.current) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;

      const key = event.key.toLowerCase();
      if (key === 'e') {
        event.preventDefault();
        const active = document.activeElement;
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
          active.blur();
        }
        toggleMode();
        return;
      }
      if (key === 's') {
        event.preventDefault();
        const active = document.activeElement;
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
          active.blur();
        }
        if (!busy) void saveRevision();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mode, collaboration, markdown, busy]);

  useEffect(() => {
    if (mode !== 'edit' || !collaboration || !editorRef.current) return;
    const view = new EditorView({
      doc: collaboration.text.toJSON(),
      extensions: [
        basicSetup,
        Prec.high(keymap.of(yUndoManagerKeymap)),
        markdownLanguage(),
        autocompletion({ override: [wikiCompletionSource(targets)] }),
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
  }, [mode, collaboration, targets]);

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

  function toggleMode() {
    if (mode === 'read') {
      setMode('edit');
      return;
    }
    collaboration?.awareness.setLocalStateField('cursor', null);
    setMarkdown(collaboration?.text.toJSON() ?? markdown);
    setMode('read');
  }

  async function saveTitle() {
    const next = title.trim();
    if (!next) {
      setTitle(savedTitle);
      return;
    }
    if (next === savedTitle) {
      setTitle(next);
      return;
    }

    setError('');
    const seq = titleSaveSeqRef.current + 1;
    titleSaveSeqRef.current = seq;
    try {
      const response = await fetch(`/api/pages/${page.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: next }),
        keepalive: true,
      });
      if (seq !== titleSaveSeqRef.current) return;
      if (!response.ok) {
        setError('タイトルを保存できませんでした');
        return;
      }
      setTitle((current) => (current.trim() === next ? next : current));
      setSavedTitle(next);
      window.dispatchEvent(
        new CustomEvent('zeee:page-renamed', { detail: { id: page.id, title: next } }),
      );
    } catch {
      if (seq === titleSaveSeqRef.current) setError('タイトルを保存できませんでした');
    }
  }

  async function saveRevision() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/pages/${page.id}/snapshot`, { method: 'POST' });
      if (!response.ok) {
        setError('版を保存できませんでした');
        setBusy(false);
        return;
      }
      window.location.reload();
    } catch {
      setError('版を保存できませんでした');
      setBusy(false);
    }
  }

  function openRevisionPreview(revision: RevisionRecord) {
    setRestoreError('');
    setPreviewRevision(revision);
  }

  async function restoreRevision() {
    if (!previewRevision || restoreBusy) return;
    setRestoreBusy(true);
    setRestoreError('');
    try {
      const response = await fetch(`/api/pages/${page.id}/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: previewRevision.version }),
      });
      if (!response.ok) {
        setRestoreError('復元できませんでした。接続を確認して再試行してください。');
        setRestoreBusy(false);
        return;
      }
      window.location.reload();
    } catch {
      setRestoreError('復元できませんでした。接続を確認して再試行してください。');
      setRestoreBusy(false);
    }
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
            <SaveStatusBadge
              connection={status}
              save={saveStatus}
              onRetry={() => providerRef.current?.retry()}
            />
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
                onClick={toggleMode}
                title={
                  mode === 'read'
                    ? '編集モードに切り替え（⌘E / Ctrl+E）'
                    : '閲覧モードに切り替え（⌘E / Ctrl+E）'
                }
                aria-keyshortcuts="Meta+E Control+E"
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
        <div
          className={historyOpen ? 'xl:pe-[calc(280px+1rem)]' : undefined}
          role="alert"
          aria-live="polite"
        >
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
        <LayerCard className={mode === 'read' ? 'p-0' : 'overflow-hidden p-0'}>
          {mode === 'read' ? (
            markdown.trim() ? (
              <MarkdownView
                markdown={markdown}
                pages={pages}
                linkTargets={targets}
                pageId={page.id}
                pageTitle={savedTitle}
                sidePanel={!historyOpen}
              />
            ) : (
              <div className="min-h-[60svh] px-5 py-7 sm:px-8 sm:py-9 lg:min-h-[calc(100vh-18rem)]">
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
              </div>
            )
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
                    disabled={busy || restoreBusy}
                    title="現在の版を保存（⌘S / Ctrl+S）"
                    aria-keyshortcuts="Meta+S Control+S"
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
                          onClick={() => openRevisionPreview(revision)}
                          disabled={busy || restoreBusy}
                          aria-label={`v${revision.version} の内容を確認して戻す`}
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

      {previewRevision ? (
        <RevisionPreview
          revision={previewRevision}
          currentMarkdown={collaboration?.text.toJSON() ?? markdown}
          busy={restoreBusy}
          error={restoreError}
          onOpenChange={(open) => {
            if (open || restoreBusy) return;
            setPreviewRevision(null);
            setRestoreError('');
          }}
          onConfirm={() => void restoreRevision()}
        />
      ) : null}
    </div>
  );
}

type SaveStatusDisplay = {
  label: string;
  variant: 'success' | 'warning' | 'neutral' | 'error';
  title: string;
};

function saveStatusDisplay(connection: ConnectionStatus, save: SaveStatus): SaveStatusDisplay {
  if (save.state === 'failed') {
    return {
      label: '保存失敗',
      variant: 'error',
      title: 'サーバーに保存できませんでした。再試行してください。',
    };
  }
  if (save.state === 'unsent') {
    if (connection === 'connecting') {
      return { label: '接続中', variant: 'neutral', title: 'サーバーに接続しています。' };
    }
    return connection === 'reconnecting'
      ? {
          label: '未保存（再接続中）',
          variant: 'warning',
          title: 'この端末の変更はまだサーバーに届いていません。再接続後に自動で送信します。',
        }
      : {
          label: '未保存（接続断）',
          variant: 'warning',
          title: 'この端末の変更はまだサーバーに届いていません。接続が戻ると自動で送信します。',
        };
  }
  if (connection === 'connecting') {
    return { label: '接続中', variant: 'neutral', title: 'サーバーに接続しています。' };
  }
  if (connection === 'reconnecting') {
    return { label: '再接続中', variant: 'warning', title: 'サーバーとの接続を復旧しています。' };
  }
  if (save.state === 'saving') {
    return { label: '保存中', variant: 'neutral', title: '変更をサーバーに送信しています。' };
  }
  return {
    label: '保存済み',
    variant: 'success',
    title: '変更はサーバーに保存済みです。検索や履歴への反映（D1）は非同期で少し遅れます。',
  };
}

function SaveStatusBadge({
  connection,
  save,
  onRetry,
}: {
  connection: ConnectionStatus;
  save: SaveStatus;
  onRetry: () => void;
}) {
  const display = saveStatusDisplay(connection, save);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    let message = '';
    let delay = 0;
    if (save.state === 'failed') {
      message = '保存に失敗しました。再試行できます。';
    } else if (save.state === 'unsent') {
      message =
        connection === 'reconnecting'
          ? '未保存の変更があります。再接続中です。'
          : '未保存の変更があります。接続が切れています。';
    } else if (connection === 'connecting') {
      message = 'サーバーに接続しています。';
    } else if (connection === 'reconnecting') {
      message = 'サーバーに再接続中です。';
    } else if (save.state === 'saving') {
      message = '保存中です。';
      delay = 1000;
    } else {
      message = '保存済みです。';
      delay = 600;
    }
    const timer = setTimeout(() => setAnnouncement(message), delay);
    return () => clearTimeout(timer);
  }, [connection, save.state]);

  return (
    <div className="flex items-center gap-1">
      <span title={display.title} className="inline-flex">
        <Badge appearance="dot" variant={display.variant}>
          {display.label}
        </Badge>
      </span>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      {save.state === 'failed' ? (
        <Button
          type="button"
          variant="secondary"
          icon={<ArrowClockwiseIcon size={14} />}
          onClick={onRetry}
        >
          再試行
        </Button>
      ) : null}
    </div>
  );
}

function wikiCompletionSource(targets: LinkTarget[]): CompletionSource {
  return (context) => wikiCompletionResult(targets, context.state.doc.toString(), context.pos);
}

function wikiCompletionResult(
  targets: LinkTarget[],
  markdown: string,
  pos: number,
): CompletionResult | null {
  const found = findWikiCompletionContext(markdown, pos);
  if (!found) return null;
  const candidates = filterWikiCompletions(targets, found.query);
  if (candidates.length === 0) return null;
  return {
    from: found.from,
    to: wikiCompletionTo(markdown, pos),
    filter: false,
    options: candidates.map((candidate) => ({
      label: candidate.title,
      type: 'text',
      detail: candidate.matchedAlias ? `別名: ${candidate.matchedAlias}` : undefined,
      apply: wikiCompletionText(candidate.title),
    })),
    update: (_current, _from, _to, context) =>
      wikiCompletionResult(targets, context.state.doc.toString(), context.pos),
  };
}

function colorFor(name: string): string {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 360;
  return `hsl(${hash} 58% 38%)`;
}
