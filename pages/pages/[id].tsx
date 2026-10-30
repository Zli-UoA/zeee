import type { Props } from './[id].server';
import { Editor } from '../../src/components/Editor';

export default function PageView({ user, page, revisions, loginUrl }: Props) {
  if (!user) {
    return (
      <div className="centered">
        <h1>ログインが必要です</h1>
        <p>ページを開くにはログインしてください。</p>
        <a className="button primary" href={loginUrl}>
          ログイン
        </a>
      </div>
    );
  }

  if (!page) {
    return (
      <div className="centered">
        <h1>ページがありません</h1>
        <p>削除されたか、URL が違う可能性があります。</p>
        <a className="button" href="/">
          ページ一覧へ
        </a>
      </div>
    );
  }

  return (
    <div className="page-view">
      <a className="back" href="/">
        ← ページ一覧
      </a>
      <Editor page={page} user={user} revisions={revisions} />
    </div>
  );
}
