import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ImportStorage, listQueue } from '../src/storage.ts';
import { acquireStorageOwnership } from '../src/storage-ownership.ts';

const board = 'https://ru.pinterest.com/user/board/';
const channel = 'https://max.ru/channel_du';
function fixture(t: TestContext, count = 1) {
  const directory = mkdtempSync(join(tmpdir(), 'recovery-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const storage = new ImportStorage(directory, board);
  storage.bindChannel(channel);
  storage.finishBootstrap(storage.beginBootstrap(), true, 'complete');
  mkdirSync(join(directory, 'images'));
  for (let id = 1; id <= count; id++) {
    const path = join(directory, 'images', `${id}.png`);
    writeFileSync(path, `preserved image ${id}`);
    storage.sources([{ id: String(id), url: `https://ru.pinterest.com/pin/${id}/` }]);
    storage.image({ status: 'ready', id: String(id), imageUrl: 'https://i.pinimg.com/image.png', path,
      sha256: String(id).repeat(64), mime: 'image/png', bytes: 17, width: 1, height: 1 });
  }
  storage.close();
  return directory;
}
function audit(directory: string) {
  try { return readFileSync(join(directory, 'recovery-audit'), 'utf8'); } catch { return ''; }
}
function worker(t: TestContext, directory: string, scenario: string) {
  const child = spawn(process.execPath, ['--import', './tests/fixtures/recovery.ts', 'dist/main.js', 'run'], {
    env: { ...process.env, DATA_DIR: directory, PINTEREST_BOARD_URL: board, MAX_CHANNEL_URL: channel,
      PUBLICATION_SLOTS: '09:00,15:00,21:00', MAX_SCHEDULED_LIMIT: '10', SYNC_INTERVAL_SECONDS: '0.02', RECOVERY_SCENARIO: scenario },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; child.stdout.on('data', value => { stdout += value; });
  let stderr = ''; child.stderr.on('data', value => { stderr += value; });
  const exit = once(child, 'close');
  t.after(() => { child.kill('SIGKILL'); });
  return {
    started: () => stdout.includes('"event":"started"'),
    async wait(predicate: () => boolean) {
      const deadline = Date.now() + 5000;
      while (!predicate() && Date.now() < deadline && child.exitCode === null && child.signalCode === null) await delay(10);
      assert.ok(predicate(), `Expected recovery progress: ${stderr}`);
    },
    async stop(signal: NodeJS.Signals) {
      child.kill(signal);
      const [code, received] = await exit;
      if (signal === 'SIGKILL') assert.equal(received, signal, 'Real OS death must terminate the worker');
      else assert.equal(code, 0, `Graceful shutdown must succeed: ${stderr}`);
      const release = acquireStorageOwnership(directory); release();
    },
  };
}
function count(directory: string) {
  try { return Number(readFileSync(join(directory, 'external-count'), 'utf8')); } catch { return 0; }
}

test('SIGKILL before intent preserves file and FIFO and replans an expired preparing slot', async t => {
  const directory = fixture(t, 2);
  const first = worker(t, directory, 'before-intent');
  await first.wait(() => audit(directory).includes('pending'));
  await first.stop('SIGKILL');
  const db = new DatabaseSync(join(directory, 'state.sqlite'));
  db.exec("UPDATE queue SET scheduled_at = '2020-01-01T00:00:00.000Z', error = 'preserved cause' WHERE id = 1"); db.close();
  const before = listQueue(directory);
  const restarted = worker(t, directory, 'before-intent');
  await restarted.wait(() => audit(directory).split('pending').length === 3);
  const after = listQueue(directory);
  assert.equal(after.items[0]!.id, before.items[0]!.id, 'Recovery must preserve job identity');
  assert.equal(after.items[0]!.added_at, before.items[0]!.added_at, 'Recovery must preserve FIFO');
  assert.equal(after.items[0]!.error, 'preserved cause', 'Recovery must preserve the previous error');
  assert.ok(Date.parse(String(after.items[0]!.scheduled_at)) > Date.now(), 'Expired preliminary slot must be recalculated');
  assert.equal(after.maxAttempts.length, 0, 'Preparing recovery must not fabricate attempts');
  assert.equal(readFileSync(join(directory, 'images/1.png'), 'utf8'), 'preserved image 1', 'Local file must survive death and restart');
  assert.ok(after.queueEvents.some(event => event.action === 'max-recovery'), 'Recovery must preserve an audit event');
  assert.equal(after.items[1]!.status, 'ready', 'Next FIFO job must not overtake the interrupted job');
  await restarted.stop('SIGTERM');
  assert.equal(listQueue(directory).items[0]!.status, 'ready', 'Graceful abort before intent must return ready');
});

test('SIGKILL after possible creation atomically restores job and attempt to uncertain without a duplicate', async t => {
  const directory = fixture(t);
  const first = worker(t, directory, 'after-create');
  await first.wait(() => audit(directory).includes('pending'));
  await first.stop('SIGKILL');
  assert.equal(listQueue(directory).items[0]!.status, 'submitting', 'Death must leave the durable intent');
  const restarted = worker(t, directory, 'success');
  await restarted.wait(() => audit(directory).includes('reconcile'));
  await restarted.stop('SIGTERM');
  const state = listQueue(directory);
  assert.equal(state.items[0]!.status, 'uncertain', 'Unknown external result must only reconcile');
  assert.equal(state.maxAttempts[0]!.status, 'uncertain', 'Attempt recovery must agree with job recovery');
  assert.equal(count(directory), 1, 'Restart must not increase the durable external post count');
  assert.equal(state.maxAttempts.length, 1, 'Recovery must preserve the original attempt');
});

for (const removed of [false, true]) test(`SIGKILL after confirmed creation preserves scheduled history when scheduler removed=${removed}`, async t => {
  const directory = fixture(t);
  const first = worker(t, directory, 'after-success');
  await first.wait(() => audit(directory).includes('pending'));
  await first.stop('SIGKILL');
  if (removed) writeFileSync(join(directory, 'external-count'), '0');
  const before = listQueue(directory);
  const restarted = worker(t, directory, 'success');
  await restarted.wait(restarted.started);
  await delay(80);
  await restarted.stop('SIGINT');
  assert.deepEqual(listQueue(directory), before, 'Terminal confirmation and evidence must remain unchanged');
  assert.equal(count(directory), removed ? 0 : 1, 'Restart must not recreate a confirmed post');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) test(`${signal} during pending MAX creation keeps uncertainty and never starts the second job`, async t => {
  const directory = fixture(t, 2);
  const first = worker(t, directory, 'after-create');
  await first.wait(() => audit(directory).includes('pending'));
  await first.stop(signal);
  const state = listQueue(directory);
  assert.equal(state.items[0]!.status, 'uncertain', 'Possible creation must be saved before storage closes');
  assert.equal(state.maxAttempts[0]!.status, 'uncertain', 'Attempt outcome must persist before shutdown');
  assert.equal(state.items[1]!.status, 'ready', 'Shutdown must not begin the next job');
  assert.doesNotMatch(audit(directory), /prepare:2/, 'No second submission may start after abort');
  assert.equal(count(directory), 1, 'Shutdown must preserve exactly one external creation');
});

test('preparing with a saved external intent cannot reset its time or become a blind retry', async t => {
  const directory = fixture(t, 2);
  const first = worker(t, directory, 'after-create');
  await first.wait(() => audit(directory).includes('pending'));
  await first.stop('SIGKILL');
  const db = new DatabaseSync(join(directory, 'state.sqlite'));
  db.exec("UPDATE queue SET status = 'preparing' WHERE id = 1; UPDATE queue SET status = 'skipped' WHERE id = 2"); db.close();
  const before = listQueue(directory);
  const restarted = worker(t, directory, 'success');
  await restarted.wait(() => audit(directory).includes('reconcile'));
  await restarted.stop('SIGTERM');
  const after = listQueue(directory);
  assert.equal(after.items[0]!.status, 'uncertain', 'Any durable intent must forbid safe preparation recovery');
  assert.equal(after.items[0]!.scheduled_at, before.items[0]!.scheduled_at, 'Possible external creation must never move to another slot');
  assert.deepEqual(after.items[1], before.items[1], 'Skipped terminal job must remain untouched');
  assert.equal(count(directory), 1, 'Existing external intent must never increase external creations');
});
