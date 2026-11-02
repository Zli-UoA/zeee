import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter } from '@void/react';
import { LayerDialog, Text } from '@cloudflare/kumo';
import { createPageByPath } from '../client/pagePathApi';
import { initialPagePath, validatePagePath, type PagePathPage } from '../shared/pagePath';
import { PagePathInput } from './PagePathInput';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pages: PagePathPage[];
  initialDirectory?: string;
};

export function CreatePageDialog({ open, onOpenChange, pages, initialDirectory = '' }: Props) {
  const router = useRouter();
  const formId = useId();
  const errorId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const validation = useMemo(
    () => (title.trim() ? validatePagePath(title, pages) : null),
    [title, pages],
  );

  useEffect(() => {
    if (!open) return;
    setTitle(initialPagePath(initialDirectory));
    setBusy(false);
    setError('');
    setDirty(false);
    setSubmitted(false);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open, initialDirectory]);

  async function createPage() {
    if (busy) return;
    setSubmitted(true);
    const result = validatePagePath(title, pages);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setBusy(true);
    setError('');
    const created = await createPageByPath(result.path);
    if (!created.ok) {
      setError(created.message);
      setBusy(false);
      return;
    }
    onOpenChange(false);
    void router.visit(`/pages/${created.id}`);
  }

  const showValidation = dirty || submitted;
  const visibleError =
    error || (showValidation && validation && !validation.ok ? validation.message : '');
  const hint =
    !visibleError && !dirty && !submitted && title.trim().endsWith('/')
      ? 'ページ名を入力してください。'
      : '';
  const descriptionId = visibleError ? errorId : hint ? hintId : undefined;

  return (
    <LayerDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      dismissDisabled={busy}
    >
      <LayerDialog.Content size="sm" verticalAlign="center" closeLabel="閉じる">
        <LayerDialog.Title>新規ページ</LayerDialog.Title>
        <LayerDialog.Description>
          ページのパスを入力してください。「/」でディレクトリを区切ります。
        </LayerDialog.Description>
        <LayerDialog.Body>
          <form
            id={formId}
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void createPage();
            }}
          >
            <PagePathInput
              ref={inputRef}
              value={title}
              onChange={(value) => {
                setTitle(value);
                setDirty(true);
                if (error) setError('');
              }}
              pages={pages}
              placeholder="例: プロジェクト/設計"
              ariaLabel="新しいページのパス"
              required
              maxLength={200}
              invalid={Boolean(visibleError)}
              errorId={descriptionId}
            />
            {visibleError ? (
              <Text id={errorId} variant="error" size="sm" role="alert">
                {visibleError}
              </Text>
            ) : hint ? (
              <Text id={hintId} variant="secondary" size="sm">
                {hint}
              </Text>
            ) : null}
          </form>
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel="キャンセル">
          <LayerDialog.Action
            type="submit"
            form={formId}
            loading={busy}
            disabled={!title.trim() || busy || (validation !== null && !validation.ok)}
          >
            作成
          </LayerDialog.Action>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}
