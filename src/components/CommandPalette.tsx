import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useRouter } from '@void/react';
import { Dialog } from '@cloudflare/kumo/primitives/dialog';
import { Button, Loader } from '@cloudflare/kumo';
import {
  ArrowRightIcon,
  ClockCounterClockwiseIcon,
  FileTextIcon,
  MagnifyingGlassIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import { splitHighlight } from '../client/highlight';
import {
  buildPaletteActions,
  normalizeSearchResults,
  type PaletteAction,
  type PaletteSearchResult,
} from '../client/palette';
import type { RecentPage } from '../client/useRecentPages';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recentPages: RecentPage[];
};

type SearchResponse = {
  query?: unknown;
  results?: unknown;
};

function highlightedParts(text: string, query: string) {
  return splitHighlight(text, query).map((part, index) =>
    part.match ? (
      <mark
        className="rounded-sm bg-kumo-warning/40 text-kumo-default"
        key={`${part.text}-${index}`}
      >
        {part.text}
      </mark>
    ) : (
      <span key={`${part.text}-${index}`}>{part.text}</span>
    ),
  );
}

export function CommandPalette({ open, onOpenChange, recentPages }: Props) {
  const router = useRouter();
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PaletteSearchResult[]>([]);
  const [resultsQuery, setResultsQuery] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [retryToken, setRetryToken] = useState(0);

  const trimmedQuery = query.trim();

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setResults([]);
    setResultsQuery(null);
    setLoading(false);
    setError(null);
    setActiveIndex(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!trimmedQuery) {
      setResults([]);
      setResultsQuery(null);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setResults([]);
    setResultsQuery(null);

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/search?q=${encodeURIComponent(trimmedQuery)}`, {
            signal: controller.signal,
            headers: { accept: 'application/json' },
          });
          if (!response.ok) throw new Error(`search failed: ${response.status}`);
          const data = (await response.json()) as SearchResponse;
          if (controller.signal.aborted) return;
          setResults(normalizeSearchResults(data.results));
          setResultsQuery(trimmedQuery);
          setLoading(false);
        } catch {
          if (controller.signal.aborted) return;
          setResults([]);
          setResultsQuery(null);
          setError('検索できませんでした。通信状態を確認してもう一度お試しください。');
          setLoading(false);
        }
      })();
    }, 150);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, trimmedQuery, retryToken]);

  const actions = useMemo<PaletteAction[]>(
    () =>
      buildPaletteActions({
        trimmedQuery,
        results,
        resultsQuery,
        loading,
        error,
        recentPages,
      }),
    [trimmedQuery, results, resultsQuery, loading, error, recentPages],
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [trimmedQuery]);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(actions.length - 1, 0)));
  }, [actions.length]);

  useEffect(() => {
    if (!open) return;
    const active = scrollRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  function runAction(action: PaletteAction | undefined) {
    if (!action) return;
    onOpenChange(false);
    if (action.kind === 'recent') {
      void router.visit(`/pages/${action.page.id}`);
      return;
    }
    if (action.kind === 'result') {
      void router.visit(`/pages/${action.result.id}`);
      return;
    }
    void router.visit(`/?q=${encodeURIComponent(action.query)}`);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const nativeEvent = event.nativeEvent;
    if (composingRef.current || nativeEvent.isComposing || event.key === 'Process') return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (actions.length === 0) return;
      setActiveIndex((current) => (current + 1) % actions.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (actions.length === 0) return;
      setActiveIndex((current) => (current - 1 + actions.length) % actions.length);
      return;
    }
    if (event.key === 'Enter') {
      if (event.altKey) return;
      event.preventDefault();
      runAction(actions[activeIndex]);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onOpenChange(false);
    }
  }

  const searchPending = trimmedQuery !== '' && (loading || resultsQuery !== trimmedQuery);
  const searchSettled = trimmedQuery !== '' && resultsQuery === trimmedQuery && !loading && !error;

  const liveMessage = error
    ? ''
    : searchPending
      ? '検索中です'
      : trimmedQuery
        ? `${results.length}件のページが見つかりました`
        : recentPages.length > 0
          ? `最近見たページが${recentPages.length}件あります`
          : '';

  const showEmptyRecent = !trimmedQuery && recentPages.length === 0;
  const showResults = searchSettled && results.length > 0;
  const showNoResults = searchSettled && results.length === 0;
  const allIndex = actions.findIndex((action) => action.kind === 'all');
  const hasListbox = actions.length > 0;

  const allGroup =
    allIndex >= 0 ? (
      <div role="group" aria-label="すべての検索結果">
        <PaletteOption
          id={`${baseId}-option-${allIndex}`}
          index={allIndex}
          active={activeIndex === allIndex}
          onActivate={() => setActiveIndex(allIndex)}
          onSelect={() => runAction(actions[allIndex])}
        >
          <span className="flex h-lh shrink-0 items-center">
            <MagnifyingGlassIcon size={17} className="text-kumo-subtle" />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-kumo-default">
            すべての結果を見る
          </span>
          <span className="hidden shrink-0 text-xs text-kumo-subtle sm:inline">/?q=…</span>
        </PaletteOption>
      </div>
    ) : null;

  const resultsGroup = showResults ? (
    <div role="group" aria-label="検索結果">
      <div className="px-2 pt-2 pb-1 text-sm font-semibold text-kumo-subtle">検索結果</div>
      {results.map((result, index) => (
        <PaletteOption
          key={result.id}
          id={`${baseId}-option-${index}`}
          index={index}
          active={activeIndex === index}
          onActivate={() => setActiveIndex(index)}
          onSelect={() => runAction(actions[index])}
        >
          <span className="flex h-lh shrink-0 items-center">
            <FileTextIcon size={17} className="text-kumo-subtle" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-kumo-strong">
              {highlightedParts(result.title, trimmedQuery)}
            </span>
            {result.excerpt ? (
              <span className="line-clamp-2 text-sm text-kumo-subtle">
                {highlightedParts(result.excerpt, trimmedQuery)}
              </span>
            ) : null}
          </span>
          <span className="flex h-lh shrink-0 items-center">
            <ArrowRightIcon
              size={15}
              className={activeIndex === index ? 'text-kumo-subtle' : 'text-kumo-subtle opacity-0'}
            />
          </span>
        </PaletteOption>
      ))}
    </div>
  ) : null;

  const recentGroup =
    !trimmedQuery && recentPages.length > 0 ? (
      <div role="group" aria-label="最近見たページ">
        <div className="px-2 pt-2 pb-1 text-sm font-semibold text-kumo-subtle">最近見たページ</div>
        {recentPages.map((page, index) => (
          <PaletteOption
            key={page.id}
            id={`${baseId}-option-${index}`}
            index={index}
            active={activeIndex === index}
            onActivate={() => setActiveIndex(index)}
            onSelect={() => runAction(actions[index])}
          >
            <span className="flex h-lh shrink-0 items-center">
              <ClockCounterClockwiseIcon size={17} className="text-kumo-subtle" />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-kumo-default">{page.title}</span>
            <span className="flex h-lh shrink-0 items-center">
              <ArrowRightIcon
                size={15}
                className={
                  activeIndex === index ? 'text-kumo-subtle' : 'text-kumo-subtle opacity-0'
                }
              />
            </span>
          </PaletteOption>
        ))}
      </div>
    ) : null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-kumo-overlay opacity-80 backdrop-blur-[1px] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup
          aria-label="ページを検索"
          aria-modal="true"
          className="fixed top-[10vh] left-1/2 z-50 flex max-h-[70vh] w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 flex-col overflow-hidden rounded-2xl bg-kumo-base text-kumo-default shadow-xl ring ring-kumo-line transition duration-150 focus-within:ring-2 focus-within:ring-kumo-brand data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0"
        >
          <div className="flex items-center gap-3 border-b border-kumo-line px-4 py-3">
            <MagnifyingGlassIcon size={18} className="shrink-0 text-kumo-subtle" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={() => {
                composingRef.current = false;
              }}
              type="text"
              role="combobox"
              aria-label="ページを検索"
              aria-autocomplete="list"
              aria-haspopup={hasListbox ? 'listbox' : undefined}
              aria-expanded={open && hasListbox}
              aria-controls={hasListbox ? listboxId : undefined}
              aria-activedescendant={
                actions[activeIndex] ? `${baseId}-option-${activeIndex}` : undefined
              }
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              maxLength={200}
              enterKeyHint="search"
              placeholder="ページを検索"
              className="min-w-0 flex-1 border-0 bg-transparent text-sm text-kumo-default outline-none placeholder:text-kumo-subtle"
            />
            {loading ? <Loader size="sm" aria-label="検索中" /> : null}
            <kbd className="hidden shrink-0 rounded border border-kumo-line px-1.5 py-0.5 text-[10px] text-kumo-subtle sm:inline-block">
              Esc
            </kbd>
          </div>

          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-2">
            {hasListbox ? (
              <div id={listboxId} role="listbox" aria-label="候補">
                {showResults ? resultsGroup : null}
                {searchSettled ? allGroup : null}
                {recentGroup}
              </div>
            ) : null}

            {loading ? (
              <div className="flex items-center gap-2 px-3 py-4 text-sm text-kumo-subtle">
                <Loader size="sm" aria-label="検索中" />
                検索中…
              </div>
            ) : null}

            {error ? (
              <div
                role="alert"
                className="mx-1 flex items-start gap-2 rounded-lg bg-kumo-danger-tint px-3 py-3 text-sm text-kumo-danger"
              >
                <WarningCircleIcon size={17} className="mt-0.5 shrink-0" />
                <span className="min-w-0 flex-1">{error}</span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setRetryToken((current) => current + 1)}
                >
                  再試行
                </Button>
              </div>
            ) : null}

            {showNoResults ? (
              <p className="px-3 py-4 text-sm text-kumo-subtle">
                「{trimmedQuery}」に一致するページはありません。
              </p>
            ) : null}

            {showEmptyRecent ? (
              <p className="px-3 py-4 text-sm text-kumo-subtle">
                最近見たページはありません。ページ名を入力すると検索できます。
              </p>
            ) : null}
          </div>

          <div className="hidden items-center justify-between gap-3 border-t border-kumo-line bg-kumo-elevated px-4 py-2 text-xs text-kumo-subtle sm:flex">
            <span>↑↓ 選択</span>
            <span>Enter 決定</span>
            <span>Esc 閉じる</span>
          </div>

          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {liveMessage}
          </p>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type PaletteOptionProps = {
  id: string;
  index: number;
  active: boolean;
  disabled?: boolean;
  onActivate: () => void;
  onSelect: () => void;
  children: ReactNode;
};

function PaletteOption({
  id,
  index,
  active,
  disabled = false,
  onActivate,
  onSelect,
  children,
}: PaletteOptionProps) {
  return (
    <button
      type="button"
      role="option"
      id={id}
      data-index={index}
      aria-selected={active}
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      disabled={disabled}
      onMouseMove={onActivate}
      onClick={onSelect}
      className={`flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left ${
        active ? 'bg-kumo-tint' : 'hover:bg-kumo-tint'
      } disabled:cursor-default disabled:opacity-60`}
    >
      {children}
    </button>
  );
}
