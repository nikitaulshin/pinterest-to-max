import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ImportStorage } from '../src/storage.ts';
import { acquireStorageOwnership } from '../src/storage-ownership.ts';

const target = 'https://max.ru/channel_du';
function run(directory: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['--import', './tests/fixtures/max-plan.ts', 'dist/main.js', 'plan', '--dry-run'], {
    env: { ...process.env, DATA_DIR: directory, MAX_CHANNEL_URL: target, PUBLICATION_SLOTS: '09:00,15:00,21:00',
      PLANNING_HORIZON_DAYS: '14', MAX_SCHEDULED_LIMIT: '100', PINTEREST_BOARD_URL: 'invalid', PINTEREST_BROWSER_CHANNEL: 'invalid', ...env },
    encoding: 'utf8', timeout: 60_000,
  });
}
function data(t: TestContext, count = 2, channel = target) {
  const directory = mkdtempSync(join(tmpdir(), 'plan-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const storage = new ImportStorage(directory, 'https://ru.pinterest.com/user/board/');
  try {
    if (channel) storage.bindChannel(channel);
    mkdirSync(join(directory, 'images'));
    for (let id = 1; id <= count; id++) {
      const path = join(directory, 'images', `${id}.png`);
      writeFileSync(path, `Preserved image ${id}`);
      storage.sources([{ id: String(id), url: `https://ru.pinterest.com/pin/${id}/` }]);
      storage.image({ status: 'ready', id: String(id), imageUrl: 'https://i.pinimg.com/image.png', path,
        sha256: String(id).repeat(64), mime: 'image/png', bytes: 10, width: 1, height: 1 });
    }
  } finally { storage.close(); }

  return directory;
}
function businessBytes(directory: string) {
  return Object.fromEntries(['state.sqlite', ...readdirSync(join(directory, 'images')).map((name) => `images/${name}`)]
    .map((name) => [name, readFileSync(join(directory, name)).toString('base64')]));
}
function unchanged(directory: string, before: ReturnType<typeof businessBytes>) {
  assert.deepEqual(businessBytes(directory), before, 'Dry-run must preserve database and image bytes');
  const audit = readFileSync(join(directory, 'browser-audit'), 'utf8');
  assert.equal(audit, 'closed\n', 'Browser must close without upload or send');
}

test('public dry-run skips occupied Moscow minute and preserves every business byte', (t) => {
  const directory = data(t);
  const before = businessBytes(directory);
  const result = run(directory);
  assert.equal(result.status, 0, `Dry-run must succeed independently of Pinterest: ${result.stderr}`);
  const plan = JSON.parse(result.stdout);
  assert.deepEqual(plan.assignments.map((item: { jobId: number }) => item.jobId), [1, 2], 'Assignments must retain FIFO');
  assert.ok(plan.assignments.every((item: { scheduledAt: string }) => !plan.occupiedSlots.includes(item.scheduledAt)), 'Occupied minute must not be assigned');
  assert.equal(Date.parse(plan.assignments[0].scheduledAtMoscow), Date.parse(plan.assignments[0].scheduledAt), 'UTC and Moscow must denote the same instant');
  assert.match(plan.assignments[0].scheduledAtMoscow, /\+03:00$/, 'Moscow time must include offset');
  assert.equal(plan.scheduledCount, 1, 'All observed MAX posts must consume capacity');
  assert.equal(plan.remainingCapacity, 97, 'Existing and proposed posts must consume capacity');
  unchanged(directory, before);
});

test('public dry-run explains an empty queue after reading the current MAX list', (t) => {
  const directory = data(t, 0);
  const before = businessBytes(directory);
  const result = run(directory, { PLAN_SCENARIO: 'empty' });
  assert.equal(result.status, 0, `Empty queue must succeed: ${result.stderr}`);
  const plan = JSON.parse(result.stdout);
  assert.deepEqual(plan.assignments, [], 'Empty queue must not invent assignments');
  assert.match(plan.reasons.join(' '), /Нет готовых/, 'Empty queue must have an explicit reason');
  unchanged(directory, before);
});

test('public dry-run explains exhausted capacity without changing ready jobs', (t) => {
  const directory = data(t);
  const before = businessBytes(directory);
  const result = run(directory, { MAX_SCHEDULED_LIMIT: '1' });
  assert.equal(result.status, 0, `Full scheduler must yield a preview: ${result.stderr}`);
  const plan = JSON.parse(result.stdout);
  assert.deepEqual(plan.assignments, [], 'Full scheduler must not assign jobs');
  assert.equal(plan.remainingReadyCount, 2, 'Unassigned queue must remain visible');
  assert.match(plan.reasons.join(' '), /Лимит отложки исчерпан/, 'Capacity reason must be explicit');
  unchanged(directory, before);
});

for (const env of [{ PUBLICATION_SLOTS: '' }, { PUBLICATION_SLOTS: '25:00' }, { PUBLICATION_SLOTS: '09:00,09:00' },
  { PLANNING_HORIZON_DAYS: '0' }, { MAX_SCHEDULED_LIMIT: undefined }, { MAX_SCHEDULED_LIMIT: '' },
  { MAX_SCHEDULED_LIMIT: '0' }, { MAX_SCHEDULED_LIMIT: '1.5' }, { MAX_CHANNEL_URL: '' }, { DATA_DIR: '' }]) {
  test(`public dry-run validates configuration before any side effect: ${JSON.stringify(env)}`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'plan-invalid-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const result = run(directory, { ...env, PLAN_SCENARIO: 'forbid' });
    assert.equal(result.status, 1, 'Invalid configuration must fail');
    assert.deepEqual(readdirSync(directory), [], 'Invalid configuration must not create files');
    assert.equal(result.stdout, '', 'Invalid configuration must not emit a preview');
  });
}

for (const scenario of ['incomplete', 'wrong-ui', 'expired']) {
  test(`public dry-run refuses ${scenario} without business writes`, (t) => {
    const directory = data(t);
    const before = businessBytes(directory);
    const result = run(directory, { PLAN_SCENARIO: scenario });
    assert.equal(result.status, 1, 'Unconfirmed MAX list must fail');
    assert.equal(result.stdout, '', 'Unconfirmed list must not emit any successful preview');
    assert.doesNotMatch(result.stdout, /auth-required/, 'Dry-run must not prompt for manual login');
    const diagnostic = result.stderr.trim().split('\n').map((line) => JSON.parse(line)).find((event) => event.operation === 'plan-dry-run');
    assert.equal(diagnostic?.code, scenario === 'expired' ? 'auth-required' : 'structure-changed', 'Failure must report the classified browser error');
    assert.equal(typeof diagnostic?.screenshotAvailable, 'boolean', 'Failure must explicitly report screenshot availability');
    unchanged(directory, before);
  });
}

for (const channel of ['', 'https://max.ru/other']) {
  test(`public dry-run refuses unbound or mismatched storage channel: ${channel}`, (t) => {
    const directory = data(t, 1, channel);
    const before = businessBytes(directory);
    const result = run(directory, { PLAN_SCENARIO: 'forbid' });
    assert.equal(result.status, 1, 'Unverified binding must fail before browser startup');
    assert.match(result.stderr, /Канал хранилища/, 'Error must identify the channel binding');
    assert.deepEqual(businessBytes(directory), before, 'Binding refusal must preserve business bytes');
    assert.ok(!readdirSync(directory).includes('profiles'), 'Binding refusal must not open a profile');
  });
}

test('public dry-run does not create a missing business database', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'plan-missing-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = run(directory, { PLAN_SCENARIO: 'forbid' });
  assert.equal(result.status, 1, 'Missing initialized database must fail');
  assert.deepEqual(readdirSync(directory), ['worker-lock.sqlite'], 'Only operational ownership file may be created');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`public dry-run closes the browser and releases ownership after ${signal}`, async (t) => {
    const directory = data(t);
    const before = businessBytes(directory);
    const child = spawn(process.execPath, ['--import', './tests/fixtures/max-plan.ts', 'dist/main.js', 'plan', '--dry-run'], {
      env: { ...process.env, DATA_DIR: directory, MAX_CHANNEL_URL: target, PUBLICATION_SLOTS: '09:00', MAX_SCHEDULED_LIMIT: '100', PLAN_SCENARIO: 'signal' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk;
      if (stderr.includes('fixture-browser-opening')) child.kill(signal);
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
    const [code] = await once(child, 'close');
    clearTimeout(timeout);
    assert.equal(code, 0, `Cancellation must finish cleanly: ${stderr}`);
    assert.equal(stdout, '', 'Cancellation must not emit a partial preview');
    unchanged(directory, before);
    const release = acquireStorageOwnership(directory);
    release();
  });
}
