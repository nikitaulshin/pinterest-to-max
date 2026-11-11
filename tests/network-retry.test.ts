import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ImportStorage, listQueue } from '../src/storage.ts';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'network-retry-'));
  const storage = new ImportStorage(directory, 'https://ru.pinterest.com/user/board/');
  const channel = 'https://max.ru/channel_du';
  storage.bindChannel(channel);
  storage.sources([{ id: '1', url: 'https://ru.pinterest.com/pin/1/' }]);
  storage.image({ status: 'ready', id: '1', imageUrl: 'https://i.pinimg.com/a.png', path: join(directory, 'a.png'), sha256: 'a'.repeat(64), mime: 'image/png', bytes: 1, width: 1, height: 1 });
  t.after(() => { storage.close(); rmSync(directory, { recursive: true, force: true }); });
  return { storage, channel, directory, snapshot: () => listQueue(directory), at: '2030-01-02T12:00:00.000Z' };
}

test('a proven pre-create network failure resumes the same job only when due', t => {
  let now = Date.parse('2030-01-01T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  f.storage.prepareMax(1, f.channel, f.at);
  f.storage.finishMax(1, 'failed', 'network: ECONNRESET');
  const before = f.snapshot().items[0]!;
  f.storage.deferMaxNetworkRetry(1, 20);
  f.storage.resumeMaxNetworkRetries();
  assert.equal(f.snapshot().items[0]!.status, 'failed', 'A network failure must stay deferred before its deadline');
  now += 5000;
  f.storage.resumeMaxNetworkRetries();
  const after = f.snapshot();
  assert.equal(after.items.length, 1, 'Retry must not duplicate the job');
  assert.equal(after.items[0]!.id, before.id, 'Retry must retain the original job identity');
  assert.equal(after.items[0]!.added_at, before.added_at, 'Retry must retain FIFO order');
  assert.equal(after.items[0]!.error, before.error, 'Retry must retain the network failure reason');
  assert.equal(after.items[0]!.status, 'ready', 'A due safe retry must become ready');
  assert.equal(after.maxAttempts.length, 0, 'Pre-create retry must not invent an external attempt');
});

test('pre-create network retries grow and stop after five deferrals', t => {
  let now = Date.parse('2030-01-01T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  for (let index = 0; index < 6; index++) {
    f.storage.prepareMax(1, f.channel, f.at);
    f.storage.finishMax(1, 'failed', 'network: ECONNRESET');
    f.storage.deferMaxNetworkRetry(1, 20);
    const job = f.snapshot().items[0]!;
    assert.equal(job.next_attempt_at, index < 5 ? new Date(now + 5000 * 2 ** index).toISOString() : null, 'Retry history must bound the network series');
    now += 5000 * 2 ** index;
    f.storage.resumeMaxNetworkRetries();
  }
  assert.equal(f.snapshot().items[0]!.status, 'failed', 'Exhausted retry series must require manual recovery');
});

for (const status of ['submitting', 'uncertain', 'scheduled']) test(`${status} never enters the network retry mechanism`, t => {
  const f = fixture(t);
  f.storage.prepareMax(1, f.channel, f.at);
  const attempt = f.storage.beginMaxAttempt(1, f.channel, 'a'.repeat(64), f.at);
  if (status !== 'submitting') f.storage.finishMax(1, status as 'uncertain' | 'scheduled', null, attempt, status === 'scheduled' ? 'positive evidence' : undefined);
  const before = f.snapshot().items[0]!;
  assert.throws(() => f.storage.deferMaxNetworkRetry(1, 20), /до намерения/, 'A possible or confirmed external attempt must refuse retries');
  f.storage.resumeMaxNetworkRetries();
  assert.deepEqual(f.snapshot().items[0], before, 'Protected states and their original scheduled times must remain unchanged');
});

test('failed jobs with an external attempt cannot be resumed even with a stale retry date', t => {
  const f = fixture(t);
  f.storage.prepareMax(1, f.channel, f.at);
  f.storage.beginMaxAttempt(1, f.channel, 'a'.repeat(64), f.at);
  const db = new DatabaseSync(join(f.directory, 'state.sqlite'));
  db.exec("UPDATE queue SET status = 'failed', next_attempt_at = '2000-01-01T00:00:00.000Z'"); db.close();
  f.storage.resumeMaxNetworkRetries();
  assert.equal(f.snapshot().items[0]!.status, 'failed', 'External attempt history must override stale retry metadata');
});

test('a failed file with an arbitrary retry timestamp has no proven network eligibility', t => {
  const f = fixture(t);
  f.storage.prepareMax(1, f.channel, f.at);
  f.storage.finishMax(1, 'failed', 'MAX: локальный файл недоступен.');
  const db = new DatabaseSync(join(f.directory, 'state.sqlite'));
  db.exec("UPDATE queue SET next_attempt_at = '2000-01-01T00:00:00.000Z'"); db.close();
  f.storage.resumeMaxNetworkRetries();
  assert.equal(f.snapshot().items[0]!.status, 'failed', 'A retry timestamp alone must not turn a file failure into a network retry');
});
