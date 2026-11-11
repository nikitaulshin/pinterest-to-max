import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ImportStorage, listQueue } from '../src/storage.ts';
import { acquireStorageOwnership } from '../src/storage-ownership.ts';

const board = 'https://ru.pinterest.com/user/board/';
const channel = 'https://max.ru/channel_du';
function data(t: TestContext, ready = true) {
  const directory = mkdtempSync(join(tmpdir(), 'run-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const storage = new ImportStorage(directory, board);
  storage.bindChannel(channel);
  const bootstrap = storage.beginBootstrap();
  storage.finishBootstrap(bootstrap, true, 'complete');
  if (ready) {
    storage.sources([{ id: '1', url: 'https://ru.pinterest.com/pin/1/' }]);
    storage.image({ status: 'ready', id: '1', imageUrl: 'https://i.pinimg.com/a.png', path: join(directory, 'images/a.png'), sha256: 'a'.repeat(64), mime: 'image/png', bytes: 1, width: 1, height: 1 });
  }
  storage.close();
  return directory;
}
function env(directory: string, extra: NodeJS.ProcessEnv = {}) {
  return { ...process.env, DATA_DIR: directory, PINTEREST_BOARD_URL: board, MAX_CHANNEL_URL: channel,
    PUBLICATION_SLOTS: '09:00', MAX_SCHEDULED_LIMIT: '10', SYNC_INTERVAL_SECONDS: '0.02', ...extra };
}
function audit(directory: string) {
  try { return readFileSync(join(directory, 'run-audit'), 'utf8'); } catch { return ''; }
}
async function running(t: TestContext, directory: string, scenario: string, observed: (events: string) => boolean, signal: 'SIGINT' | 'SIGTERM' = 'SIGTERM', extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ['--import', './tests/fixtures/run.ts', 'dist/main.js', 'run'], { env: env(directory, { RUN_SCENARIO: scenario, ...extra }), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (value) => { stdout += value; });
  child.stderr.on('data', (value) => { stderr += value; });
  const exit = once(child, 'close');
  const deadline = Date.now() + 5000;
  while (!observed(audit(directory)) && Date.now() < deadline && child.exitCode === null) await delay(10);
  assert.ok(observed(audit(directory)), `Expected independent cycle progress: ${stderr}`);
  child.kill(signal);
  const [code] = await exit;
  assert.equal(code, 0, `Worker must stop cleanly: ${stderr}`);
  assert.match(stdout, /"event":"stopped"/, 'Worker must report completed shutdown');
  const release = acquireStorageOwnership(directory); release();
  return { stdout, stderr };
}
for (const scenario of ['pinterest-error', 'pinterest-hang']) test(`ready MAX queue progresses during ${scenario}`, async (t) => {
  const directory = data(t);
  const result = await running(t, directory, scenario, (events) => events.includes('batch'), 'SIGINT');
  if (scenario === 'pinterest-error') assert.match(result.stderr, /"service":"pinterest"/, 'Pinterest failure must be reported separately');
  assert.match(audit(directory), /max-close/, 'MAX context must close');
});
for (const scenario of ['max-error', 'max-hang']) test(`import continues during ${scenario}`, async (t) => {
  const directory = data(t);
  await running(t, directory, scenario, (events) => events.split('import').length >= 4);
  assert.ok(listQueue(directory).items.length >= 4, 'New imported jobs must persist while MAX is unavailable');
});
test('run periodically imports and refills without manual sync commands', async (t) => {
  const directory = data(t, false);
  await running(t, directory, 'success', (events) => events.split('batch').length >= 3);
  assert.ok(listQueue(directory).items.length >= 2, 'Periodic cycles must retain imported jobs');
});
test('empty ready queue leaves MAX unopened and creates no fake jobs', async (t) => {
  const directory = data(t, false);
  await running(t, directory, 'pinterest-empty', (events) => events.split('import').length >= 4);
  assert.doesNotMatch(audit(directory), /max-open|batch/, 'Empty safe queue must not open MAX');
  assert.equal(listQueue(directory).items.length, 0, 'Empty queue must stay empty');
});
test('uncertain jobs trigger MAX reconciliation even without ready jobs', async (t) => {
  const directory = data(t);
  const db = new DatabaseSync(join(directory, 'state.sqlite'));
  db.exec("UPDATE queue SET status = 'uncertain'"); db.close();
  await running(t, directory, 'pinterest-error', (events) => events.includes('batch'));
  assert.equal(listQueue(directory).items[0]!.status, 'uncertain', 'Worker must delegate uncertain state without resetting it for send');
});
for (const invalid of ['0', '-1', '', 'NaN', 'Infinity', '2147483.648', '9999999999999999999999', '0.0001']) test(`run refuses unsafe interval ${invalid} before effects`, (t) => {
  const directory = data(t);
  const before = readFileSync(join(directory, 'state.sqlite'));
  const files = readdirSync(directory);
  const child = spawnSync(process.execPath, ['--import', './tests/fixtures/run.ts', 'dist/main.js', 'run'], { env: env(directory, { SYNC_INTERVAL_SECONDS: invalid }), encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 1, 'Invalid interval must fail');
  assert.match(child.stderr, /SYNC_INTERVAL_SECONDS/, 'Error must name the interval');
  assert.deepEqual(readdirSync(directory), files, 'Invalid configuration must create no files');
  assert.deepEqual(readFileSync(join(directory, 'state.sqlite')), before, 'Invalid configuration must preserve business data');
});
for (const change of ["UPDATE board_state SET initialized = 0", "UPDATE board_state SET channel_url = NULL", "UPDATE board_state SET channel_url = 'https://max.ru/other'", "UPDATE board_state SET board_url = 'https://ru.pinterest.com/other/board/'"]) test(`run validates initial policy and bindings before browser: ${change}`, (t) => {
  const directory = data(t);
  const db = new DatabaseSync(join(directory, 'state.sqlite')); db.exec(change); db.close();
  const before = readFileSync(join(directory, 'state.sqlite'));
  const result = spawnSync(process.execPath, ['--import', './tests/fixtures/run.ts', 'dist/main.js', 'run'], { env: env(directory), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1, 'Uninitialized or mismatched state must fail');
  assert.equal(audit(directory), '', 'Policy failure must not call integrations');
  assert.deepEqual(readFileSync(join(directory, 'state.sqlite')), before, 'Policy validation must not write business data');
});
for (const extra of [{ SYNC_INTERVAL_SECONDS: undefined }, { SYNC_INTERVAL_SECONDS: '2147483.647' }]) test(`run accepts bounded interval or default: ${JSON.stringify(extra)}`, async (t) => {
  const directory = data(t, false);
  const result = await running(t, directory, 'pinterest-hang', (events) => events.includes('import'), 'SIGTERM', extra);
  assert.match(result.stdout, extra.SYNC_INTERVAL_SECONDS ? /"syncIntervalSeconds":2147483.647/ : /"syncIntervalSeconds":300/, 'Startup must report the configured or default interval');
  assert.doesNotMatch(result.stderr, /TimeoutOverflowWarning/, 'Accepted timer must not overflow');
});
test('run owns the whole process while queue list remains available', async (t) => {
  const directory = data(t, false);
  await running(t, directory, 'pinterest-hang', (events) => {
    if (!events.includes('import')) return false;
    assert.throws(() => acquireStorageOwnership(directory), /занят/, 'Second writer must be refused throughout run');
    assert.equal(listQueue(directory).items.length, 0, 'Read-only queue snapshot must remain available');
    return true;
  });
});
for (const extra of [{ MAX_CHANNEL_URL: '' }, { PUBLICATION_SLOTS: '' }, { PUBLICATION_SLOTS: '09:00,09:00' },
  { MAX_SCHEDULED_LIMIT: '0' }, { MAX_SCHEDULED_LIMIT: '99999999999999999999' }, { PLANNING_HORIZON_DAYS: '0' },
  { PINTEREST_BOARD_URL: 'invalid' }, { MAX_BROWSER_CHANNEL: 'invalid' }]) test(`run validates all integration and planning configuration: ${JSON.stringify(extra)}`, (t) => {
  const directory = data(t);
  const files = readdirSync(directory);
  const before = readFileSync(join(directory, 'state.sqlite'));
  const result = spawnSync(process.execPath, ['--import', './tests/fixtures/run.ts', 'dist/main.js', 'run'], { env: env(directory, extra), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1, 'Invalid worker configuration must fail');
  assert.equal(audit(directory), '', 'Invalid configuration must not start integrations');
  assert.deepEqual(readdirSync(directory), files, 'Invalid configuration must create no files');
  assert.deepEqual(readFileSync(join(directory, 'state.sqlite')), before, 'Invalid configuration must preserve business data');
});
test('run explains missing initial policy without creating storage', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'run-empty-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['dist/main.js', 'run'], { env: env(directory), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1, 'Missing initial policy must fail');
  assert.match(result.stderr, /bootstrap.*backfill.*auth max/, 'Error must explain the initialization path');
  assert.deepEqual(readdirSync(directory), [], 'Missing initial policy must create no files');
});
test('run reports all missing required MAX settings together', (t) => {
  const directory = data(t);
  const result = spawnSync(process.execPath, ['dist/main.js', 'run'], { env: env(directory, { MAX_CHANNEL_URL: '', PUBLICATION_SLOTS: '', MAX_SCHEDULED_LIMIT: '' }), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1, 'Missing required settings must fail');
  assert.match(result.stderr, /MAX_CHANNEL_URL.*PUBLICATION_SLOTS.*MAX_SCHEDULED_LIMIT/, 'Error must enumerate missing required settings');
  assert.equal(audit(directory), '', 'Missing settings must not start integrations');
});

for (const code of ['auth-required', 'captcha', 'structure-changed']) test(`Pinterest ${code} pauses only import until restart`, async (t) => {
  const directory = data(t);
  const result = await running(t, directory, `pinterest-pause-${code}`, events => events.split('batch').length >= 4);
  assert.equal(audit(directory).split('import').length - 1, 1, 'Paused Pinterest must not repeat protected actions');
  assert.match(result.stderr, new RegExp(`"code":"${code}"`), 'Pause must preserve the access failure');
  assert.match(result.stderr, /"paused":true/, 'Integration must remain paused until restart');
  assert.match(result.stderr, /auth pinterest/, 'Recovery must describe stop, manual auth and restart');
  await running(t, directory, 'success', events => events.split('import').length >= 3);
  assert.ok(audit(directory).split('import').length >= 3, 'Restart after manual access restoration must resume import');
});
for (const scenario of ['max-auth', 'max-captcha', 'max-error']) test(`${scenario} pauses MAX while import continues`, async (t) => {
  const directory = data(t);
  const result = await running(t, directory, scenario, events => events.split('import').length >= 5);
  assert.equal(audit(directory).split('max-open').length - 1, 1, 'Paused MAX must not reopen its protected session');
  assert.match(result.stderr, /"service":"max"/, 'Pause must identify MAX');
  assert.match(result.stderr, /"paused":true/, 'Unknown UI or lost access must pause MAX');
});
test('safe MAX network failure delays retries without blocking import or exposing CDN query', async (t) => {
  const directory = data(t);
  const result = await running(t, directory, 'max-network', events => events.split('import').length >= 5);
  assert.equal(audit(directory).split('batch').length - 1, 1, 'Network backoff must prevent a rapid retry');
  assert.match(result.stderr, /"retryInMs":5000/, 'Small configured periods must still use a bounded retry delay');
  assert.match(result.stderr, /ERR_CONNECTION_RESET/, 'Network cause must be retained');
  assert.doesNotMatch(result.stdout + result.stderr, /token=secret|cdn.test/, 'Raw network URLs must never enter logs');
});
