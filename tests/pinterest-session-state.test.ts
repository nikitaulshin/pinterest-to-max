import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('Pinterest state transfer persists cookies privately without overwriting an export', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pinterest-state-'));
  const input = join(directory, 'input.json');
  const output = join(directory, 'output.json');
  const cookies = [{ name: 'test-session', value: 'synthetic-test', domain: '.pinterest.com', path: '/', expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, secure: true, sameSite: 'Lax' }];
  writeFileSync(input, JSON.stringify({ cookies, origins: [] }), { mode: 0o600 });
  const invoke = (action: string, file: string) => spawnSync(process.execPath, ['scripts/pinterest-session-state.ts', action, file], {
    env: { ...process.env, DATA_DIR: directory, PINTEREST_BROWSER_CHANNEL: process.env.PINTEREST_BROWSER_CHANNEL ?? 'chromium' }, encoding: 'utf8',
  });

  const imported = invoke('import', input);
  assert.equal(imported.status, 0, `Import must succeed: ${imported.stderr}`);
  const exported = invoke('export', output);
  assert.equal(exported.status, 0, 'Export after reopening must succeed');
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')).cookies, cookies, 'Transferred cookies must persist after reopening');
  assert.equal(statSync(output).mode & 0o777, 0o600, 'Export must be private');
  assert.notEqual(invoke('export', output).status, 0, 'Existing export must not be overwritten');
  assert.equal(exported.stdout.includes('synthetic-test'), false, 'Cookie values must not be logged');
});

test('Malformed state does not leak its contents', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pinterest-state-invalid-'));
  const file = join(directory, 'state.json');
  writeFileSync(file, 'private-invalid-token', { mode: 0o600 });
  const result = spawnSync(process.execPath, ['scripts/pinterest-session-state.ts', 'import', file], { encoding: 'utf8' });

  assert.notEqual(result.status, 0, 'Malformed state must fail');
  assert.equal((result.stdout + result.stderr).includes('private-invalid-token'), false, 'Malformed state must not be logged');
});

test('MAX state is rejected before opening the Pinterest profile', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pinterest-state-wrong-service-'));
  const file = join(directory, 'state.json');
  const data = join(directory, 'data');
  writeFileSync(file, JSON.stringify({ cookies: [{ domain: '.max.ru', value: 'private-max-token' }], origins: [] }), { mode: 0o600 });
  const result = spawnSync(process.execPath, ['scripts/pinterest-session-state.ts', 'import', file], {
    env: { ...process.env, DATA_DIR: data }, encoding: 'utf8',
  });

  assert.notEqual(result.status, 0, 'State for another service must fail');
  assert.equal(existsSync(data), false, 'Rejected state must not open or create a profile');
  assert.equal((result.stdout + result.stderr).includes('private-max-token'), false, 'Rejected state must not be logged');
});
