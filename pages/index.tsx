import type { Props } from './index.server';
import { formatDate } from '../src/shared/format';

export default function Home({ user, pages, query, results, loginUrl }: Props) {
  const entries = query ? results : pages;
  const count = entries.length;

  return (
    <div className="home">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Zli shared knowledge</p>
          <h1>
            チームの知識を、
            <br />
            <em>ひとつの場所</em>に。
          </h1>
          <p className="lede">
            書いた人の思考が、次の誰かの手ざわりで更新されていく。 Zeee は Zli
            のための、静かな共同編集ノート。
          </p>
          {user ? (
            <div className="session">
              <span>
                Signed in as <strong>{user.displayName}</strong>
              </span>
              <a href="/auth/logout">ログアウト</a>
            </div>
          ) : (
            <a className="button loud" href={loginUrl}>
              AuthZ でログイン <span aria-hidden="true">↗</span>
            </a>
          )}
        </div>
        <aside className="hero-meta" aria-label="Zeee">
          <span className="vertical">共有知 / ZLI</span>
          <span className="meta-year">26</span>
          <span className="meta-count">
            {String(count).padStart(2, '0')} {query ? 'hits' : 'pages'}
          </span>
        </aside>
      </section>

      {user ? (
        <>
          <section className="desk" aria-label="Create and search">
            <form className="create-form" method="post" action="/">
              <label className="field-label" htmlFor="new-page">
                New page
              </label>
              <div className="line-input">
                <input
                  id="new-page"
                  type="text"
                  name="title"
                  placeholder="ページのタイトル"
                  required
                  maxLength={200}
                  autoComplete="off"
                />
                <button type="submit">
                  作成 <span aria-hidden="true">↗</span>
                </button>
              </div>
            </form>

            <form className="search-form" method="get" action="/">
              <label className="field-label" htmlFor="search">
                Search the index
              </label>
              <div className="line-input">
                <input
                  id="search"
                  type="search"
                  name="q"
                  defaultValue={query}
                  placeholder="言葉を探す"
                  autoComplete="off"
                />
                <button type="submit">検索</button>
              </div>
              {query ? (
                <a className="clear-search" href="/">
                  クリア
                </a>
              ) : null}
            </form>
          </section>

          <section className="index" aria-label={query ? 'Search results' : 'Page index'}>
            <div className="index-head">
              <span>{query ? `Search / ${query}` : 'Index'}</span>
              <span>{String(count).padStart(2, '0')} entries</span>
            </div>

            {count === 0 ? (
              <div className="index-empty">
                <span className="empty-num">{query ? '00' : '01'}</span>
                <p>
                  {query
                    ? 'その言葉は、まだどこにも書かれていない。'
                    : '最初のページを書いて、この索引をはじめよう。'}
                </p>
              </div>
            ) : (
              <ol>
                {entries.map((entry, index) => (
                  <li key={entry.id}>
                    <a href={`/pages/${entry.id}`}>
                      <span className="index-num">{String(index + 1).padStart(2, '0')}</span>
                      <span className="index-body">
                        <span className="index-title">{entry.title}</span>
                        {'excerpt' in entry && entry.excerpt ? (
                          <span className="index-excerpt">{entry.excerpt}</span>
                        ) : null}
                      </span>
                      <time className="index-date">
                        {'updatedAt' in entry ? formatDate(entry.updatedAt) : ''}
                      </time>
                      <span className="index-arrow" aria-hidden="true">
                        ↗
                      </span>
                    </a>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      ) : (
        <section className="intro-note">
          <span className="intro-rule" />
          <p>
            Zli のメンバーだけが使える、招待制の知識ベース。
            <br />
            ログインするとページの作成と共同編集ができる。
          </p>
        </section>
      )}
    </div>
  );
}
