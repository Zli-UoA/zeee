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

type ValidationResult = { status: number | null; stdout: string; stderr: string };

function runValidation(setup: (dir: string, file: string) => void): ValidationResult {
  const dir = mkdtempSync(join(tmpdir(), 'zeee-deploy-config-'));
  try {
    const file = join(dir, 'wrangler.json');
    setup(dir, file);
    const result = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function validate(
  config: Record<string, unknown>,
  options: { devVars?: boolean } = {},
): ValidationResult {
  return runValidation((dir, file) => {
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    if (options.devVars) writeFileSync(join(dir, '.dev.vars'), 'ZEEE_DEV_AUTH=1\n');
  });
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
    for (const value of ['1', '0', 'false', 'true', ' ']) {
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

  it('rejects non-string migration flag values', () => {
    for (const value of [1, true, null, {}, []]) {
      const result = validate({
        ...baseConfig,
        vars: { ...baseConfig.vars, ZEEE_MIGRATION_IMPORT: value },
      });
      expect(result.status, `value ${JSON.stringify(value)}`).toBe(1);
      expect(result.stderr).toContain('::error::');
      expect(result.stderr).toContain('ZEEE_MIGRATION_IMPORT');
    }
  });

  it('rejects an unreadable config file', () => {
    const result = runValidation(() => {});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('::error::');
    expect(result.stderr).toContain('Could not read');
  });

  it('rejects a config file that is not valid JSON', () => {
    const result = runValidation((_, file) => {
      writeFileSync(file, '{ "name": \n');
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('::error::');
    expect(result.stderr).toContain('Could not read');
  });

  it('rejects a config that is not a JSON object', () => {
    for (const content of ['null', '[]', '"zeee"']) {
      const result = runValidation((_, file) => {
        writeFileSync(file, content);
      });
      expect(result.status, content).toBe(1);
      expect(result.stderr).toContain('must contain a JSON object');
    }
  });

  it('escapes %, CR and LF in ::error:: message data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeee-deploy-config-'));
    try {
      const file = join(dir, '100%na\rme\nwrangler.json');
      const result = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('::error::');
      expect(result.stderr).toContain('100%25na%0Dme%0Awrangler.json');
      expect(result.stderr).not.toContain('100%na');
    } finally {
      rmSync(dir, { recursive: true, force: true });
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

  it('still validates the worker, origin, auth vars, D1 and Durable Object bindings', () => {
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

    const missingClientId = validate({
      ...baseConfig,
      vars: {
        AUTHZ_ISSUER: 'https://account.zli.works/api/auth',
        PUBLIC_ORIGIN: 'https://zeee.zli.works',
      },
    });
    expect(missingClientId.status).toBe(1);
    expect(missingClientId.stderr).toContain('AUTHZ_CLIENT_ID');

    const missingDb = validate({ ...baseConfig, d1_databases: [] });
    expect(missingDb.status).toBe(1);
    expect(missingDb.stderr).toContain('D1 binding');

    const wrongDbName = validate({
      ...baseConfig,
      d1_databases: [{ binding: 'DB', database_name: 'zeee-dev' }],
    });
    expect(wrongDbName.status).toBe(1);
    expect(wrongDbName.stderr).toContain('zeee-dev');

    const dbNameFallback = validate({
      ...baseConfig,
      d1_databases: [{ binding: 'DB', name: 'zeee' }],
    });
    expect(dbNameFallback.status).toBe(0);

    const wrongDbNameFallback = validate({
      ...baseConfig,
      d1_databases: [{ binding: 'DB', name: 'zeee-dev' }],
    });
    expect(wrongDbNameFallback.status).toBe(1);
    expect(wrongDbNameFallback.stderr).toContain('zeee-dev');

    const missingRoom = validate({ ...baseConfig, durable_objects: { bindings: [] } });
    expect(missingRoom.status).toBe(1);
    expect(missingRoom.stderr).toContain('PAGE_ROOM');
  });
});
