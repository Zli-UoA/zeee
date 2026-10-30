import type { Props } from './index.server';
import { formatDate } from '../src/shared/format';

export default function Home({ user, pages, query, results, loginUrl }: Props) {
  return (
    <div className="home">
      <section className="hero">
        <p className="eyebrow">Shared knowledge</p>
        <h1>チームの知識を、ひとつの場所に。</h1>
        <p className="lede">
          Zli のメンバーが同じページをそのまま共同編集できる、Markdown のドキュメントツール。
        </p>
        {user ? (
          <div className="session">
            <span>{user.displayName} としてログイン中</span>
            <a href="/auth/logout">ログアウト</a>
          </div>
        ) : (
          <a className="button primary" href={loginUrl}>
            ログイン
          </a>
        )}
      </section>

      {user ? (
        <>
          <section className="panel">
            <form className="search-form" method="get" action="/">
              <input
                type="search"
                name="q"
                defaultValue={query}
                placeholder="ページを検索"
                aria-label="ページを検索"
              />
              <button type="submit">検索</button>
              {query ? <a href="/">クリア</a> : null}
            </form>

            <form className="create-form" method="post" action="/">
              <input
                type="text"
                name="title"
                placeholder="新しいページのタイトル"
                aria-label="新しいページのタイトル"
                required
                maxLength={200}
              />
              <button type="submit" className="button primary">
                ページを作成
              </button>
            </form>
          </section>

          {query ? (
            <section className="list">
              <div className="list-head">
                <h2>「{query}」の検索結果</h2>
                <span>{results.length}</span>
              </div>
              {results.length === 0 ? (
                <p className="empty">見つかりませんでした。</p>
              ) : (
                <ul>
                  {results.map((result) => (
                    <li key={result.id}>
                      <a href={`/pages/${result.id}`}>{result.title}</a>
                      <p>{result.excerpt}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : (
            <section className="list">
              <div className="list-head">
                <h2>ページ</h2>
                <span>{pages.length}</span>
              </div>
              {pages.length === 0 ? (
                <p className="empty">まだページがありません。最初の1ページを作りましょう。</p>
              ) : (
                <ul>
                  {pages.map((page) => (
                    <li key={page.id}>
                      <a href={`/pages/${page.id}`}>{page.title}</a>
                      <time>{formatDate(page.updatedAt)}</time>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      ) : null}
    </div>
  );
}
