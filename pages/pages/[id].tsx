import type { Props } from './[id].server';
import { Editor } from '../../src/components/Editor';

export default function PageView({ user, page, revisions, loginUrl }: Props) {
  if (!user) {
    return (
      <div className="gate">
        <span className="gate-index">01</span>
        <h1>ログインが必要です</h1>
        <p>Zeee は Zli のメンバーだけが使える、招待制の知識ベース。</p>
        <a className="button loud" href={loginUrl}>
          AuthZ でログイン <span aria-hidden="true">↗</span>
        </a>
      </div>
    );
  }

  if (!page) {
    return (
      <div className="gate">
        <span className="gate-index">404</span>
        <h1>ページがない</h1>
        <p>削除されたか、URL が違うかもしれない。</p>
        <a className="button" href="/">
          Index へ <span aria-hidden="true">↗</span>
        </a>
      </div>
    );
  }

  return (
    <div className="page-view">
      <div className="page-top">
        <a className="back" href="/">
          ← Index
        </a>
        <span className="page-crumb">Zeee / {page.title}</span>
      </div>
      <Editor page={page} user={user} revisions={revisions} />
    </div>
  );
}
