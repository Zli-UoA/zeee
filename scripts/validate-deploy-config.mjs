import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Shared by the deploy workflow so the production config guard is unit-testable.
// Usage: node scripts/validate-deploy-config.mjs [dist/wrangler.json]
const configPath = process.argv[2] ?? 'dist/wrangler.json';

// GitHub Actions workflow commands need message data escaped so that user-
// controlled values cannot inject extra commands or break the log line.
const escapeMessageData = (message) =>
  String(message).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

const fail = (message) => {
  console.error(`::error::${escapeMessageData(message)}`);
  process.exit(1);
};

let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (error) {
  fail(`Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
}

if (!config || typeof config !== 'object' || Array.isArray(config)) {
  fail(`${configPath} must contain a JSON object`);
}

if (config.name !== 'zeee') {
  fail(`Expected worker name "zeee", got ${JSON.stringify(config.name)}`);
}

if (config.vars?.PUBLIC_ORIGIN !== 'https://zeee.zli.works') {
  fail(
    `Expected PUBLIC_ORIGIN "https://zeee.zli.works", got ${JSON.stringify(config.vars?.PUBLIC_ORIGIN)}`,
  );
}

for (const key of ['AUTHZ_ISSUER', 'AUTHZ_CLIENT_ID']) {
  if (!config.vars?.[key]) {
    fail(`Missing vars.${key}`);
  }
}

if (Object.hasOwn(config.vars ?? {}, 'ZEEE_DEV_AUTH')) {
  fail('ZEEE_DEV_AUTH must not be present in the production config');
}

// The DO state import endpoint is gated on ZEEE_MIGRATION_IMPORT === '1'.
// A build carrying that flag must never reach production: only the empty
// string (the config default) or an absent var is acceptable here.
const migrationImport = config.vars?.ZEEE_MIGRATION_IMPORT;
if (migrationImport !== undefined && migrationImport !== '') {
  fail(
    `ZEEE_MIGRATION_IMPORT must be empty in the production config, got ${JSON.stringify(migrationImport)}`,
  );
}

const db = (config.d1_databases ?? []).find((binding) => binding.binding === 'DB');
if (!db) {
  fail('Missing D1 binding "DB"');
}
const dbName = db.database_name ?? db.name;
if (dbName !== 'zeee') {
  fail(`Expected D1 database name "zeee", got ${JSON.stringify(dbName)}`);
}

const pageRoom = (config.durable_objects?.bindings ?? []).find(
  (binding) => binding.name === 'PAGE_ROOM',
);
if (!pageRoom) {
  fail('Missing Durable Object binding "PAGE_ROOM"');
}

if (existsSync(join(dirname(configPath), '.dev.vars'))) {
  fail(`${dirname(configPath)}/.dev.vars must not be shipped`);
}

console.log(`${configPath} validation passed`);
