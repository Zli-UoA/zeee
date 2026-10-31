import type { Props } from './[id].server';
import { AppShell } from '../../src/components/AppShell';
import { Editor } from '../../src/components/Editor';
import { Gate } from '../../src/components/Gate';

export default function PageView({
  user,
  page,
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
          description="削除されたか、URL が違うかもしれない。"
          action={{ href: '/', label: 'ページ一覧へ戻る' }}
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
