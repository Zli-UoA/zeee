import type { Props } from './[id].server';
import { AppShell } from '../../src/components/AppShell';
import { Editor } from '../../src/components/Editor';
import { Gate } from '../../src/components/Gate';

export default function PageView({ user, page, revisions, pages, loginUrl }: Props) {
  return (
    <AppShell
      user={user}
      pages={pages}
      activePageId={page?.id}
      activeTitle={page?.title}
      loginUrl={loginUrl}
    >
      {!user ? (
        <Gate
          code="AUTH / 01"
          title="ログインが必要です"
          description="Zeee は Zli のメンバーだけが使える、招待制の知識ベース。"
          action={{ href: loginUrl, label: 'AuthZ でログイン' }}
        />
      ) : !page ? (
        <Gate
          code="NOT FOUND / 404"
          title="ページがない"
          description="削除されたか、URL が違うかもしれない。"
          action={{ href: '/', label: 'Index へ戻る' }}
        />
      ) : (
        <Editor page={page} user={user} revisions={revisions} />
      )}
    </AppShell>
  );
}
