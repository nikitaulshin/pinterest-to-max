import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

function start(directory: string, args: string[], fixture = 'storage-ownership', env: NodeJS.ProcessEnv = {}, entry = 'dist/main.js') {
  const child = spawn(process.execPath, ['--import', `./tests/fixtures/${fixture}.ts`, entry, ...args], {
    env: { ...process.env, DATA_DIR: directory, SYNC_SCENARIO: 'history', MAX_CHANNEL_URL: 'https://max.ru/channel_du', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
  const result = once(child, 'close').then(([code, signal]) => {
    clearTimeout(timeout);
    return { code, signal, stdout, stderr };
  });

  return { child, result };
}

async function directory(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'storage-ownership-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  return directory;
}

async function owner(t: TestContext, directory: string) {
  const process = start(directory, []);
  t.after(async () => {
    process.child.kill('SIGKILL');
    await process.result;
  });
  await Promise.race([
    once(process.child.stdout, 'data'),
    process.result.then((result) => { throw new Error(`Owner exited before startup: ${result.stderr}`); }),
  ]);

  return process;
}

for (const args of [[], ['auth', 'pinterest'], ['auth', 'max'], ['sync'], ['sync', '--full'], ['bootstrap'], ['backfill', '--count', '1'], ['backfill', '--count', '1', '--resume', 'saved-run'], ['queue', 'skip', '1'], ['queue', 'retry', '1']]) {
  test(`second ${args.join(' ') || 'idle'} refuses busy storage before side effects`, { timeout: 20_000 }, async (t) => {
    const data = await directory(t);
    await owner(t, data);
    await rm(join(data, 'profiles'), { recursive: true });
    const before = await readdir(data);
    const state = await stat(join(data, 'state.sqlite'));
    const lock = await stat(join(data, 'worker-lock.sqlite'));

    const result = await start(data, args).result;
    assert.equal(result.code, 1, `Second owner must fail immediately: ${result.stderr}`);
    assert.match(result.stderr, /Хранилище занято.*Остановите/, 'Busy error must identify the owner and recovery action');
    assert.doesNotMatch(result.stderr, /Browser must not launch/, 'Rejected command must not reach the browser');
    assert.equal(result.stdout, '', 'Rejected command must not report work');
    assert.deepEqual(await readdir(data), before, 'Rejected command must not create profiles, diagnostics or state journals');
    assert.equal((await stat(join(data, 'state.sqlite'))).mtimeMs, state.mtimeMs, 'Rejected command must not migrate or change state');
    assert.equal((await stat(join(data, 'worker-lock.sqlite'))).ino, lock.ino, 'Contender must not replace the lock inode');
  });
}

test('queue snapshot remains readable while another CLI owns storage', { timeout: 30_000 }, async (t) => {
  const data = await directory(t);
  const initialized = await start(data, ['bootstrap'], 'pinterest-sync').result;
  assert.equal(initialized.code, 0, `Public bootstrap must initialize queue: ${initialized.stderr}`);
  const before = await start(data, ['queue', 'list']).result;
  assert.equal(before.code, 0, `Initial snapshot must be readable: ${before.stderr}`);
  await owner(t, data);

  const during = await start(data, ['queue', 'list']).result;
  assert.equal(during.code, 0, `Read-only snapshot must bypass ownership: ${during.stderr}`);
  assert.deepEqual(JSON.parse(during.stdout), JSON.parse(before.stdout), 'Concurrent snapshot must preserve sources and queue');
});

for (const signal of ['SIGKILL', 'SIGTERM', 'SIGINT'] as const) {
  test(`ownership is released after ${signal} without replacing the lock file`, { timeout: 20_000 }, async (t) => {
    const data = await directory(t);
    const first = await owner(t, data);
    const before = await stat(join(data, 'worker-lock.sqlite'));
    if (process.platform !== 'win32') assert.equal(before.mode & 0o777, 0o600, 'Ownership database must be private');
    first.child.kill(signal);
    const stopped = await first.result;
    if (signal === 'SIGKILL') assert.equal(stopped.signal, 'SIGKILL', 'Fixture must kill the real owner');
    else assert.equal(stopped.code, 0, 'Handled shutdown must succeed');

    const next = await owner(t, data);
    const after = await stat(join(data, 'worker-lock.sqlite'));
    if (before.ino !== 0) assert.equal(after.ino, before.ino, 'New owner must reuse the original lock inode');
    next.child.kill('SIGTERM');
    assert.equal((await next.result).code, 0, 'Next owner must acquire immediately without a lease timeout');
  });
}

test('startup failure releases ownership for the next CLI', { timeout: 20_000 }, async (t) => {
  const data = await directory(t);
  const failed = await start(data, ['queue', 'skip', '1']).result;
  assert.equal(failed.code, 1, 'Missing queue must reject mutation');
  assert.match(failed.stderr, /ещё не инициализировано/, 'Failure must happen after ownership acquisition');
  const before = await stat(join(data, 'worker-lock.sqlite'));

  const next = await owner(t, data);
  if (before.ino !== 0) assert.equal((await stat(join(data, 'worker-lock.sqlite'))).ino, before.ino, 'Failed startup must keep the same lock file');
  next.child.kill('SIGTERM');
  assert.equal((await next.result).code, 0, 'Next command must acquire after startup failure');
});


test('auth keeps ownership across browser startup wait', { timeout: 20_000 }, async (t) => {
  const data = await directory(t);
  const first = start(data, ['auth', 'pinterest'], 'storage-ownership', { OWNERSHIP_WAIT: '1' });
  t.after(async () => {
    first.child.kill('SIGKILL');
    await first.result;
  });
  const [started] = await Promise.race([
    once(first.child.stdout, 'data'),
    first.result.then((result) => { throw new Error(`Auth exited before browser startup: ${result.stderr}`); }),
  ]);
  assert.match(String(started), /browser-starting/, 'Owner must reach the asynchronous browser boundary');

  const second = await start(data, ['bootstrap']).result;
  assert.equal(second.code, 1, 'Waiting auth must exclude mutators');
  assert.match(second.stderr, /Хранилище занято/, 'Ownership must survive asynchronous browser startup');
});


test('live check script rejects busy profile before diagnostics or browser startup', { timeout: 20_000 }, async (t) => {
  const data = await directory(t);
  await owner(t, data);
  await rm(join(data, 'profiles'), { recursive: true });
  const before = await readdir(data);

  const result = await start(data, [], 'storage-ownership', {}, 'scripts/check-pinterest-pin.ts').result;
  assert.equal(result.code, 1, 'Live check must reject a profile owned by another CLI');
  assert.match(result.stderr, /Хранилище занято/, 'Live check must use the same storage ownership');
  assert.deepEqual(await readdir(data), before, 'Rejected check must not create diagnostics or profiles');
});
