import { useEffect, useState } from 'react';
import { Link } from '@void/react';
import { Button, Empty, LayerCard, LayerDialog, LinkButton, Text } from '@cloudflare/kumo';
import { ArrowCounterClockwiseIcon, TrashIcon } from '@phosphor-icons/react';
import type { Props } from './trash.server';
import { AppShell } from '../src/components/AppShell';
import { Gate } from '../src/components/Gate';
import { formatDate } from '../src/shared/format';
import type { DeletedPageSummary } from '../src/server/types';

type Pending = { id: string; action: 'restore' | 'purge' } | null;

type Notice = { kind: 'restored'; id: string; title: string } | { kind: 'purged'; title: string };

export default function TrashPage({
  user,
  pages,
  recentPages,
  deletedPages: initialDeletedPages,
  loginUrl,
}: Props) {
  const [deletedPages, setDeletedPages] = useState(initialDeletedPages);
  const [pending, setPending] = useState<Pending>(null);
  const [confirming, setConfirming] = useState<DeletedPageSummary | null>(null);
  const [shownConfirming, setShownConfirming] = useState<DeletedPageSummary | null>(null);
  const [error, setError] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const purgeBusy = pending?.action === 'purge';

  useEffect(() => {
    if (confirming) setShownConfirming(confirming);
  }, [confirming]);

  async function restore(page: DeletedPageSummary) {
    if (pending) return;
    setPending({ id: page.id, action: 'restore' });
    setError('');
    setNotice(null);
    try {
      const response = await fetch(`/api/pages/${page.id}/undelete`, { method: 'POST' });
      if (!response.ok) {
        setError(
          response.status === 404
            ? 'ページが見つかりませんでした。すでに復元または削除された可能性があります。'
            : '復元できませんでした。接続を確認して再試行してください。',
        );
        return;
      }
      setDeletedPages((current) => current.filter((item) => item.id !== page.id));
      setNotice({ kind: 'restored', id: page.id, title: page.title });
    } catch {
      setError('復元できませんでした。接続を確認して再試行してください。');
    } finally {
      setPending(null);
    }
  }

  function openConfirm(page: DeletedPageSummary) {
    if (pending) return;
    setDialogError('');
    setConfirming(page);
  }

  async function purge(page: DeletedPageSummary) {
    if (pending) return;
    setPending({ id: page.id, action: 'purge' });
    setDialogError('');
    try {
      const response = await fetch(`/api/pages/${page.id}/permanent`, { method: 'DELETE' });
      if (!response.ok) {
        setDialogError(
          response.status === 404
            ? 'ページが見つかりませんでした。すでに復元または削除された可能性があります。'
            : '完全に削除できませんでした。接続を確認して再試行してください。',
        );
        return;
      }
      setDeletedPages((current) => current.filter((item) => item.id !== page.id));
      setConfirming(null);
      setNotice({ kind: 'purged', title: page.title });
    } catch {
      setDialogError('完全に削除できませんでした。接続を確認して再試行してください。');
    } finally {
      setPending(null);
    }
  }

  return (
    <AppShell
      user={user}
      pages={pages}
      initialRecentPages={recentPages}
      activeTitle="ゴミ箱"
      activeNav="trash"
    >
      {!user ? (
        <Gate
          title="ログインが必要です"
          description="Zeee は Zli のメンバーだけが使える知識ベース。"
          action={{ href: loginUrl, label: 'AuthZ でログイン' }}
        />
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            <Text variant="heading" size="lg" as="h1">
              ゴミ箱
            </Text>
            <Text variant="secondary" size="sm">
              {deletedPages.length > 0
                ? `削除済みのページ ${deletedPages.length}件。復元するか、完全に削除できます。`
                : '削除したページはここから復元できます。完全に削除するまで本文と履歴は残ります。'}
            </Text>
          </div>

          {notice ? (
            <div
              role="status"
              className="rounded-lg border border-kumo-line bg-kumo-tint px-4 py-3"
            >
              <Text variant="secondary" size="sm">
                {notice.kind === 'restored'
                  ? `「${notice.title}」を復元しました。`
                  : `「${notice.title}」を完全に削除しました。`}
                {notice.kind === 'restored' ? (
                  <>
                    {' '}
                    <Link
                      className="rounded-sm text-kumo-link focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:outline-none"
                      href={`/pages/${notice.id}`}
                    >
                      ページを開く
                    </Link>
                  </>
                ) : null}
              </Text>
            </div>
          ) : null}

          {error ? (
            <div role="alert">
              <Text variant="error" size="sm">
                {error}
              </Text>
            </div>
          ) : null}

          {deletedPages.length === 0 ? (
            <Empty
              icon={<TrashIcon size={32} />}
              title="ゴミ箱は空です"
              description="ページを削除すると、ここに表示されます。"
              contents={
                <LinkButton href="/" variant="secondary">
                  ページ一覧へ戻る
                </LinkButton>
              }
            />
          ) : (
            <LayerCard className="overflow-hidden p-0">
              <ul aria-label="削除済みのページ" className="divide-y divide-kumo-line">
                {deletedPages.map((page) => (
                  <li
                    key={page.id}
                    className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-kumo-strong">{page.title}</p>
                      {page.excerpt ? (
                        <p className="line-clamp-1 text-sm text-kumo-subtle">{page.excerpt}</p>
                      ) : null}
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-kumo-subtle">
                        <span>
                          <span className="sr-only">削除日時 </span>
                          <time dateTime={new Date(page.deletedAt).toISOString()}>
                            {formatDate(page.deletedAt)}
                          </time>
                          に削除
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                          <span className="sr-only">更新日時 </span>
                          <time dateTime={new Date(page.updatedAt).toISOString()}>
                            {formatDate(page.updatedAt)}
                          </time>
                          に更新
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="max-w-full truncate">
                          {page.createdByName || '不明なユーザー'}
                        </span>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        icon={<ArrowCounterClockwiseIcon size={14} />}
                        onClick={() => void restore(page)}
                        loading={pending?.id === page.id && pending.action === 'restore'}
                        disabled={pending !== null}
                        aria-label={`「${page.title}」を復元`}
                      >
                        復元
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary-destructive"
                        icon={<TrashIcon size={14} />}
                        onClick={() => openConfirm(page)}
                        loading={pending?.id === page.id && pending.action === 'purge'}
                        disabled={pending !== null}
                        aria-label={`「${page.title}」を完全に削除`}
                      >
                        完全に削除
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </LayerCard>
          )}
        </div>
      )}

      <LayerDialog.Root
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open && !purgeBusy) {
            setConfirming(null);
            setDialogError('');
          }
        }}
        dismissDisabled={purgeBusy}
      >
        {shownConfirming ? (
          <LayerDialog.Content size="sm" verticalAlign="center" closeLabel="閉じる">
            <LayerDialog.Title>「{shownConfirming.title}」を完全に削除しますか？</LayerDialog.Title>
            <LayerDialog.Description>
              本文とすべての履歴を削除します。この操作は元に戻せません。
            </LayerDialog.Description>
            <LayerDialog.Body>
              {dialogError ? (
                <div role="alert">
                  <Text variant="error" size="sm">
                    {dialogError}
                  </Text>
                </div>
              ) : (
                <Text variant="secondary" size="sm">
                  本当に不要なページだけを完全削除してください。復元が必要な場合はキャンセルして「復元」を選びます。
                </Text>
              )}
            </LayerDialog.Body>
            <LayerDialog.Actions dismissLabel="キャンセル">
              <LayerDialog.Action
                variant="destructive"
                onClick={() => void purge(shownConfirming)}
                loading={purgeBusy}
              >
                完全に削除
              </LayerDialog.Action>
            </LayerDialog.Actions>
          </LayerDialog.Content>
        ) : null}
      </LayerDialog.Root>
    </AppShell>
  );
}
