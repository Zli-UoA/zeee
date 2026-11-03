import type { Props } from './[id].server';
import { AppShell } from '../../src/components/AppShell';
import { Editor } from '../../src/components/Editor';
import { Gate } from '../../src/components/Gate';

export default function PageView({
  user,
  page,
  deletedPageTitle,
  revisions,
  pages,
  recentPages,
  linkTargets,
  loginUrl,
}: Props) {
  return (
    <AppShell
      user={user}
      pages={pages}
      initialRecentPages={recentPages}
      activePageId={page?.id}
      activeTitle={page?.title}
      activeNav={user && !page ? 'not-found' : undefined}
    >
      {!user ? (
        <Gate
          title="ログインが必要です"
          description="Zeee は Zli のメンバーだけが使える知識ベース。"
          action={{ href: loginUrl, label: 'AuthZ でログイン' }}
        />
      ) : !page ? (
        <Gate
          title="ページがない"
          description={
            deletedPageTitle
              ? `「${deletedPageTitle}」は削除されています。必要な場合はゴミ箱から復元できます。`
              : 'URL が違うか、ページが存在しません。'
          }
          action={{ href: '/', label: 'すべてのページへ戻る' }}
          secondaryAction={deletedPageTitle ? { href: '/trash', label: 'ゴミ箱を見る' } : undefined}
        />
      ) : (
        <Editor
          key={page.id}
          page={page}
          user={user}
          revisions={revisions}
          pages={pages}
          linkTargets={linkTargets}
        />
      )}
    </AppShell>
  );
}
