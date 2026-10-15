import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { test } from 'node:test';

const serverUrl = new URL('../src/server.ts', import.meta.url).href;
const pluginUrl = new URL('../src/index.ts', import.meta.url).href;

test('server and plugin imports create no listener, watcher or run directory', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'hub-import-'));
  try {
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e',
      `await import(${JSON.stringify(serverUrl)}); await import(${JSON.stringify(pluginUrl)});`], {
      cwd, env: { ...process.env, NODE_ENV: 'production' }, timeout: 3000, encoding: 'utf8',
    });
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(cwd, '.swarm-runs')), false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('independent runtimes close idempotently, terminate SSE and release the port', async () => {
  const { startServer } = await import('../src/server.ts');
  const options = { host: '127.0.0.1', frontend: false };
  const first = await startServer(0, options);
  const second = await startServer(0, options);
  const url = (run: typeof first) => `http://127.0.0.1:${run.address.port}`;
  try {
    assert.notEqual(first.address.port, second.address.port);
    assert.equal((await fetch(`${url(first)}/api/health`)).status, 200);
    const stream = await fetch(`${url(first)}/api/tasks/no-such-task/stream`);
    assert.equal(stream.status, 200);
    const streamEnded = stream.text().catch(error => error);
    await Promise.all([first.close(), first.close()]);
    await streamEnded;
    await assert.rejects(fetch(`${url(first)}/api/health`));
    assert.equal((await fetch(`${url(second)}/api/health`)).status, 200);
    const replacement = await startServer(first.address.port, options);
    await replacement.close();
  } finally { await Promise.all([first.close(), second.close()]); }
});

test('listen errors reject startup and leave the port reusable', async () => {
  const { startServer } = await import('../src/server.ts');
  const occupied = createServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  const port = (occupied.address() as import('node:net').AddressInfo).port;
  try {
    await assert.rejects(startServer(port, { host: '127.0.0.1', frontend: false }), { code: 'EADDRINUSE' });
  } finally { await new Promise<void>((resolve) => occupied.close(() => resolve())); }
  const run = await startServer(port, { host: '127.0.0.1', frontend: false });
  await run.close();
});

test('plugin dispose during startup and immediate reload release the runtime', async () => {
  const plugin = await import('../src/index.ts');
  const errors: unknown[] = [];
  const ctx = { logger: { info() {}, warn() {}, error(...args: unknown[]) { errors.push(args); } } };
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as import('node:net').AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const config = { port, host: '127.0.0.1', frontend: false };
  plugin.apply(ctx, config);
  const disposing = plugin.dispose();
  plugin.apply(ctx, config);
  await disposing;
  await plugin.dispose();
  await plugin.dispose();
  assert.deepEqual(errors, []);
});


test('Vite runtime releases frontend resources on close and failed listen', async () => {
  const { startServer } = await import('../src/server.ts');
  const run = await startServer(0, { host: '127.0.0.1' });
  try {
    const response = await fetch(`http://127.0.0.1:${run.address.port}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<html/);
    await assert.rejects(startServer(run.address.port, { host: '127.0.0.1' }), { code: 'EADDRINUSE' });
    assert.equal((await fetch(`http://127.0.0.1:${run.address.port}/api/health`)).status, 200);
  } finally { await run.close(); }
});


test('CLI handles SIGTERM and exits after closing all resources', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'),
    new URL('../src/cli.ts', import.meta.url).pathname], {
    env: { ...process.env, PORT: '0', NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit');
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', chunk => {
        if (chunk.toString().includes('[Agent Hub] http://')) resolve();
      });
      child.once('error', reject);
      child.once('exit', () => reject(new Error(`CLI exited before listening: ${stderr}`)));
    });
    child.kill('SIGTERM');
    assert.deepEqual(await exited, [0, null], stderr);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});
