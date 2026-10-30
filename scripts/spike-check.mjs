import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import * as Y from 'yjs';

const root = process.cwd();
const port = Number(process.env.ZEEE_SPIKE_PORT ?? 9877);
const origin = `http://127.0.0.1:${port}`;
const esbuild = process.env.CELLD_ESBUILD ?? join(root, 'node_modules/.bin/esbuild');
const dist = join(root, 'dist');

if (!existsSync(join(dist, 'wrangler.json'))) {
  console.error('dist/wrangler.json is missing. Run `pnpm build:celld` first.');
  process.exit(1);
}

const project = mkdtempSync(join(tmpdir(), 'zeee-spike-'));
cpSync(dist, project, { recursive: true });
rmSync(join(project, '.celld'), { recursive: true, force: true });

const devVarsPath = join(project, '.dev.vars');
const originalDevVars = existsSync(devVarsPath) ? readFileSync(devVarsPath, 'utf8') : null;
const withoutDevAuth = (originalDevVars ?? '')
  .split('\n')
  .filter((line) => !line.startsWith('ZEEE_DEV_AUTH=') && !line.startsWith('PUBLIC_ORIGIN='))
  .join('\n')
  .trimEnd();
writeFileSync(
  devVarsPath,
  `${withoutDevAuth}${withoutDevAuth ? '\n' : ''}ZEEE_DEV_AUTH=1\nPUBLIC_ORIGIN=http://127.0.0.1:${port}\n`,
);

let child = null;
let logs = '';

function start(clean) {
  logs = '';
  const args = ['dev', project, '--port', String(port), '--logs'];
  if (clean) args.push('--clean');
  child = spawn('celld', args, {
    cwd: root,
    env: { ...process.env, CELLD_ESBUILD: esbuild },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = (chunk) => {
    logs += chunk.toString();
    if (logs.length > 20000) logs = logs.slice(-20000);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('exit', (code) => {
    if (child && code !== 0 && code !== null) {
      console.error(`celld dev exited with ${code}`);
    }
  });
}

async function stop() {
  if (!child) return;
  const running = child;
  child = null;
  running.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      running.kill('SIGKILL');
      resolve();
    }, 5000);
    running.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(250);
  }
  throw new Error(`celld dev did not become ready:\n${logs}`);
}

let cookie = '';

async function request(path, init = {}) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  headers.set('origin', origin);
  const response = await fetch(`${origin}${path}`, { ...init, headers });
  const setCookie = response.headers.getSetCookie?.()[0];
  if (setCookie) cookie = setCookie.split(';')[0];
  return response;
}

async function login() {
  const response = await fetch(`${origin}/auth/dev?name=alice&next=/`, {
    redirect: 'manual',
    headers: { origin },
  });
  const setCookie = response.headers.getSetCookie?.()[0];
  if (!setCookie) throw new Error(`dev auth did not set a cookie: ${response.status}`);
  cookie = setCookie.split(';')[0];
}

function connect(pageId) {
  const doc = new Y.Doc();
  const socket = new WebSocket(`${origin.replace('http', 'ws')}/api/pages/${pageId}/ws`, {
    headers: { cookie, origin },
  });

  const received = [];
  socket.on('message', (data) => {
    const text = data.toString();
    if (text === 'pong') return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.type === 'sync' || message.type === 'update') {
      Y.applyUpdate(doc, Buffer.from(message.update, 'base64'));
      received.push(message.type);
    }
  });

  socket.on('open', () => {
    socket.send(
      JSON.stringify({
        type: 'sync',
        stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64'),
      }),
    );
  });

  socket.on('error', (error) => {
    received.push(`error:${error.message}`);
  });

  return {
    doc,
    socket,
    received,
    sendUpdate() {
      socket.send(
        JSON.stringify({
          type: 'update',
          update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
        }),
      );
    },
  };
}

async function waitForText(doc, phrases) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const text = doc.getText('markdown').toJSON();
    if (phrases.every((phrase) => text.includes(phrase))) return text;
    await sleep(100);
  }
  return doc.getText('markdown').toJSON();
}

async function readState(pageId) {
  const response = await request(`/api/pages/${pageId}/state`);
  if (!response.ok) throw new Error(`state failed: ${response.status} ${await response.text()}`);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(await response.arrayBuffer()));
  return doc.getText('markdown').toJSON();
}

async function main() {
  start(true);
  await waitForServer();

  await login();

  let response = await request('/api/pages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'celld spike' }),
  });
  if (!response.ok)
    throw new Error(`create page failed: ${response.status} ${await response.text()}`);
  const created = await response.json();
  const pageId = created.page.id;

  response = await request(`/api/pages/${pageId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '共同編集のページ' }),
  });
  if (!response.ok) throw new Error(`rename failed: ${response.status} ${await response.text()}`);
  const renamed = await (await request(`/api/pages/${pageId}`)).json();
  if (renamed.page.title !== '共同編集のページ') {
    throw new Error(`title was not saved: ${JSON.stringify(renamed.page.title)}`);
  }

  const alice = connect(pageId);
  const bob = connect(pageId);
  await Promise.all([
    new Promise((resolve, reject) => {
      alice.socket.once('open', resolve);
      alice.socket.once('error', reject);
    }),
    new Promise((resolve, reject) => {
      bob.socket.once('open', resolve);
      bob.socket.once('error', reject);
    }),
  ]);

  alice.doc.getText('markdown').insert(0, 'こんにちは、Zeee。\n');
  alice.sendUpdate();
  bob.doc.getText('markdown').insert(0, '共同編集のスパイク。\n');
  bob.sendUpdate();

  const phrases = ['こんにちは、Zeee。', '共同編集のスパイク。'];
  const aliceText = await waitForText(alice.doc, phrases);
  const bobText = await waitForText(bob.doc, phrases);
  if (!phrases.every((phrase) => aliceText.includes(phrase) && bobText.includes(phrase))) {
    throw new Error(
      `clients did not converge:\nA=${JSON.stringify(aliceText)}\nB=${JSON.stringify(bobText)}`,
    );
  }

  await sleep(2500);

  const page = await (await request(`/api/pages/${pageId}`)).json();
  if (!phrases.every((phrase) => page.page.markdown.includes(phrase))) {
    throw new Error(`D1 body not materialized: ${JSON.stringify(page.page.markdown)}`);
  }

  const search = await (await request('/api/search?q=' + encodeURIComponent('共同編集'))).json();
  if (!search.results.some((result) => result.id === pageId)) {
    throw new Error(`search did not find the page: ${JSON.stringify(search)}`);
  }

  const snapshot = await request(`/api/pages/${pageId}/snapshot`, { method: 'POST' });
  if (!snapshot.ok) throw new Error(`snapshot failed: ${snapshot.status} ${await snapshot.text()}`);
  const manualRevision = await snapshot.json();
  const manualText = manualRevision.markdown;
  const revisions = await (await request(`/api/pages/${pageId}/revisions`)).json();
  if (!revisions.revisions.length) throw new Error('revisions are empty');

  alice.doc.getText('markdown').insert(alice.doc.getText('markdown').length, '\n追記します。\n');
  alice.sendUpdate();
  await waitForText(alice.doc, ['追記します。']);
  await sleep(1500);

  const restore = await request(`/api/pages/${pageId}/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: manualRevision.version }),
  });
  if (!restore.ok) throw new Error(`restore failed: ${restore.status} ${await restore.text()}`);
  await sleep(1500);
  const restored = await readState(pageId);
  if (restored !== manualText || restored.includes('追記します。')) {
    throw new Error(`restore did not return to the manual revision: ${JSON.stringify(restored)}`);
  }

  alice.socket.close();
  bob.socket.close();
  await sleep(300);

  const beforeRestart = await readState(pageId);
  if (
    !phrases.every((phrase) => beforeRestart.includes(phrase)) ||
    beforeRestart.includes('追記します。')
  ) {
    throw new Error(`state before restart is unexpected: ${JSON.stringify(beforeRestart)}`);
  }

  await stop();
  start(false);
  await waitForServer();

  await login();
  const afterRestart = await readState(pageId);
  if (
    !phrases.every((phrase) => afterRestart.includes(phrase)) ||
    afterRestart.includes('追記します。')
  ) {
    throw new Error(`state did not survive restart: ${JSON.stringify(afterRestart)}`);
  }

  console.log('spike ok');
  console.log(`  page: ${pageId}`);
  console.log(`  text: ${JSON.stringify(afterRestart)}`);
  console.log(`  search hits: ${search.results.length}`);
  console.log(`  revisions: ${revisions.revisions.length}`);
  console.log(`  ws messages: alice=${alice.received.length} bob=${bob.received.length}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  if (logs) console.error('\n--- celld dev log ---\n' + logs);
  process.exitCode = 1;
} finally {
  await stop();
  if (originalDevVars === null) {
    rmSync(devVarsPath, { force: true });
  } else {
    writeFileSync(devVarsPath, originalDevVars);
  }
  rmSync(project, { recursive: true, force: true });
}
