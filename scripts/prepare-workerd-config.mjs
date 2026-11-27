import { readFileSync, writeFileSync } from 'node:fs';

// workerd's wrangler.json reader (workerd >= 1.20261127.1) only understands
// this set of top-level keys. Anything else makes `workerd serve` abort before
// the worker starts. See the schema reported by `workerd serve` on a bad key.
const SUPPORTED_KEYS = new Set([
  '$schema',
  'name',
  'main',
  'compatibility_date',
  'compatibility_flags',
  'vars',
  'durable_objects',
  'exports',
  'migrations',
  'kv_namespaces',
  'r2_buckets',
  'triggers',
  'queues',
  'workflows',
  'd1_databases',
  'secrets_store_secrets',
  'ratelimits',
  'no_bundle',
  'assets',
]);

// void/celld emit these placeholders in the built config. They have no meaning
// to workerd, so drop them for the local smoke test — but only while they are
// empty. A non-empty value (e.g. a service binding) must fail loudly instead of
// being silently dropped, which would give the smoke test a false negative for
// unknown/unsupported keys.
const CELD_ONLY_KEYS = new Set(['services', 'worker_loaders', 'containers']);

function isEmptyPlaceholder(value) {
  if (Array.isArray(value)) return value.length === 0;
  if (value !== null && typeof value === 'object') {
    return Object.keys(value).length === 0;
  }
  return false;
}

const configPath = process.argv[2];
if (!configPath) {
  console.error('usage: node scripts/prepare-workerd-config.mjs <wrangler.json>');
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const dropped = [];

for (const key of Object.keys(config)) {
  if (SUPPORTED_KEYS.has(key)) continue;
  if (!CELD_ONLY_KEYS.has(key)) {
    console.error(
      `::error::dist/wrangler.json contains "${key}", which workerd does not accept. ` +
        `Supported keys: ${[...SUPPORTED_KEYS].join(', ')}`,
    );
    process.exit(1);
  }
  if (!isEmptyPlaceholder(config[key])) {
    console.error(
      `::error::dist/wrangler.json contains a non-empty celld-only key "${key}". ` +
        `The smoke test cannot pass it through to workerd, so dropping it would hide it. ` +
        `Value: ${JSON.stringify(config[key])}`,
    );
    process.exit(1);
  }
  dropped.push(key);
  delete config[key];
}

for (const key of ['name', 'main', 'durable_objects', 'd1_databases', 'assets']) {
  if (config[key] === undefined) {
    console.error(`::error::dist/wrangler.json is missing "${key}"`);
    process.exit(1);
  }
}

writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(
  `workerd config prepared: ${Object.keys(config).join(', ')}` +
    (dropped.length ? ` (dropped celld-only keys: ${dropped.join(', ')})` : ''),
);
