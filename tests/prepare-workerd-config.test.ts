import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

const script = fileURLToPath(new URL('../scripts/prepare-workerd-config.mjs', import.meta.url));

const baseConfig = {
  name: 'zeee',
  main: 'ssr/index.js',
  durable_objects: { bindings: [] },
  d1_databases: [],
  assets: { directory: 'client' },
};

function prepare(config: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'zeee-workerd-config-'));
  try {
    const file = join(dir, 'wrangler.json');
    writeFileSync(file, `${JSON.stringify(config)}\n`);
    const result = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
    return {
      status: result.status,
      stderr: result.stderr,
      config:
        result.status === 0
          ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)
          : undefined,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('prepare-workerd-config', () => {
  it('drops empty celld-only placeholders', () => {
    const result = prepare({ ...baseConfig, services: [], worker_loaders: [], containers: {} });
    expect(result.status).toBe(0);
    expect(result.config).not.toHaveProperty('services');
    expect(result.config).not.toHaveProperty('worker_loaders');
    expect(result.config).not.toHaveProperty('containers');
  });

  it('fails on a non-empty celld-only key instead of silently dropping it', () => {
    const result = prepare({
      ...baseConfig,
      services: [{ name: 'emoji', service: 'emoji' }],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('::error::');
    expect(result.stderr).toContain('services');
    expect(result.stderr).toContain('emoji');
  });
});
