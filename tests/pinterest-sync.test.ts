import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

async function run(scenario: string, full = false) {
  const directory = await mkdtemp(join(tmpdir(), 'pinterest-sync-'));
  try {
    const initialized = spawnSync(process.execPath, ['--import', './tests/fixtures/pinterest-sync.ts', 'dist/main.js', 'bootstrap'], {
      env: { ...process.env, DATA_DIR: directory, SYNC_SCENARIO: 'history' }, encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(initialized.status, 0, `Explicit history setup must succeed: ${initialized.stderr}`);

    const child = spawn(process.execPath, ['--import', './tests/fixtures/pinterest-sync.ts', 'dist/main.js', 'sync', ...(full ? ['--full'] : [])], {
      env: { ...process.env, DATA_DIR: directory, SYNC_SCENARIO: scenario }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let signalSent = false;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk;
      if (scenario === 'interrupted' && !signalSent && chunk.toString().includes('pinterest-image-processed')) {
        signalSent = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI scenario timed out')); }, 60_000);
      child.once('error', reject);
      child.once('close', (code) => { clearTimeout(timeout); resolve(code); });
    });
    const events = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const summary = events.find((event) => event.event === 'pinterest-sync-finished');
    assert.ok(summary, `CLI must report its result: ${stderr}`);
    const saved = JSON.parse(await readFile(join(summary.diagnostics, 'summary.json'), 'utf8'));
    const sources = JSON.parse(await readFile(join(summary.diagnostics, 'sources.json'), 'utf8'));
    const results = (await readFile(join(summary.diagnostics, 'results.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal((await stat(summary.diagnostics)).mode & 0o777, 0o700, 'Diagnostics directory must be private');
    assert.equal((await stat(join(summary.diagnostics, 'results.jsonl'))).mode & 0o777, 0o600, 'Journal must be private');
    assert.equal(saved.status, summary.status, 'Saved summary must match CLI result');
    assert.equal(sources.pins.length, 3, 'All observed sources must survive every outcome');
    assert.ok(!stdout.includes('queueReady'), 'File import must not announce a queue');
    assert.ok((await readdir(directory)).includes('state.sqlite'), 'Sync must persist import state');
    for (const result of results.filter((result) => result.status === 'ready')) {
      assert.ok((await stat(result.path)).size > 0, 'Ready result must reference a real file');
    }

    return { code, summary, results };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

for (const full of [false, true]) {
  test(`public sync${full ? ' --full' : ''} saves all pins and files`, async () => {
    const { code, summary, results } = await run('complete', full);
    assert.equal(code, 0, 'Complete sync must succeed');
    assert.equal(summary.traversalStatus, 'complete', 'Traversal must be complete');
    assert.equal(summary.ready, 3, 'Every supported source must be saved');
    assert.deepEqual(results.map((result) => result.id), ['100', '101', '102'], 'Known content must not stop traversal');
  });
}

for (const scenario of ['unsupported', 'download-failure']) {
  test(`${scenario} retains its failure and later sources still download`, async () => {
    const { code, summary, results } = await run(scenario);
    assert.equal(code, 1, 'Material failure must produce nonzero exit');
    assert.equal(summary.traversalStatus, 'complete', 'Material failure must not change traversal completeness');
    assert.equal(summary.materialFailures, 1, 'Material failures must be counted separately');
    assert.deepEqual(results.map((result) => result.status), ['ready', 'failed', 'ready'], 'A failed material must not lose later images');
  });
}

test('observed single-image story layout retains pin identity and downloads its image', async () => {
  const { code, summary, results } = await run('story');
  assert.equal(code, 0, 'Confirmed single-image story must be supported');
  assert.equal(summary.ready, 3, 'Story layout must not stop later sources');
  assert.equal(results[1].id, '101', 'Story must retain the confirmed source identity');
});

test('partial traversal remains incomplete while preserving observed downloads', async () => {
  const { code, summary, results } = await run('partial', true);
  assert.equal(code, 1, 'Partial traversal must produce nonzero exit');
  assert.equal(summary.traversalStatus, 'partial', 'Partial traversal must remain explicit');
  assert.equal(summary.traversalReason, 'count-changed', 'Partial reason must be preserved');
  assert.equal(results.length, 3, 'Safe observed sources must remain downloadable');
});

for (const scenario of ['captcha', 'auth', 'structure']) {
  test(`${scenario} stops later browser actions while preserving earlier files`, async () => {
    const { code, summary, results } = await run(scenario);
    assert.equal(code, 1, 'Browser stop must produce nonzero exit');
    assert.equal(summary.status, 'incomplete', 'Blocked browser must never report complete');
    assert.equal(summary.unprocessed, 1, 'Later pin must not be visited');
    assert.equal(summary.materialFailures, 0, 'Browser block must remain separate from material errors');
    assert.equal(summary.browserFailures, 1, 'Browser failure must be counted separately');
    assert.deepEqual(results.map((result) => result.status), ['ready', 'failed'], 'Earlier download and blocking failure must survive');
    assert.equal(summary.browserStop, scenario === 'auth' ? 'auth-required' : scenario === 'structure' ? 'structure-changed' : 'captcha', 'Browser stop reason must be explicit');
  });
}

test('SIGTERM preserves completed files and closes the sync browser with an incomplete result', async () => {
  const { code, summary, results } = await run('interrupted');
  assert.equal(code, 1, 'Interrupted sync must produce nonzero exit');
  assert.equal(summary.browserStop, 'interrupted', 'Interruption must remain explicit');
  assert.equal(summary.status, 'incomplete', 'Interrupted sync must not report completion');
  assert.equal(results[0].status, 'ready', 'Earlier file must survive interruption');
});
