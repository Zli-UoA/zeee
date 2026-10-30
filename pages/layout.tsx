import type { ReactNode } from 'react';
import '../src/styles.css';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="site-header">
        <a className="brand" href="/" aria-label="Zeee home">
          Z<span>eee</span>
        </a>
        <p className="tagline">
          Zli shar<em>E</em>d knowl<em>E</em>dg<em>E</em>
        </p>
        <span className="header-mark">ZLI / 2026</span>
      </header>
      <main className="site-main">{children}</main>
      <footer className="site-footer">
        <span className="footer-mark">Zeee</span>
        <span>Zli sharEd knowlEdgE</span>
        <span>Shared knowledge, written together.</span>
      </footer>
    </>
  );
}
