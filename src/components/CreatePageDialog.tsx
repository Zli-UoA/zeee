import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from '@void/react';
import { Input, LayerDialog, Text } from '@cloudflare/kumo';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function CreatePageDialog({ open, onOpenChange }: Props) {
  const router = useRouter();
  const formId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setBusy(false);
    setError('');
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  async function createPage() {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/pages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!response.ok) throw new Error(`create failed: ${response.status}`);
      const data = (await response.json()) as { page?: { id?: unknown } };
      const pageId = data.page?.id;
      if (typeof pageId !== 'string' || !pageId) throw new Error('invalid response');
      onOpenChange(false);
      void router.visit(`/pages/${pageId}`);
    } catch {
      setError('ページを作成できませんでした。もう一度お試しください。');
      setBusy(false);
    }
  }

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
        <LayerDialog.Description>ページタイトルを入力してください。</LayerDialog.Description>
        <LayerDialog.Body>
          <form
            id={formId}
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void createPage();
            }}
          >
            <Input
              ref={inputRef}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                if (error) setError('');
              }}
              placeholder="ページタイトル"
              aria-label="ページタイトル"
              required
              maxLength={200}
            />
            {error ? (
              <Text variant="error" size="sm">
                {error}
              </Text>
            ) : null}
          </form>
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel="キャンセル">
          <LayerDialog.Action
            type="submit"
            form={formId}
            loading={busy}
            disabled={!title.trim() || busy}
          >
            作成
          </LayerDialog.Action>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}
