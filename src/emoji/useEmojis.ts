import { useEffect, useState } from 'react';
import type { CustomEmoji } from './client';
type Catalog = { emojis: CustomEmoji[]; management_url: string | null };
let value: Catalog = { emojis: [], management_url: null };
let fetched = 0;
let pending: Promise<Catalog> | undefined;
async function load() {
  if (Date.now() - fetched < 60_000) return value;
  pending ??= (async () => {
    try {
      const response = await fetch('/api/emojis');
      if (!response.ok) throw Error('unavailable');
      value = (await response.json()) as Catalog;
      fetched = Date.now();
    } catch {
      /* Preserve the last successfully fetched catalog. */
    }
    return value;
  })().finally(() => {
    pending = undefined;
  });
  return pending;
}
export function useEmojis() {
  const [catalog, setCatalog] = useState<Catalog>(value);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void load().then((next) => {
        if (active) setCatalog(next);
      });
    };
    refresh();
    const timer = setInterval(refresh, 60_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  return catalog;
}
