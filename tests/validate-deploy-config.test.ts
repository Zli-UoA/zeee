import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

const script = fileURLToPath(new URL('../scripts/validate-deploy-config.mjs', import.meta.url));

const baseConfig = {
  name: 'zeee',
  vars: {
    AUTHZ_ISSUER: 'https://account.zli.works/api/auth',
    AUTHZ_CLIENT_ID: 'ocfGoISXBgnRMqogOLEdYsZUXusTBczV',
    PUBLIC_ORIGIN: 'https://zeee.zli.works',
    ZEEE_MIGRATION_IMPORT: '',
  },
  d1_databases: [{ binding: 'DB', database_name: 'zeee' }],
  durable_objects: {
    bindings: [{ name: 'PAGE_ROOM', class_name: 'PageRoomDurableObject' }],
  },
};

function validate(
  config: Record<string, unknown>,
  options: { devVars?: boolean } = {},
): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'zeee-deploy-config-'));
  try {
    const file = join(dir, 'wrangler.json');
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    if (options.devVars) writeFileSync(join(dir, '.dev.vars'), 'ZEEE_DEV_AUTH=1\n');
    const result = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('validate-deploy-config', () => {
  it('accepts the production config with an empty migration flag', () => {
    const result = validate(baseConfig);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('validation passed');
  });

  it('accepts a config with no migration flag at all', () => {
    const vars: Record<string, unknown> = { ...baseConfig.vars };
    delete vars.ZEEE_MIGRATION_IMPORT;
    const result = validate({ ...baseConfig, vars });
    expect(result.status).toBe(0);
  });

  it('rejects every non-empty migration flag value', () => {
    for (const value of ['1', '0', 'true', ' ']) {
      const result = validate({
        ...baseConfig,
        vars: { ...baseConfig.vars, ZEEE_MIGRATION_IMPORT: value },
      });
      expect(result.status, `value ${JSON.stringify(value)}`).toBe(1);
      expect(result.stderr).toContain('::error::');
      expect(result.stderr).toContain('ZEEE_MIGRATION_IMPORT');
      expect(result.stderr).toContain(JSON.stringify(value));
    }
  });

  it('still rejects ZEEE_DEV_AUTH in vars', () => {
    const result = validate({
      ...baseConfig,
      vars: { ...baseConfig.vars, ZEEE_DEV_AUTH: '1' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ZEEE_DEV_AUTH');
  });

  it('still rejects a shipped .dev.vars file', () => {
    const result = validate(baseConfig, { devVars: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.dev.vars');
  });

  it('still validates the worker, origin, D1 and Durable Object bindings', () => {
    const wrongName = validate({ ...baseConfig, name: 'zeee-dev' });
    expect(wrongName.status).toBe(1);
    expect(wrongName.stderr).toContain('zeee-dev');

    const wrongOrigin = validate({
      ...baseConfig,
      vars: { ...baseConfig.vars, PUBLIC_ORIGIN: 'http://127.0.0.1:9876' },
    });
    expect(wrongOrigin.status).toBe(1);
    expect(wrongOrigin.stderr).toContain('PUBLIC_ORIGIN');

    const missingIssuer = validate({
      ...baseConfig,
      vars: {
        AUTHZ_CLIENT_ID: 'ocfGoISXBgnRMqogOLEdYsZUXusTBczV',
        PUBLIC_ORIGIN: 'https://zeee.zli.works',
      },
    });
    expect(missingIssuer.status).toBe(1);
    expect(missingIssuer.stderr).toContain('AUTHZ_ISSUER');

    const missingDb = validate({ ...baseConfig, d1_databases: [] });
    expect(missingDb.status).toBe(1);
    expect(missingDb.stderr).toContain('D1 binding');

    const missingRoom = validate({ ...baseConfig, durable_objects: { bindings: [] } });
    expect(missingRoom.status).toBe(1);
    expect(missingRoom.stderr).toContain('PAGE_ROOM');
  });
});
