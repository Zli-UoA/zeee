import {
  createElement,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Link, useRouter } from '@void/react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeHighlight from 'rehype-highlight';
import { Badge, Button, Text } from '@cloudflare/kumo';
import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { createPageByPath } from '../client/pagePathApi';
import type { Backlink } from '../server/backlinks';
import type { PageNavigation } from '../server/types';
import { rehypeHeadings } from '../markdown/headings';
import { sameToc, type TocItem } from '../markdown/toc';
import { createWikiResolver, remarkWikiLinks, type LinkTarget } from '../markdown/wiki';
import { validatePagePath } from '../shared/pagePath';

type Props = {
  markdown: string;
  pages: PageNavigation[];
  linkTargets?: LinkTarget[];
  pageId: string;
  pageTitle: string;
  sidePanel?: boolean;
};

type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  [key: string]: unknown;
};

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a ?? []), 'data*' as const],
  },
};

export function MarkdownView({
  markdown,
  pages,
  linkTargets,
  pageId,
  pageTitle,
  sidePanel = true,
}: Props) {
  const articleRef = useRef<HTMLElement>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [backlinks, setBacklinks] = useState<Backlink[] | null>(null);
  const [backlinksError, setBacklinksError] = useState(false);
  const [backlinksRetry, setBacklinksRetry] = useState(0);
  const targets = useMemo(
    () => linkTargets ?? pages.map((page) => ({ ...page, aliases: [] as string[] })),
    [linkTargets, pages],
  );
  const resolve = useMemo(() => createWikiResolver(targets), [targets]);

  useEffect(() => {
    const root = articleRef.current;
    if (!root) return;
    const items: TocItem[] = [];
    for (const element of root.querySelectorAll('h2, h3, h4')) {
      const id = element.id;
      if (!id) continue;
      const clone = element.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.zeee-heading-anchor').forEach((anchor) => anchor.remove());
      const text = clone.textContent?.trim() ?? '';
      if (!text) continue;
      items.push({ id, depth: Number(element.tagName.slice(1)), text });
    }
    setToc((current) => (sameToc(current, items) ? current : items));
  }, [markdown]);

  useEffect(() => {
    if (!pageTitle.trim()) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/pages/${encodeURIComponent(pageId)}/backlinks`, {
            signal: controller.signal,
          });
          if (!response.ok) throw new Error('backlinks request failed');
          const data = (await response.json()) as { backlinks?: Backlink[] };
          if (controller.signal.aborted) return;
          setBacklinks(Array.isArray(data.backlinks) ? data.backlinks : []);
          setBacklinksError(false);
        } catch {
          if (!controller.signal.aborted) setBacklinksError(true);
        }
      })();
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [pageId, pageTitle, backlinksRetry]);

  const components = useMemo<Components>(
    () => ({
      a({ node, href, children }) {
        const state = node?.properties?.dataWikiState;
        const wikiTitle = node?.properties?.dataWikiTitle;
        if (state === 'missing' && typeof wikiTitle === 'string') {
          return (
            <MissingWikiLink title={wikiTitle} pages={pages}>
              {children}
            </MissingWikiLink>
          );
        }
        const external = href?.startsWith('http://') || href?.startsWith('https://');
        const internal = href?.startsWith('/') && !href.startsWith('//');
        if (internal && href) {
          return (
            <Link href={href} className={state === 'resolved' ? 'zeee-wiki-link' : undefined}>
              {children}
            </Link>
          );
        }
        return (
          <a
            href={href}
            target={external ? '_blank' : undefined}
            rel={external ? 'noreferrer noopener' : undefined}
            className={state === 'resolved' ? 'zeee-wiki-link' : undefined}
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
      pre({ node, children }) {
        return <CodeBlock node={node as unknown as HastNode}>{children}</CodeBlock>;
      },
      h2(props) {
        return <Heading level={2} {...props} />;
      },
      h3(props) {
        return <Heading level={3} {...props} />;
      },
      h4(props) {
        return <Heading level={4} {...props} />;
      },
      h5(props) {
        return <Heading level={5} {...props} />;
      },
      h6(props) {
        return <Heading level={6} {...props} />;
      },
    }),
    [pages],
  );

  const hasToc = toc.length > 0;
  const hasHeadingMarkdown = useMemo(() => markdownHasHeadings(markdown), [markdown]);
  const showMobileToc = hasToc || hasHeadingMarkdown;
  const hasBacklinks = (backlinks?.length ?? 0) > 0;
  const showSidePanel = sidePanel && (hasToc || hasBacklinks || backlinksError);

  return (
    <div className="min-h-[60svh] px-5 py-7 sm:px-8 sm:py-9 lg:min-h-[calc(100vh-18rem)]">
      <div
        className={
          showSidePanel
            ? 'xl:grid xl:grid-cols-[minmax(0,36.5rem)_13rem] xl:items-start xl:gap-10'
            : undefined
        }
      >
        <div className="min-w-0">
          {showMobileToc ? (
            <details className="mb-5 border-b border-kumo-line pb-3 xl:hidden">
              <summary className="cursor-pointer py-2 text-sm font-medium text-kumo-strong">
                目次
              </summary>
              <div className="pt-2">{hasToc ? <TocNav items={toc} /> : null}</div>
            </details>
          ) : null}

          <article className="zeee-prose" ref={articleRef}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm, [remarkWikiLinks, { resolve }]]}
              rehypePlugins={[
                [rehypeSanitize, sanitizeSchema],
                rehypeHeadings,
                [rehypeHighlight, { detect: false }],
              ]}
              components={components}
            >
              {markdown}
            </ReactMarkdown>
          </article>

          {hasBacklinks ? (
            <details className="mt-6 border-t border-kumo-line pt-4 xl:hidden">
              <summary className="cursor-pointer py-2 text-sm font-medium text-kumo-strong">
                バックリンク（{backlinks?.length ?? 0}）
              </summary>
              <div className="pt-2">
                <BacklinkList backlinks={backlinks} />
              </div>
            </details>
          ) : null}

          {backlinksError ? (
            <div className="mt-4 flex items-center gap-2 xl:hidden">
              <Text variant="error" size="sm">
                バックリンクを読み込めませんでした
              </Text>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setBacklinksError(false);
                  setBacklinksRetry((value) => value + 1);
                }}
              >
                再試行
              </Button>
            </div>
          ) : null}
        </div>

        {showSidePanel ? (
          <aside className="hidden self-start xl:sticky xl:top-20 xl:block">
            {hasToc ? (
              <section aria-label="目次" className="mb-6">
                <h2 className="mb-2 text-sm font-semibold text-kumo-subtle">目次</h2>
                <TocNav items={toc} />
              </section>
            ) : null}

            {hasBacklinks || backlinksError ? (
              <section aria-label="バックリンク">
                <div className="mb-2 flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-kumo-subtle">バックリンク</h2>
                  {hasBacklinks ? <Badge variant="outline">{backlinks?.length}</Badge> : null}
                </div>
                {backlinksError ? (
                  <div className="flex flex-col items-start gap-2">
                    <Text variant="error" size="sm">
                      読み込めませんでした
                    </Text>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        setBacklinksError(false);
                        setBacklinksRetry((value) => value + 1);
                      }}
                    >
                      再試行
                    </Button>
                  </div>
                ) : (
                  <BacklinkList backlinks={backlinks} />
                )}
              </section>
            ) : null}
          </aside>
        ) : null}
      </div>

      {backlinksError && !showSidePanel ? (
        <div className="mt-4 hidden items-center gap-2 xl:flex">
          <Text variant="error" size="sm">
            バックリンクを読み込めませんでした
          </Text>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setBacklinksError(false);
              setBacklinksRetry((value) => value + 1);
            }}
          >
            再試行
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function TocNav({ items }: { items: TocItem[] }) {
  return (
    <nav aria-label="目次">
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <li
            key={item.id}
            style={{ paddingInlineStart: `${Math.max(0, item.depth - 2) * 0.75}rem` }}
          >
            <a
              href={`#${item.id}`}
              className="block text-sm leading-snug text-kumo-subtle no-underline hover:text-kumo-default hover:underline"
              title={item.text}
              onClick={(event) => handleHeadingLink(event, item.id)}
            >
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function BacklinkList({ backlinks }: { backlinks: Backlink[] | null }) {
  if (!backlinks || backlinks.length === 0) return null;
  return (
    <ul className="flex flex-col gap-3">
      {backlinks.map((backlink) => (
        <li key={backlink.id}>
          <Link
            href={`/pages/${backlink.id}`}
            className="block text-sm font-medium text-kumo-link no-underline hover:underline"
          >
            {backlink.title}
          </Link>
          <p className="mt-0.5 text-sm leading-relaxed text-kumo-subtle">{backlink.excerpt}</p>
          {backlink.authorName ? (
            <p className="mt-0.5 text-sm text-kumo-subtle">{backlink.authorName}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Heading({
  level,
  node: _node,
  id,
  children,
  ...props
}: ComponentPropsWithoutRef<'h2'> & { level: number; node?: unknown }) {
  const text = reactText(children).trim();
  return createElement(
    `h${level}`,
    { ...props, id },
    children,
    typeof id === 'string' && id
      ? createElement(
          'a',
          {
            href: `#${id}`,
            className: 'zeee-heading-anchor',
            'aria-label': text ? `「${text}」へのリンク` : 'この見出しへのリンク',
            onClick: (event: MouseEvent<HTMLAnchorElement>) => handleHeadingLink(event, id),
          },
          '#',
        )
      : null,
  );
}

function MissingWikiLink({
  title,
  pages,
  children,
}: {
  title: string;
  pages: PageNavigation[];
  children?: ReactNode;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function create() {
    if (busy) return;
    setBusy(true);
    setError('');
    const validation = validatePagePath(title, pages);
    if (!validation.ok) {
      setError(validation.message);
      setBusy(false);
      return;
    }
    const result = await createPageByPath(validation.path);
    if (!result.ok) {
      setError(result.message);
      setBusy(false);
      return;
    }
    void router.visit(`/pages/${result.id}`);
  }

  return (
    <span className="zeee-wiki-missing-wrap">
      <button
        type="button"
        className="zeee-wiki-missing"
        onClick={() => void create()}
        disabled={busy}
        aria-label={`「${title}」というページを作成`}
        title={`「${title}」はまだありません。クリックで作成`}
      >
        {children}
      </button>
      {busy ? (
        <span className="zeee-wiki-status" role="status">
          作成中…
        </span>
      ) : null}
      {error ? (
        <span className="zeee-wiki-status" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

function CodeBlock({ node, children }: { node?: HastNode; children?: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const timerRef = useRef<number | null>(null);
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  async function copy() {
    const copied = await copyToClipboard(hastText(node));
    if (copied) {
      setState('copied');
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setState('idle'), 2000);
      return;
    }

    const pre = preRef.current;
    if (pre) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(pre);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    setState('manual');
  }

  return (
    <div className="zeee-code-block">
      <pre ref={preRef}>{children}</pre>
      <button
        type="button"
        className="zeee-code-copy"
        onClick={() => void copy()}
        aria-label="コードをコピー"
      >
        {state === 'copied' ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
        <span aria-live="polite">{state === 'copied' ? 'コピー済み' : 'コピー'}</span>
      </button>
      {state === 'manual' ? (
        <p role="alert" className="zeee-code-status">
          コピーできませんでした。コードを選択したので、Ctrl+C / ⌘C でコピーしてください。
        </p>
      ) : null}
    </div>
  );
}

function markdownHasHeadings(markdown: string): boolean {
  const text = markdown.replace(/^```[\s\S]*?^```[ \t]*$/gm, '');
  return (
    /^(?: {0,3}#{1,4})[ \t]+\S/m.test(text) ||
    /^(?: {0,3}[^\n]+)\n(?: {0,3}[=-]+)[ \t]*$/m.test(text)
  );
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

function handleHeadingLink(event: MouseEvent<HTMLAnchorElement>, id: string) {
  event.preventDefault();
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView({
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    block: 'start',
  });
  if (window.location.hash !== `#${id}`) {
    window.history.replaceState(null, '', `#${id}`);
  }
}

function hastText(node?: HastNode): string {
  if (!node) return '';
  let text = typeof node.value === 'string' ? node.value : '';
  for (const child of node.children ?? []) text += hastText(child);
  return text;
}

function reactText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(reactText).join('');
  if (isValidElement(node)) {
    return reactText((node.props as { children?: ReactNode }).children);
  }
  return '';
}
