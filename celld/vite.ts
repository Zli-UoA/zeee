import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import type { Plugin } from 'vite';

const CELD_KEYS = [
  'name',
  'main',
  'compatibility_date',
  'compatibility_flags',
  'vars',
  'durable_objects',
  'migrations',
  'services',
  'triggers',
  'd1_databases',
  'kv_namespaces',
  'queues',
  'workflows',
  'r2_buckets',
  'worker_loaders',
  'containers',
] as const;

const ASSET_KEYS = ['binding', 'html_handling', 'not_found_handling', 'run_worker_first'] as const;

export function voidCelld(): Plugin {
  let root = process.cwd();

  return {
    name: 'void-celld',
    enforce: 'post',
    configResolved(config) {
      root = config.root;
    },
    closeBundle() {
      if (process.env.CELLD_BUILD !== '1') return;

      // The Cloudflare Vite plugin writes dist/ssr/wrangler.json from its own
      // closeBundle hook. Run after it instead of depending on plugin order.
      setTimeout(() => {
        const dist = join(root, 'dist');
        const ssr = join(dist, 'ssr');
        const sourcePath = join(ssr, 'wrangler.json');
        if (!existsSync(sourcePath)) return;

        const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
        const config: Record<string, unknown> = {};

        for (const key of CELD_KEYS) {
          if (source[key] !== undefined) config[key] = source[key];
        }

        config.main = posix.join('ssr', String(source.main ?? 'index.js'));

        if (source.assets) {
          const assets: Record<string, unknown> = {};
          for (const key of ASSET_KEYS) {
            if (source.assets[key] !== undefined) assets[key] = source.assets[key];
          }
          assets.directory = 'client';
          config.assets = assets;
        }

        if (Array.isArray(config.d1_databases)) {
          const databases = config.d1_databases as Array<Record<string, unknown>>;
          config.d1_databases = databases.map((entry) => {
            const { migrations_dir, ...rest } = entry;
            if (typeof migrations_dir === 'string') {
              const from = resolve(ssr, migrations_dir);
              if (existsSync(from)) {
                const to = join(dist, 'migrations', String(entry.binding));
                rmSync(to, { recursive: true, force: true });
                cpSync(from, to, { recursive: true });
                rest.migrations_dir = `migrations/${String(entry.binding)}`;
              }
            }
            return rest;
          });
        }

        writeFileSync(join(dist, 'wrangler.json'), `${JSON.stringify(config, null, 2)}\n`);
        rmSync(join(dist, 'client', '.assetsignore'), { force: true });
      }, 0);
    },
  };
}
