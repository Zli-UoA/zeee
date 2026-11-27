#!/usr/bin/env bash
# Boot the built dist/wrangler.json with a real workerd and probe the health endpoint.
# Run `pnpm build:celld` first.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
port="${ZEEE_WORKERD_PORT:-17911}"
origin="http://127.0.0.1:${port}"

# The workerd version is pinned (with integrity hashes) in
# tools/workerd/package-lock.json, so there is no registry lookup at runtime
# beyond the reproducible `npm ci` below. CI installs this before running us;
# install on demand here too so local runs behave the same way.
tool_dir="$root/tools/workerd"
workerd_bin="$tool_dir/node_modules/.bin/workerd"
if [[ ! -x "$workerd_bin" ]]; then
  echo "workerd is not installed; running npm ci --prefix tools/workerd ..." >&2
  npm ci --prefix "$tool_dir" --no-audit --no-fund
fi
workerd_version="$(node -p "require('$tool_dir/node_modules/workerd/package.json').version")"

if [[ ! -f "$root/dist/wrangler.json" ]]; then
  echo "::error::dist/wrangler.json is missing; run pnpm build:celld first." >&2
  exit 1
fi

workspace="$(mktemp -d)"
worker_dir="$workspace/worker"
data_dir="$workspace/data"
log="$workspace/workerd.log"
pid=''

cleanup() {
  if [[ -n "$pid" ]]; then
    # workerd was started in its own session (setsid) so that its helper
    # processes and the actual workerd binary are all terminated together.
    kill -TERM -- "-$pid" 2>/dev/null || true
    sleep 0.5
    kill -KILL -- "-$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$workspace"
}
trap cleanup EXIT

cp -R "$root/dist" "$worker_dir"
mkdir -p "$data_dir"
node "$root/scripts/prepare-workerd-config.mjs" "$worker_dir/wrangler.json"

echo "Starting workerd ${workerd_version} (pinned via tools/workerd/package-lock.json) on ${origin} ..."
setsid env WORKERD_ESBUILD="$root/node_modules/.bin/esbuild" \
  "$workerd_bin" serve --experimental \
    --data-dir "$data_dir" \
    --socket-addr "http=127.0.0.1:${port}" \
    "$worker_dir/wrangler.json" > "$log" 2>&1 &
pid=$!

# Retries cover the startup window; --retry-connrefused covers "not listening yet".
probe() {
  curl --silent --show-error --fail \
    --retry 30 --retry-delay 1 --retry-connrefused \
    --max-time 5 "$@"
}

fail() {
  echo "::error::$1" >&2
  echo "--- workerd log ---" >&2
  cat "$log" >&2
  exit 1
}

if ! probe "$origin/api/health" > "$workspace/health.json"; then
  fail "workerd did not become healthy at ${origin}/api/health"
fi
grep -q '"ok":true' "$workspace/health.json" ||
  fail "unexpected /api/health response: $(cat "$workspace/health.json")"
echo "shallow health: OK ($(cat "$workspace/health.json"))"

# ?deep=1 activates the D1 binding and creates the schema.
if ! probe "$origin/api/health?deep=1" > "$workspace/deep.json"; then
  fail "deep health check failed at ${origin}/api/health?deep=1"
fi
grep -q '"ok":true' "$workspace/deep.json" ||
  fail "unexpected deep health response: $(cat "$workspace/deep.json")"
echo "deep health (D1): OK"

# Confirm the assets/worker routing is understood by workerd.
status="$(curl --silent --show-error --output "$workspace/index.html" \
  --write-out '%{http_code}' --max-time 10 "$origin/")"
[[ "$status" == "200" ]] || fail "GET / returned ${status}, expected 200"
echo "assets routing: OK (GET / -> 200)"

echo "workerd smoke test passed"
