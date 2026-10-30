import type { ReactNode } from 'react';
import '../src/styles.css';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="site-header">
        <a className="brand" href="/">
          Zeee
        </a>
        <span className="tagline">Zli sharEd knowlEdgE</span>
      </header>
      <main className="site-main">{children}</main>
    </>
  );
}
