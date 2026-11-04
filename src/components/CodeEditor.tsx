import { useEmojis } from '../emoji/useEmojis';
import { emojiCompletion } from '../emoji/markdown';
import { useEffect, useId, useRef } from 'react';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import {
  autocompletion,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { indentWithTab, simplifySelection, temporarilySetTabFocusMode } from '@codemirror/commands';
import { EditorView, basicSetup } from 'codemirror';
import { Prec } from '@codemirror/state';
import { keymap, type Command } from '@codemirror/view';
import { markdown as markdownLanguage } from '@codemirror/lang-markdown';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import {
  filterWikiCompletions,
  findWikiCompletionContext,
  wikiCompletionText,
  wikiCompletionTo,
} from '../markdown/autocomplete';
import type { LinkTarget } from '../markdown/wiki';

type Props = {
  text: Y.Text;
  awareness: Awareness;
  undoManager: Y.UndoManager;
  targets: LinkTarget[];
  className?: string;
};

const escapeToTabFocus: Command = (view) => {
  if (view.composing) return false;
  if (view.dom.querySelector('.cm-search')) return false;
  simplifySelection(view);
  return temporarilySetTabFocusMode(view);
};

const markdownEditingKeymap = [indentWithTab, { key: 'Escape', run: escapeToTabFocus }];

const editorTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--text-color-kumo-default)',
  },
  '.cm-content': {
    caretColor: 'var(--color-kumo-brand)',
    fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
    fontSize: '14px',
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

export default function CodeEditor({ text, awareness, undoManager, targets, className }: Props) {
  const { emojis, shortcodes } = useEmojis();
  const shortcodesRef = useRef(shortcodes);
  shortcodesRef.current = shortcodes;
  const emojisRef = useRef(emojis);
  emojisRef.current = emojis;
  const containerRef = useRef<HTMLDivElement>(null);
  const helpId = useId();

  useEffect(() => {
    if (!containerRef.current) return;
    const view = new EditorView({
      doc: text.toJSON(),
      extensions: [
        basicSetup,
        Prec.high(keymap.of(yUndoManagerKeymap)),
        Prec.high(keymap.of(markdownEditingKeymap)),
        markdownLanguage(),
        autocompletion({
          override: [
            wikiCompletionSource(targets),
            (context) =>
              emojiCompletion(
                context.state.doc.toString(),
                context.pos,
                emojisRef.current,
                shortcodesRef.current,
              ),
          ],
        }),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          'aria-label': '本文',
          'aria-describedby': helpId,
        }),
        editorTheme,
        yCollab(text, awareness, { undoManager }),
      ],
      parent: containerRef.current,
    });
    return () => view.destroy();
  }, [text, awareness, undoManager, targets, helpId]);

  return (
    <div className={className} ref={containerRef}>
      <span id={helpId} className="sr-only">
        Tab でインデント、Shift+Tab でアウトデントします。エディタの外へ移動するには Escape
        を押してから Tab を押してください。
      </span>
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
