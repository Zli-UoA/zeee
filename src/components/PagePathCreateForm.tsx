import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { useRouter } from '@void/react';
import { Button, Text } from '@cloudflare/kumo';
import { PlusIcon } from '@phosphor-icons/react';
import { createPageByPath } from '../client/pagePathApi';
import { validatePagePath, type PagePathPage } from '../shared/pagePath';
import { PagePathInput } from './PagePathInput';

type Props = {
  pages: PagePathPage[];
  defaultValue?: string;
  submitLabel?: string;
  ariaLabel?: string;
  autoFocus?: boolean;
  className?: string;
};

export function PagePathCreateForm({
  pages,
  defaultValue = '',
  submitLabel = '作成',
  ariaLabel = '新しいページのパス',
  autoFocus,
  className,
}: Props) {
  const router = useRouter();
  const errorId = useId();
  const hintId = useId();
  const [title, setTitle] = useState(defaultValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const validation = useMemo(
    () => (title.trim() ? validatePagePath(title, pages) : null),
    [title, pages],
  );

  useEffect(() => {
    setTitle(defaultValue);
    setError('');
    setDirty(false);
    setSubmitted(false);
  }, [defaultValue]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setSubmitted(true);
    const validation = validatePagePath(title, pages);
    if (!validation.ok) return;
    setBusy(true);
    setError('');
    const result = await createPageByPath(validation.path);
    if (!result.ok) {
      setError(result.message);
      setBusy(false);
      return;
    }
    void router.visit(`/pages/${result.id}`);
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
    <form
      method="post"
      action="/"
      className={`flex w-full flex-col gap-2 ${className ?? ''}`}
      onSubmit={submit}
    >
      <div className="flex w-full items-center gap-2">
        <PagePathInput
          value={title}
          onChange={(value) => {
            setTitle(value);
            setDirty(true);
            if (error) setError('');
          }}
          pages={pages}
          name="title"
          ariaLabel={ariaLabel}
          placeholder="例: プロジェクト/設計"
          required
          maxLength={200}
          autoFocus={autoFocus}
          invalid={Boolean(visibleError)}
          errorId={descriptionId}
          className="min-w-0 flex-1"
        />
        <Button type="submit" variant="primary" icon={<PlusIcon size={14} />} loading={busy}>
          {submitLabel}
        </Button>
      </div>
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
  );
}
