import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

const target = 'https://max.ru/channel_du';
function run(directory: string, args: string[], env: NodeJS.ProcessEnv = {}, fixture?: string) {
  return spawnSync(process.execPath, [...(fixture ? ['--import', `./tests/fixtures/${fixture}.ts`] : []), 'dist/main.js', ...args], {
    env: { ...process.env, DATA_DIR: directory, MAX_CHANNEL_URL: target, ...env }, encoding: 'utf8', timeout: 60_000,
  });
}
async function data(t: TestContext, initialized = false) {
  const directory = await mkdtemp(join(tmpdir(), 'max-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (initialized) {
    const result = run(directory, ['bootstrap'], { SYNC_SCENARIO: 'history' }, 'pinterest-sync');
    assert.equal(result.status, 0, `Public bootstrap must initialize history: ${result.stderr}`);
  }

  return directory;
}
function snapshot(directory: string) {
  const result = run(directory, ['queue', 'list']);
  assert.equal(result.status, 0, `Public snapshot must succeed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('public MAX auth binds verified channel in a fresh store', async (t) => {
  const directory = await data(t);
  const result = run(directory, ['auth', 'max'], {}, 'max-auth');
  assert.equal(result.status, 0, `Verified channel must authenticate: ${result.stderr}`);
  assert.match(result.stdout, /"event":"authenticated","service":"max"/, 'Success must report verified authentication');
  const saved = snapshot(directory);
  assert.equal(saved.board.channel_url, target, 'Only verified target must be bound');
  assert.equal(saved.board.initialized, 0, 'MAX auth must not initialize Pinterest history');
  assert.deepEqual(saved.items, [], 'MAX auth must not create jobs');
});

test('public MAX auth preserves existing board and unrelated Pinterest profile', async (t) => {
  const directory = await data(t, true);
  const before = snapshot(directory);
  const profile = join(directory, 'profiles/pinterest');
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'preserved'), 'Pinterest session marker');
  const profileBefore = await readdir(profile);
  const result = run(directory, ['auth', 'max'], { PINTEREST_BOARD_URL: 'invalid', PINTEREST_BROWSER_CHANNEL: 'invalid' }, 'max-auth');
  assert.equal(result.status, 0, `Existing board must ignore unrelated Pinterest configuration: ${result.stderr}`);
  const after = snapshot(directory);
  assert.deepEqual(after, { ...before, board: { ...before.board, channel_url: target } }, 'Only channel binding may change');
  assert.equal(await readFile(join(profile, 'preserved'), 'utf8'), 'Pinterest session marker', 'Pinterest profile must be preserved');
  assert.deepEqual(await readdir(profile), profileBefore, 'MAX must not open or mutate Pinterest profile');
});

test('public MAX auth rejects a different UI channel without binding', async (t) => {
  const directory = await data(t, true);
  const before = snapshot(directory);
  const result = run(directory, ['auth', 'max'], { MAX_SCENARIO: 'mismatch' }, 'max-auth');
  assert.equal(result.status, 1, 'Wrong UI channel must fail');
  assert.match(result.stderr, /открытый канал не совпадает/, 'Wrong UI identity must be explicit');
  assert.deepEqual(snapshot(directory), before, 'Failed UI verification must not bind channel or change imported data');
});

test('public MAX auth refuses changing a stored channel before browser startup', async (t) => {
  const directory = await data(t);
  assert.equal(run(directory, ['auth', 'max'], {}, 'max-auth').status, 0, 'Initial binding must succeed');
  const before = snapshot(directory);
  const result = run(directory, ['auth', 'max'], { MAX_CHANNEL_URL: 'https://max.ru/other', MAX_SCENARIO: 'forbid' }, 'max-auth');
  assert.equal(result.status, 1, 'Switching bound channel must fail');
  assert.match(result.stderr, /Канал хранилища не совпадает/, 'Mismatch must stop before browser');
  assert.deepEqual(snapshot(directory), before, 'Existing binding must remain unchanged');
});

test('expired MAX session requests manual login and cancellation leaves binding unchanged', async (t) => {
  const directory = await data(t, true);
  const before = snapshot(directory);
  const child = spawn(process.execPath, ['--import', './tests/fixtures/max-auth.ts', 'dist/main.js', 'auth', 'max'], {
    env: { ...process.env, DATA_DIR: directory, MAX_CHANNEL_URL: target, MAX_SCENARIO: 'expired' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk;
    if (stdout.includes('auth-required')) child.kill('SIGTERM');
  });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
  const [code] = await once(child, 'close');
  clearTimeout(timeout);
  assert.equal(code, 0, `Cancellation must close cleanly: ${stderr}`);
  assert.match(stdout, /auth-required/, 'Expired session must request manual login');
  assert.doesNotMatch(stdout, /authenticated/, 'Expired session must never report success');
  assert.deepEqual(snapshot(directory), before, 'Expired session must not bind channel or alter imported data');
});
