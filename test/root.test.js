// The bare live address opens the try page instead of "not found".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('the bare address sends the visitor to /try, and /try answers', async (t) => {
  // An empty folder and no keys, so the server reads no saved state and talks to no chat app.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callout-root-'));
  const port = 18000 + Math.floor(Math.random() * 1000);
  const server = spawn(process.execPath, [fileURLToPath(new URL('../server/index.js', import.meta.url))],
    { cwd: dir, env: { PATH: process.env.PATH, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const stopped = new Promise((r) => server.once('exit', r));
  t.after(async () => {
    server.kill();
    await stopped;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await new Promise((ok, fail) => {
    server.stdout.on('data', (d) => { if (/Lafiya server on/.test(String(d))) ok(); });
    server.on('exit', (c) => fail(new Error(`server stopped (${c})`)));
  });
  const root = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/try');
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') || '', /text\/html/);
});
