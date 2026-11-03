import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter } from '@void/react';
import { LayerDialog, Text } from '@cloudflare/kumo';
import { createPageByPath } from '../client/pagePathApi';
import { validatePagePath, type PagePathPage } from '../shared/pagePath';
import { PagePathInput } from './PagePathInput';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pages: PagePathPage[];
  initialValue?: string;
};

export function CreatePageDialog({ open, onOpenChange, pages, initialValue = '' }: Props) {
  const router = useRouter();
  const formId = useId();
  const hintId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const trimmed = title.trim();
  const incomplete = trimmed.endsWith('/');
  const validation = useMemo(
    () => (trimmed && !incomplete ? validatePagePath(title, pages) : null),
    [title, trimmed, incomplete, pages],
  );
  const visibleError = error || (validation && !validation.ok ? validation.message : '');

  useEffect(() => {
    if (!open) return;
    setTitle(initialValue);
    setBusy(false);
    setError('');
    const timer = window.setTimeout(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, initialValue]);

  async function createPage() {
    if (busy) return;
    if (incomplete) {
      setError('最後のセグメントを入力してください。');
      return;
    }
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

  const canCreate = Boolean(trimmed) && !incomplete && validation !== null && validation.ok;

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
          ページは階層の末尾にだけ作れます。
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
                if (error) setError('');
              }}
              pages={pages}
              placeholder="例: プロジェクト/設計"
              ariaLabel="新しいページのパス"
              required
              maxLength={200}
              invalid={Boolean(visibleError)}
              errorId={visibleError ? errorId : hintId}
            />
            {incomplete ? (
              <Text id={hintId} variant="secondary" size="sm">
                最後のセグメントを入力してください。
              </Text>
            ) : visibleError ? (
              <Text id={errorId} variant="error" size="sm" role="alert">
                {visibleError}
              </Text>
            ) : (
              <Text id={hintId} variant="secondary" size="sm">
                既存ページの下に子ページは作成できません。ページをディレクトリにしたい場合は、先に
                そのページのパスを変更するか削除してください。
              </Text>
            )}
          </form>
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel="キャンセル">
          <LayerDialog.Action
            type="submit"
            form={formId}
            loading={busy}
            disabled={!canCreate || busy}
          >
            作成
          </LayerDialog.Action>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}
