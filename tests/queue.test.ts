import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { nextReadyJob } from '../src/core/queue.ts';

async function run(directory: string, args: string[], scenario?: string, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [...(scenario ? ['--import', './tests/fixtures/pinterest-sync.ts'] : []), 'dist/main.js', ...args], {
    env: { ...process.env, DATA_DIR: directory, ...(scenario ? { SYNC_SCENARIO: scenario } : {}), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let stopSent = false;
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk;
    if (scenario === 'bootstrap-crash' && !stopSent && stdout.includes('pinterest-bootstrap-progress')) {
      stopSent = true;
      child.kill('SIGKILL');
    }
    if (args.length === 0 && !stopSent && stdout.includes('"event":"started"')) {
      stopSent = true;
      child.kill('SIGTERM');
    }
  });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000);
  const [code, signal] = await once(child, 'close');
  clearTimeout(timeout);

  return { code, signal, stdout, stderr };
}

async function initialize(directory: string) {
  const result = await run(directory, ['bootstrap'], 'history');
  assert.equal(result.code, 0, `Explicit history setup must succeed: ${result.stderr}`);
}

async function list(directory: string) {
  const result = await run(directory, ['queue', 'list'], undefined, { PINTEREST_BOARD_URL: 'invalid', PINTEREST_BROWSER_CHANNEL: 'invalid' });
  assert.equal(result.code, 0, `Queue inspection must not need browser configuration: ${result.stderr}`);

  return JSON.parse(result.stdout);
}

test('queue inspection does not initialize missing storage', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'queue-readonly-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await run(directory, ['queue', 'list']);
  assert.equal(result.code, 1, 'Missing queue must fail without initialization');
  assert.deepEqual(await readdir(directory), [], 'Read-only command must not create database or profiles');

});

test('queue inspection does not migrate an existing unversioned database', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'queue-unversioned-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'state.sqlite'), '');
  const empty = await run(directory, ['queue', 'list']);
  assert.equal(empty.code, 1, 'Unversioned database must not be migrated by inspection');
  assert.equal((await readFile(join(directory, 'state.sqlite'))).length, 0, 'Empty existing database must remain unchanged');
});

test('sync preserves queue, sources and material errors across repeated CLI processes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'queue-persistent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'state.sqlite'), '');
  await writeFile(join(directory, 'existing-file'), 'preserve');
  await mkdir(join(directory, 'profiles/max'), { recursive: true });
  await writeFile(join(directory, 'profiles/max', 'existing-profile'), 'preserve');

  await initialize(directory);
  const first = await run(directory, ['sync'], 'unsupported');
  assert.equal(first.code, 1, `Material failure must remain visible: ${first.stderr}`);
  const before = await list(directory);
  assert.equal(before.items.length, 1, 'Identical image bytes must create only one job');
  assert.equal(before.sources.length, 6, 'Every observed pin must be persistent');
  const failed = before.sources.find((source: { id: string }) => source.id === '101');
  assert.equal(failed.status, 'failed', 'Unsupported source must retain its failed state');
  assert.match(failed.error, /Pinterest/, 'Unsupported source must expose its diagnostic reason');
  assert.equal(before.items[0].status, 'ready', 'Validated file must create a ready job');
  assert.match(before.items[0].image_sha256, /^[a-f0-9]{64}$/, 'Queue must retain byte hash');
  assert.equal(before.items[0].source_url, 'https://ru.pinterest.com/pin/100/', 'Queue must retain source URL');
  const bytes = await readFile(join(directory, before.items[0].path));
  assert.ok(bytes.length > 0, 'Ready job must reference a complete local file');
  const restarted = await run(directory, []);
  assert.equal(restarted.code, 0, `Idle restart must stop cleanly: ${restarted.stderr}`);
  assert.deepEqual(await list(directory), before, 'Process restart must preserve queue and errors');

  const repeated = await run(directory, ['sync', '--full'], 'unsupported');
  assert.equal(repeated.code, 1, `Repeated material failure must remain explicit: ${repeated.stderr}`);
  const after = await list(directory);
  assert.deepEqual(after.items, before.items, 'Repeat must preserve job identity, time, state and known outcome');
  assert.deepEqual(after.sources.map((source: Record<string, unknown>) => ({ ...source, last_seen_at: null })),
    before.sources.map((source: Record<string, unknown>) => ({ ...source, last_seen_at: null })), 'Repeat must retain sources, file links and errors');
  assert.deepEqual(await readFile(join(directory, after.items[0].path)), bytes, 'Repeat must preserve complete file bytes');
  assert.equal(await readFile(join(directory, 'existing-file'), 'utf8'), 'preserve', 'Migration must not delete existing files');

  assert.equal(await readFile(join(directory, 'profiles/max', 'existing-profile'), 'utf8'), 'preserve', 'Migration must preserve existing browser profiles');
});

test('changing board is rejected without modifying existing queue', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'queue-board-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await initialize(directory);
  const imported = await run(directory, ['sync'], 'complete');
  assert.equal(imported.code, 0, `Initial board import must succeed: ${imported.stderr}`);
  const after = await list(directory);

  const switched = await run(directory, ['sync'], 'complete', { PINTEREST_BOARD_URL: 'https://ru.pinterest.com/other/board/' });
  assert.equal(switched.code, 1, 'Changing source board must be rejected');
  assert.match(switched.stderr, /Доска хранилища/, 'Board mismatch must be explicit');
  assert.deepEqual(await list(directory), after, 'Rejected board change must preserve all data');
});

test('crash after atomic file save cannot create a job and next sync safely recovers', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'queue-crash-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await initialize(directory);
  const crashed = await run(directory, ['sync'], 'crash-after-file');
  assert.equal(crashed.signal, 'SIGKILL', `Fixture must interrupt after rename: ${crashed.stderr}`);
  const before = await list(directory);
  assert.equal(before.items.length, 0, 'A file without committed transaction must not become a job');
  assert.equal(before.sources.length, 6, 'Sources must survive interruption before the first job');
  const files = (await readdir(join(directory, 'images'))).filter((name) => !name.endsWith('.part'));
  assert.equal(files.length, 1, 'Crash must leave one complete reusable file');
  const bytes = await readFile(join(directory, 'images', files[0]!));

  const recovered = await run(directory, ['sync'], 'complete');
  assert.equal(recovered.code, 0, `Recovery must succeed: ${recovered.stderr}`);
  const after = await list(directory);
  assert.equal(after.items.length, 1, 'Recovery must create only one job for identical bytes');
  assert.deepEqual(await readFile(join(directory, after.items[0].path)), bytes, 'Recovered job must retain the complete saved bytes');
  assert.equal(after.sources.filter((source: { status: string }) => source.status === 'ready').length, 3, 'Recovery must finish all observed sources');
});

for (const full of [false, true]) {
  test(`repeated public sync${full ? ' --full' : ''} reuses known pins without downloading`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'queue-repeat-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await initialize(directory);
  const imported = await run(directory, ['sync'], 'complete');
    assert.equal(imported.code, 0, `Initial import must succeed: ${imported.stderr}`);
    const before = await list(directory);
    const file = join(directory, before.items[0].path);
    const bytes = await readFile(file);

    const repeated = await run(directory, ['sync', ...(full ? ['--full'] : [])], 'known-no-download');
    assert.equal(repeated.code, 0, `Known pins must not download: ${repeated.stderr}`);
    const summary = repeated.stdout.trim().split('\n').map((line) => JSON.parse(line)).find((event) => event.event === 'pinterest-sync-finished');
    assert.equal(summary.ready, 0, 'Reused pins must not be reported as newly prepared files');
    assert.equal(summary.known, 3, 'Every imported pin must be identified as known');
    assert.equal(summary.unprocessed, 0, 'Known pins must count as processed');
    const journal = join(summary.diagnostics, 'results.jsonl');
    assert.equal((await stat(summary.diagnostics)).mode & 0o777, 0o700, 'Known import diagnostics must remain private');
    assert.equal((await stat(journal)).mode & 0o777, 0o600, 'Known import journal must remain private');
    const results = (await readFile(journal, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(results.map((result) => result.status), ['known', 'known', 'known'], 'Journal must distinguish known pins from ready files');
    const after = await list(directory);
    assert.deepEqual(after.items, before.items, 'Repeat must preserve identity, order, status and outcome');
    assert.equal(after.sources.length, 6, 'Repeat must retain all sources');
    assert.deepEqual(await readFile(file), bytes, 'Repeat must preserve saved bytes');
  });
}

test('different pin IDs with identical bytes link all sources to one existing job', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'queue-hash-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await initialize(directory);
  assert.equal((await run(directory, ['sync'], 'complete')).code, 0, 'Initial import must succeed');
  const before = await list(directory);

  assert.equal((await run(directory, ['sync'], 'new-pins')).code, 0, 'Different sources must import successfully');
  const after = await list(directory);
  assert.deepEqual(after.items, before.items, 'Duplicate bytes must retain the existing job and order');
  assert.deepEqual(after.sources.map((source: { id: string }) => source.id), ['900', '901', '902', '100', '101', '102', '200', '201', '202'], 'All old and new sources must remain available');
  assert.ok(after.sources.filter((source: { classification: string }) => source.classification === 'candidate').every((source: { image_sha256: string }) => source.image_sha256 === before.items[0].image_sha256), 'Every duplicate source must link to the same image');
  assert.equal((await readdir(join(directory, 'images'))).length, 1, 'Duplicate bytes must retain only one local image');
});

for (const status of ['scheduled', 'skipped']) {
  test(`repeated import preserves ${status} history for known and duplicate new pins`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'queue-terminal-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await initialize(directory);
    assert.equal((await run(directory, ['sync'], 'complete')).code, 0, 'Initial import must succeed');
    const prepared = await run(directory, ['--help'], 'complete', { QUEUE_FIXTURE_STATUS: status });
    assert.equal(prepared.code, 0, 'Persisted outcome fixture must be prepared');
    const before = await list(directory);
    assert.equal(before.items[0].status, status, 'Fixture must expose the intended terminal state');

    assert.equal((await run(directory, ['sync'], 'known-no-download')).code, 0, 'Known terminal pins must not download');
    assert.deepEqual((await list(directory)).items, before.items, 'Known pin must preserve terminal state and outcome');
    assert.equal((await run(directory, ['sync', '--full'], 'new-pins')).code, 0, 'Duplicate new pin must remain importable');
    const after = await list(directory);
    assert.deepEqual(after.items, before.items, 'Terminal hash must never acquire another job or lose outcome');
    assert.equal(after.sources.length, 9, 'Terminal duplicate sources must still be persisted');
    assert.ok(after.sources.filter((source: { classification: string }) => source.classification === 'candidate').every((source: { image_sha256: string }) => source.image_sha256 === before.items[0].image_sha256), 'Terminal duplicate sources must link to the retained image');
  });
}

test('changed bytes of a known pin do not replace its imported image or job', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'queue-changed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await initialize(directory);
  assert.equal((await run(directory, ['sync'], 'complete')).code, 0, 'Initial import must succeed');
  assert.equal((await run(directory, ['--help'], 'complete', { QUEUE_FIXTURE_STATUS: 'scheduled' })).code, 0, 'Persisted outcome fixture must be prepared');
  const before = await list(directory);
  const bytes = await readFile(join(directory, before.items[0].path));

  assert.equal((await run(directory, ['sync', '--full'], 'changed-image')).code, 0, 'Known pin must remain imported after upstream image change');
  const after = await list(directory);
  assert.deepEqual(after.items, before.items, 'Changed upstream bytes must preserve completed job and image link');
  assert.deepEqual(await readFile(join(directory, after.items[0].path)), bytes, 'Original image bytes must remain intact');
  assert.equal((await readdir(join(directory, 'images'))).length, 1, 'Known pin must not download an orphan replacement image');
});

test('failed source without an imported image resumes and joins the existing image', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'queue-resume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await initialize(directory);
  assert.equal((await run(directory, ['sync'], 'unsupported')).code, 1, 'Unsupported source must fail its first import');
  const before = await list(directory);
  const failed = before.sources.find((source: { id: string }) => source.id === '101');
  assert.equal(failed.image_sha256, null, 'Failed source must not claim a ready image');

  assert.equal((await run(directory, ['sync'], 'complete')).code, 0, 'Failed source must resume after its material becomes supported');
  const after = await list(directory);
  assert.deepEqual(after.items, before.items, 'Recovered duplicate must preserve the existing job');
  const recovered = after.sources.find((source: { id: string }) => source.id === '101');
  assert.equal(recovered.status, 'ready', 'Recovered source must become ready');
  assert.equal(recovered.error, null, 'Recovered import must clear its own material error');
  assert.equal(recovered.image_sha256, before.items[0].image_sha256, 'Recovered source must link to the existing byte hash');
});

for (const args of [['sync'], ['sync', '--full']]) {
  test(`uninitialized ${args.join(' ')} requires an explicit history policy before browser work`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'bootstrap-policy-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const result = await run(directory, args);
    assert.equal(result.code, 1, 'Uninitialized sync must fail');
    assert.match(result.stderr, /bootstrap/, 'Error must explain the explicit history policy');
    assert.equal(result.stdout, '', 'Rejected sync must not start browser work');
    assert.deepEqual((await list(directory)).items, [], 'Rejected sync must not enqueue history');
    assert.ok(!(await readdir(directory)).includes('profiles'), 'Rejected sync must not create a browser profile');
  });
}

test('bootstrap registers history without files or jobs and only subsequent new pins import', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bootstrap-history-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bootstrapped = await run(directory, ['bootstrap'], 'complete');
  assert.equal(bootstrapped.code, 0, `Bootstrap must succeed without downloads: ${bootstrapped.stderr}`);
  const before = await list(directory);
  assert.equal(before.board.initialized, 1, 'Full bootstrap must initialize the board');
  assert.ok(before.board.last_full_sync_at, 'Full bootstrap must save its completion time');
  assert.equal(before.bootstrapRuns[0].status, 'complete', 'Bootstrap completion must be persistent');
  assert.equal(before.bootstrapRuns[0].observed, 3, 'Bootstrap must retain its observed progress');
  assert.deepEqual(before.items, [], 'Historical sources must not become jobs');
  assert.deepEqual(before.sources.map((source: { classification: string }) => source.classification), ['baseline', 'baseline', 'baseline'], 'History must be classified separately from material state');
  assert.ok(before.sources.every((source: { image_sha256: unknown }) => source.image_sha256 === null), 'Bootstrap must not claim prepared images');
  assert.ok(!(await readdir(directory)).includes('images'), 'Bootstrap must not download files');
  assert.equal((await run(directory, ['sync'], 'known-no-download')).code, 0, 'Ordinary sync must exclude historical pins');
  assert.deepEqual((await list(directory)).items, [], 'Repeated history must remain outside the queue');
  assert.equal((await run(directory, ['sync'], 'new-pins')).code, 0, 'Subsequent new pins must import');
  const after = await list(directory);
  assert.equal(after.items.length, 1, 'New sources with identical bytes must create one job');
  assert.equal(after.items[0].pin_id, '200', 'Only subsequently discovered pins may become jobs');
  assert.equal(after.sources.filter((source: { classification: string }) => source.classification === 'baseline').length, 3, 'Ordinary sync must preserve baseline classification');
});

test('partial bootstrap persists sources but cannot authorize ordinary sync', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bootstrap-partial-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const partial = await run(directory, ['bootstrap'], 'partial');
  assert.equal(partial.code, 1, 'Partial bootstrap must return nonzero');
  const before = await list(directory);
  assert.equal(before.board.initialized, 0, 'Partial traversal must not initialize history');
  assert.equal(before.board.last_full_sync_at, null, 'Partial traversal must not claim full completion');
  assert.equal(before.sources.length, 3, 'Observed sources must survive partial traversal');
  assert.equal(before.bootstrapRuns[0].status, 'incomplete', 'Incomplete outcome must survive restart');
  assert.equal(before.bootstrapRuns[0].reason, 'count-changed', 'Incomplete reason must be persistent');
  assert.equal((await run(directory, ['sync'])).code, 1, 'Partial bootstrap must not authorize import');
  assert.equal((await run(directory, ['bootstrap'], 'complete')).code, 0, 'A later full traversal must complete initialization');
  const after = await list(directory);
  assert.equal(after.board.initialized, 1, 'Only completed traversal must initialize history');
  assert.equal(after.bootstrapRuns.length, 2, 'Retry must preserve the earlier incomplete outcome');
  assert.deepEqual(after.items, [], 'Bootstrap retry must never enqueue history');
});

test('hard interruption retains bootstrap progress without confirming initialization', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bootstrap-crash-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const interrupted = await run(directory, ['bootstrap'], 'bootstrap-crash');
  assert.equal(interrupted.signal, 'SIGKILL', 'Fixture must interrupt the bootstrap process');
  const state = await list(directory);
  assert.equal(state.board.initialized, 0, 'Interrupted bootstrap must not initialize history');
  assert.equal(state.sources.length, 3, 'Progress sources must survive process death');
  assert.equal(state.bootstrapRuns[0].observed, 3, 'Committed progress must survive process death');
  assert.equal(state.bootstrapRuns[0].status, 'running', 'Process death must not claim successful completion');
  assert.deepEqual(state.items, [], 'Interrupted bootstrap must not create jobs');
  assert.equal((await run(directory, ['sync'])).code, 1, 'Interrupted bootstrap must not authorize ordinary sync');
});

for (const status of ['ready', 'scheduled', 'skipped', 'failed']) {
  test(`repeated bootstrap preserves ${status} jobs and source errors`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'bootstrap-preserve-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await initialize(directory);
    assert.equal((await run(directory, ['sync'], 'unsupported')).code, 1, 'Import must retain a material error');
    assert.equal((await run(directory, ['--help'], 'complete', { QUEUE_FIXTURE_STATUS: status })).code, 0, 'Outcome fixture must be prepared');
    const before = await list(directory);
    assert.equal((await run(directory, ['bootstrap'], 'unsupported')).code, 0, 'Material errors must not prevent source-only bootstrap');
    const repeated = await list(directory);
    assert.deepEqual(repeated.items, before.items, 'Bootstrap must preserve job identity, order, status and outcomes');
    assert.deepEqual(repeated.sources.map((source: Record<string, unknown>) => ({ ...source, last_seen_at: null })),
      before.sources.map((source: Record<string, unknown>) => ({ ...source, last_seen_at: null })), 'Bootstrap must preserve files, classification and material errors');
    assert.equal((await run(directory, ['bootstrap'], 'new-pins')).code, 0, 'New history must be registered without downloading');
    const after = await list(directory);
    assert.deepEqual(after.items, before.items, 'Registering new history must preserve existing jobs');
    assert.equal(after.sources.filter((source: { classification: string }) => source.classification === 'baseline').length, 6, 'New bootstrap sources must be baseline');
  });
}

test('bootstrap migrates legacy preinitialization queue without losing errors or outcomes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bootstrap-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await initialize(directory);
  assert.equal((await run(directory, ['sync'], 'unsupported')).code, 1, 'Fixture must contain an import error');
  const fixture = await run(directory, ['--help'], 'complete', { QUEUE_FIXTURE_STATUS: 'scheduled', QUEUE_FIXTURE_VERSION: '1' });
  assert.equal(fixture.code, 0, 'Legacy fixture must be prepared');
  const before = await list(directory);
  const file = await readFile(join(directory, before.items[0].path));
  const rejected = await run(directory, ['sync']);
  assert.equal(rejected.code, 1, 'Legacy queue must not silently authorize historical import');
  assert.match(rejected.stderr, /bootstrap/, 'Legacy storage must require an explicit history policy');
  assert.equal((await run(directory, ['bootstrap'], 'new-pins')).code, 0, 'Bootstrap must initialize the migrated board');
  const after = await list(directory);
  assert.deepEqual(after.items, before.items, 'Migration and bootstrap must preserve the legacy queue and outcomes');
  assert.deepEqual(after.sources.filter((source: { id: string }) => before.sources.some((previous: { id: string }) => previous.id === source.id))
    .map((source: Record<string, unknown>) => { const copy = { ...source }; delete copy.classification; return copy; }), before.sources, 'Migration must preserve legacy source material states and errors');
  assert.deepEqual(await readFile(join(directory, after.items[0].path)), file, 'Migration must preserve legacy file bytes');
  assert.equal(after.board.initialized, 1, 'Only the completed bootstrap must authorize import');
  assert.equal(after.sources.filter((source: { classification: string }) => source.classification === 'baseline').length, 3, 'Only newly registered history must become baseline');
});


function backfillSummary(result: { stdout: string }) {
  const events = result.stdout.trim().split('\n').map((line: string) => JSON.parse(line));

  return events.findLast((event: { event: string }) => event.event === 'pinterest-sync-finished');
}

test('initial backfill selects exactly N in board order and baselines the remaining history', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'backfill-exact-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await run(directory, ['backfill', '--count', '2'], 'backfill-unique');
  assert.equal(result.code, 0, `Exact backfill must succeed: ${result.stderr}`);
  const summary = backfillSummary(result);
  assert.equal(summary.acceptedCount, 2, 'Summary must report committed jobs');
  assert.equal(summary.shortfall, 0, 'Exact selection must have no shortfall');
  const state = await list(directory);
  assert.deepEqual(state.items.map((item: { pin_id: string }) => item.pin_id), ['100', '101'], 'Jobs must preserve board selection order');
  assert.equal(state.board.initialized, 1, 'Full initial traversal must initialize history');
  assert.equal(state.sources.length, 3, 'Limit must not truncate historical traversal');
  assert.equal(state.sources[2].classification, 'baseline', 'Remaining history must remain baseline');
  assert.equal(state.sources[2].image_sha256, null, 'Remaining history must not download');
  assert.equal((await run(directory, ['sync'], 'known-no-download')).code, 0, 'Ordinary sync must not import remaining baseline');
  assert.equal((await list(directory)).items.length, 2, 'Ordinary sync must retain the explicit historical limit');
});

test('backfill reports insufficient eligible history without inflating accepted count', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'backfill-shortfall-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await run(directory, ['backfill', '--count', '4'], 'backfill-unique');
  assert.equal(result.code, 1, 'Shortfall must be explicit in the exit status');
  const summary = backfillSummary(result);
  assert.equal(summary.acceptedCount, 3, 'Summary must report actual unique jobs');
  assert.equal(summary.shortfall, 1, 'Shortfall must use the original requested count');
  assert.equal(summary.reason, 'insufficient-eligible-images', 'Summary must explain shortfall');
  const state = await list(directory);
  assert.equal(state.board.initialized, 1, 'Full traversal must initialize history even with insufficient materials');
  assert.equal(state.backfillRuns[0].accepted_count, 3, 'Accepted count must survive command completion');
});

test('duplicate bytes and unsupported materials do not consume the backfill limit', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'backfill-mixed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await run(directory, ['backfill', '--count', '3'], 'backfill-mixed');
  assert.equal(result.code, 0, `Enough eligible images must fill the limit: ${result.stderr}`);
  const state = await list(directory);
  assert.deepEqual(state.items.map((item: { pin_id: string }) => item.pin_id), ['100', '103', '104'], 'Selection must skip duplicates and unsupported materials');
  assert.equal(state.sources.length, 5, 'All source records must survive filtering');
  assert.equal(state.sources.find((source: { id: string }) => source.id === '101').status, 'failed', 'Material error must be retained');
  assert.equal(state.sources.find((source: { id: string }) => source.id === '102').image_sha256, state.items[0].image_sha256, 'Duplicate source must link to its original hash');
  assert.equal(backfillSummary(result).acceptedCount, 3, 'Only newly created jobs must consume the limit');
});

test('backfill can select bootstrap baseline without an existing job', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'backfill-bootstrap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal((await run(directory, ['bootstrap'], 'backfill-unique')).code, 0, 'Bootstrap must register the historical board');
  const result = await run(directory, ['backfill', '--count', '2'], 'backfill-unique');
  assert.equal(result.code, 0, 'Backfill must select registered baseline');
  assert.equal((await list(directory)).items.length, 2, 'Baseline must remain available to explicit backfill');
});

test('new backfill requests a new portion while resume retains the original limit', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'backfill-portions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await run(directory, ['backfill', '--count', '1'], 'backfill-unique');
  assert.equal(first.code, 0, 'First portion must succeed');
  const firstId = backfillSummary(first).runId;
  assert.equal((await run(directory, ['backfill', '--count', '1', '--resume', firstId], 'backfill-unique')).code, 0, 'Completed request must resume without another portion');
  assert.equal((await list(directory)).items.length, 1, 'Resume must not add another N jobs');
  const second = await run(directory, ['backfill', '--count', '1'], 'backfill-unique');
  assert.equal(second.code, 0, 'New explicit portion must succeed');
  assert.notEqual(backfillSummary(second).runId, firstId, 'New request must have a new identity');
  assert.deepEqual((await list(directory)).items.map((item: { pin_id: string }) => item.pin_id), ['100', '101'], 'Existing job must not consume a new portion');

});

for (const boundary of ['file', 'commit', 'limit']) {
  test(`backfill resumes after a crash at the ${boundary} boundary without exceeding N`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'backfill-crash-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const crashed = await run(directory, ['backfill', '--count', '2'], 'backfill-unique', { BACKFILL_CRASH: boundary });
    assert.equal(crashed.signal, 'SIGKILL', 'Fixture must kill the actual CLI process');
    const state = await list(directory);
    const operation = state.backfillRuns[0];
    assert.equal(operation.accepted_count, boundary === 'file' ? 0 : boundary === 'limit' ? 2 : 1, 'Only committed jobs may consume N');
    assert.equal(state.items.length, operation.accepted_count, 'Job and accepted count must survive atomically');
    assert.equal(state.board.initialized, 0, 'Unfinished initial operation must not authorize ordinary sync');
    const result = await run(directory, ['backfill', '--count', '2', '--resume', operation.id], 'backfill-unique');
    assert.equal(result.code, 0, `Interrupted request must resume: ${result.stderr}`);
    assert.equal(backfillSummary(result).runId, operation.id, 'Resume must preserve the operation identity');
    assert.equal(backfillSummary(result).acceptedCount, 2, 'Resume must stop at the original total');
    const after = await list(directory);
    assert.deepEqual(after.items.map((item: { pin_id: string }) => item.pin_id), ['100', '101'], 'Resume must retain deterministic selection and avoid extra jobs');
    assert.equal(after.backfillRuns.length, 1, 'Resume must not create another persisted request');
    assert.equal((await readdir(join(directory, 'images'))).length, 2, 'File crash must safely reuse already prepared bytes');
  });
}

test('partial initial backfill retains progress and cannot authorize ordinary sync', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'backfill-partial-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await run(directory, ['backfill', '--count', '4'], 'backfill-partial');
  assert.equal(result.code, 1, 'Partial traversal must return nonzero');
  const summary = backfillSummary(result);
  assert.equal(summary.traversalStatus, 'partial', 'Partial traversal must remain explicit');
  assert.equal(summary.acceptedCount, 3, 'Partial traversal must retain its accepted jobs');
  const state = await list(directory);
  assert.equal(state.board.initialized, 0, 'Partial traversal must not initialize history');
  assert.equal(state.sources.length, 3, 'Partial historical sources must survive');
  assert.equal((await run(directory, ['sync'])).code, 1, 'Partial initial backfill must not authorize sync');
  const resumed = await run(directory, ['backfill', '--count', '4', '--resume', summary.runId], 'backfill-mixed');
  assert.equal(resumed.code, 0, 'Full resume must complete the original request');
  assert.equal((await list(directory)).items.length, 4, 'Partial resume must not allocate another original N');
});

for (const count of ['0', '-1', '1.5', 'NaN', '9007199254740992']) {
  test(`backfill rejects invalid count ${count} before touching storage`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'backfill-invalid-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    assert.equal((await run(directory, ['backfill', '--count', count])).code, 1, 'Invalid count must fail');
    assert.deepEqual(await readdir(directory), [], 'Invalid count must not create storage or profiles');
  });
}


test('backfill rejects a changed count when resuming the same operation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'backfill-mismatch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await run(directory, ['backfill', '--count', '1'], 'backfill-unique');
  assert.equal(first.code, 0, 'Original request must succeed');
  const mismatch = await run(directory, ['backfill', '--count', '2', '--resume', backfillSummary(first).runId]);
  assert.equal(mismatch.code, 1, 'Resume must reject a changed original count');
  assert.equal(mismatch.stdout, '', 'Count mismatch must fail before browser work');
  assert.equal((await list(directory)).backfillRuns[0].requested_count, 1, 'Rejected mismatch must not alter the persisted limit');
});

test('new backfill preserves terminal jobs and does not count their hashes again', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'backfill-terminal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal((await run(directory, ['backfill', '--count', '1'], 'backfill-unique')).code, 0, 'First job must be imported');
  assert.equal((await run(directory, ['--help'], 'complete', { QUEUE_FIXTURE_STATUS: 'scheduled' })).code, 0, 'Terminal outcome must be prepared');
  const before = await list(directory);
  const result = await run(directory, ['backfill', '--count', '2'], 'backfill-mixed');
  assert.equal(result.code, 0, 'New request must skip the terminal pin and its duplicate bytes');
  const after = await list(directory);
  assert.deepEqual(after.items[0], before.items[0], 'Existing terminal job must retain every outcome field');
  assert.deepEqual(after.items.map((item: { pin_id: string }) => item.pin_id), ['100', '103', '104'], 'Existing hashes must not consume the new requested count');
  assert.equal(backfillSummary(result).acceptedCount, 2, 'Only new unique jobs must count toward the new operation');
});


test('FIFO selects the oldest safe ready job with deterministic ties and due retry time', () => {
  const now = new Date('2026-11-06T12:00:00.000Z');
  const state = (id: number, status = 'ready', added_at = '2026-11-01T00:00:00.000Z', next_attempt_at: string | null = null, max_post_url: string | null = null) =>
    ({ id, status, added_at, next_attempt_at, max_post_url });
  const jobs = [state(1, 'failed'), state(2, 'uncertain'), state(3, 'ready', undefined, '2026-11-07T00:00:00.000Z'),
    state(8, 'ready', '2026-11-02T00:00:00.000Z'), state(7), state(6, 'ready', undefined, now.toISOString()),
    state(4, 'submitting'), state(5, 'preparing'), state(9, 'scheduled'), state(10, 'skipped'),
    state(11, 'ready', undefined, null, 'https://web.max.ru/existing')];
  assert.equal(nextReadyJob(jobs, now), 6, 'Equal timestamps must use the lowest ID among safe due jobs');
  assert.equal(nextReadyJob(jobs.filter((job) => job.id !== 6), now), 7, 'Older ready jobs must precede newer jobs');
  assert.equal(nextReadyJob(jobs.filter((job) => ![6, 7, 8].includes(job.id)), now), null, 'Deferred or unsafe jobs must not be selected');
});

for (const status of ['ready', 'failed']) {
  test(`queue skip preserves ${status} job data and prevents reimport`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'queue-skip-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    assert.equal((await run(directory, ['backfill', '--count', '1'], 'backfill-unique')).code, 0, 'Fixture must import a job');
    assert.equal((await run(directory, ['--help'], 'complete', { QUEUE_FIXTURE_SAFE_STATUS: status })).code, 0, 'Fixture must prepare the safe state');
    const before = await list(directory);
    const job = before.items[0];
    const bytes = await readFile(join(directory, job.path));
    const result = await run(directory, ['queue', 'skip', String(job.id)], undefined, { PINTEREST_BOARD_URL: 'invalid', PINTEREST_BROWSER_CHANNEL: 'invalid', MAX_CHANNEL_URL: '' });
    assert.equal(result.code, 0, `Skip must work without unrelated configuration: ${result.stderr}`);
    const after = await list(directory);
    assert.deepEqual(after.items, [{ ...job, status: 'skipped', next_attempt_at: null }], 'Skip must retain identity, order, error and outcome');
    assert.deepEqual(after.sources, before.sources, 'Skip must preserve sources');
    assert.deepEqual(JSON.parse(after.queueEvents[0].previous_state), Object.fromEntries(Object.entries(job).filter(([key]) => !['source_url', 'image_url', 'path', 'mime', 'bytes', 'width', 'height'].includes(key))), 'History must retain the original job state');
    assert.equal(after.queueEvents[0].action, 'skip', 'History must identify the manual action');
    assert.equal(after.nextReadyId, null, 'Skipped job must not be available for processing');
    assert.deepEqual(await readFile(join(directory, job.path)), bytes, 'Skip must preserve the file');
    assert.equal((await run(directory, ['backfill', '--count', '1'], 'backfill-unique')).code, 0, 'Next backfill must accept another image');
    const repeated = await list(directory);
    assert.deepEqual(repeated.items[0], after.items[0], 'Reimport must not return the skipped job to ready');
    assert.deepEqual(repeated.queueEvents, after.queueEvents, 'Reimport must preserve the transition history');
  });
}

test('queue retry restores safe readiness with the original order and persistent history', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'queue-retry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal((await run(directory, ['backfill', '--count', '2'], 'backfill-unique')).code, 0, 'Fixture must import ordered jobs');
  assert.equal((await run(directory, ['--help'], 'complete', { QUEUE_FIXTURE_SAFE_STATUS: 'failed' })).code, 0, 'Fixture must prepare definite failure');
  const before = await list(directory);
  const job = before.items[0];
  assert.equal((await run(directory, ['queue', 'retry', String(job.id)], undefined, { PINTEREST_BOARD_URL: 'https://ru.pinterest.com/other/board/', PINTEREST_BROWSER_CHANNEL: 'invalid' })).code, 0, 'Retry must use the stored board without browser configuration');
  const after = await list(directory);
  assert.deepEqual(after.items, [{ ...job, status: 'ready', next_attempt_at: null }, before.items[1]], 'Retry must retain original order, identity and previous errors');
  assert.equal(after.nextReadyId, job.id, 'Retried job must be selectable at its original position');
  assert.equal(after.queueEvents.length, 1, 'Retry must save one transition event');
  assert.equal(JSON.parse(after.queueEvents[0].previous_state).error, job.error, 'Retry history must preserve the original diagnostic');
  assert.equal((await run(directory, ['queue', 'retry', String(job.id)])).code, 1, 'Repeated retry must reject an already ready job');
  assert.deepEqual(await list(directory), after, 'Repeated retry must not duplicate the job or history');
});

for (const status of ['preparing', 'submitting', 'uncertain', 'scheduled', 'skipped']) {
  for (const action of ['skip', 'retry']) {
    test(`queue ${action} rejects ${status} without changing data`, async (t) => {
      const directory = await mkdtemp(join(tmpdir(), 'queue-protected-'));
      t.after(() => rm(directory, { recursive: true, force: true }));
      assert.equal((await run(directory, ['backfill', '--count', '1'], 'backfill-unique')).code, 0, 'Fixture must import a job');
      assert.equal((await run(directory, ['--help'], 'complete', { QUEUE_FIXTURE_SAFE_STATUS: status })).code, 0, 'Fixture must prepare the protected state');
      const before = await list(directory);
      const result = await run(directory, ['queue', action, String(before.items[0].id)]);
      assert.equal(result.code, 1, 'Unsafe manual transition must fail');
      if (action === 'retry' && status === 'uncertain') assert.match(result.stderr, /сверки/, 'Uncertain result must require reconciliation');
      assert.deepEqual(await list(directory), before, 'Rejected transition must preserve job, sources and history');
    });
  }
}

for (const action of ['skip', 'retry']) {
  for (const id of ['', ' ', '0', '-1', '1.5', '9007199254740992']) {
    test(`queue ${action} rejects invalid ID ${JSON.stringify(id)} before touching data`, async (t) => {
      const directory = await mkdtemp(join(tmpdir(), 'queue-invalid-'));
      t.after(() => rm(directory, { recursive: true, force: true }));
      assert.equal((await run(directory, ['queue', action, id])).code, 1, 'Invalid job ID must fail');
      assert.deepEqual(await readdir(directory), [], 'Invalid job ID must not create storage or profiles');
    });
  }
}
