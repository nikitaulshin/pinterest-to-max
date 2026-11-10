import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`application starts and shuts down on ${signal}`, { timeout: 10_000 }, async (t) => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'pinterest-to-max-'));
    const child = spawn(process.execPath, ['dist/main.js'], {
      env: { ...process.env, DATA_DIR: dataDirectory },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    const lines = createInterface({ input: child.stdout });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    t.after(async () => {
      child.kill('SIGKILL');
      await exited;
      lines.close();
      await rm(dataDirectory, { recursive: true, force: true });
    });

    const firstLine = once(lines, 'line').then(([line]) => line as string);
    const startup = await Promise.race([
      firstLine,
      exited.then(() => { throw new Error(`Application exited before startup: ${stderr}`); }),
    ]);
    assert.deepEqual(JSON.parse(startup), { event: 'started', mode: 'idle' }, 'Application must report startup');

    child.kill(signal);
    const [exitCode, exitSignal] = await exited;
    assert.equal(exitCode, 0, `Application must exit successfully: ${stderr}`);
    assert.equal(exitSignal, null, 'Application must handle the shutdown signal');
  });
}

test('application rejects an empty data directory', { timeout: 10_000 }, async (t) => {
  const child = spawn(process.execPath, ['dist/main.js'], {
    env: { ...process.env, DATA_DIR: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  t.after(() => { child.kill('SIGKILL'); });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });

  const [exitCode] = await exited;
  assert.equal(exitCode, 1, 'Invalid configuration must fail startup');
  assert.equal(stdout, '', 'Failed startup must not report readiness');
  assert.match(stderr, /DATA_DIR/, 'Startup error must identify the invalid setting');
});
