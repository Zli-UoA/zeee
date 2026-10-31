import type { ReactNode } from 'react';
import { Badge, LayerDialog, Text } from '@cloudflare/kumo';
import type { RevisionRecord } from '../server/types';
import { formatDate } from '../shared/format';

type Props = {
  revision: RevisionRecord;
  currentMarkdown: string;
  busy: boolean;
  error: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
};

type DiffLine = {
  kind: 'same' | 'add' | 'remove';
  text: string;
};

const MAX_DIFF_LINES = 900;
const CONTEXT_LINES = 2;

export function RevisionPreview({
  revision,
  currentMarkdown,
  busy,
  error,
  onOpenChange,
  onConfirm,
}: Props) {
  const diff = buildDiff(currentMarkdown, revision.markdown);
  const added = diff?.filter((line) => line.kind === 'add').length ?? 0;
  const removed = diff?.filter((line) => line.kind === 'remove').length ?? 0;
  const changed = added > 0 || removed > 0;

  return (
    <LayerDialog.Root
      open
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      dismissDisabled={busy}
    >
      <LayerDialog.Content size="xl" verticalAlign="center" closeLabel="閉じる">
        <LayerDialog.Title>v{revision.version} に戻す</LayerDialog.Title>
        <LayerDialog.Description>
          現在の本文をこの版の内容に置き換えます。復元後の内容は新しい版として保存されます。
        </LayerDialog.Description>
        <LayerDialog.Body>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={revision.manual ? 'info' : 'outline'}>
                {revision.manual ? '手動保存' : '自動保存'}
              </Badge>
              <Text variant="mono-secondary">{formatDate(revision.createdAt)}</Text>
              {diff ? (
                <Text variant="secondary" size="sm">
                  現在との差分: +{added} / -{removed} 行
                </Text>
              ) : null}
            </div>

            {error ? (
              <div role="alert">
                <Text variant="error" size="sm">
                  {error}
                </Text>
              </div>
            ) : null}

            <div className="overflow-hidden rounded-md border border-kumo-line">
              {diff && changed ? (
                <div className="max-h-[45svh] overflow-y-auto bg-kumo-recessed py-2 font-mono text-xs leading-relaxed">
                  {renderDiff(diff)}
                </div>
              ) : (
                <>
                  <div className="border-b border-kumo-line bg-kumo-tint px-3 py-1.5">
                    <Text variant="secondary" size="sm">
                      {diff ? '現在の本文と同じ内容です' : '本文プレビュー'}
                    </Text>
                  </div>
                  <pre className="max-h-[45svh] overflow-y-auto whitespace-pre-wrap break-words bg-kumo-recessed px-3 py-2 font-mono text-xs leading-relaxed text-kumo-default">
                    {revision.markdown || '（空の本文）'}
                  </pre>
                </>
              )}
            </div>
          </div>
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel="キャンセル">
          <LayerDialog.Action onClick={onConfirm} loading={busy}>
            {error ? '再試行' : 'この版に戻す'}
          </LayerDialog.Action>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}

function renderDiff(diff: DiffLine[]) {
  const visible = new Set<number>();
  diff.forEach((line, index) => {
    if (line.kind === 'same') return;
    for (
      let cursor = Math.max(0, index - CONTEXT_LINES);
      cursor <= Math.min(diff.length - 1, index + CONTEXT_LINES);
      cursor += 1
    ) {
      visible.add(cursor);
    }
  });

  const rows: ReactNode[] = [];
  let skipped = false;
  diff.forEach((line, index) => {
    if (!visible.has(index)) {
      skipped = true;
      return;
    }
    if (skipped) {
      rows.push(
        <div className="px-3 py-0.5 text-center text-kumo-subtle" key={`skip-${index}`}>
          …
        </div>,
      );
      skipped = false;
    }
    const prefix = line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' ';
    const tone =
      line.kind === 'add'
        ? 'bg-kumo-success-tint text-kumo-success'
        : line.kind === 'remove'
          ? 'bg-kumo-danger-tint text-kumo-danger'
          : 'text-kumo-subtle';
    rows.push(
      <div className={`flex gap-3 px-3 py-0.5 ${tone}`} key={index}>
        <span aria-hidden="true" className="w-3 shrink-0 select-none text-center">
          {prefix}
        </span>
        <span className="whitespace-pre-wrap break-words">{line.text || ' '}</span>
      </div>,
    );
  });
  return rows;
}

function buildDiff(before: string, after: string): DiffLine[] | null {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  if (beforeLines.length > MAX_DIFF_LINES || afterLines.length > MAX_DIFF_LINES) return null;

  const width = afterLines.length + 1;
  const table = new Uint32Array((beforeLines.length + 1) * width);
  for (let i = beforeLines.length - 1; i >= 0; i -= 1) {
    for (let j = afterLines.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        beforeLines[i] === afterLines[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const diff: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      diff.push({ kind: 'same', text: beforeLines[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      diff.push({ kind: 'remove', text: beforeLines[i] });
      i += 1;
    } else {
      diff.push({ kind: 'add', text: afterLines[j] });
      j += 1;
    }
  }
  while (i < beforeLines.length) {
    diff.push({ kind: 'remove', text: beforeLines[i] });
    i += 1;
  }
  while (j < afterLines.length) {
    diff.push({ kind: 'add', text: afterLines[j] });
    j += 1;
  }
  return diff;
}
