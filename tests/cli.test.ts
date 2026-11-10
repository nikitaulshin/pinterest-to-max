import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pinterestConfiguration } from '../src/cli.ts';
import { boardAccess } from '../src/integrations/pinterest/session.ts';

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pinterest-cli-'));
  try {
    const result = spawnSync(process.execPath, ['dist/main.js', ...args], {
      env: { ...process.env, DATA_DIR: directory, ...env }, encoding: 'utf8', timeout: 5000,
    });
    assert.deepEqual(readdirSync(directory), [], 'Invalid commands and help must not create data');

    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('unknown command fails before modifying data', () => {
  const result = run(['auth', 'invalid']);
  assert.equal(result.status, 1, 'Unsupported command must fail');
  assert.equal(JSON.parse(result.stderr.split('\n').find((line) => line.startsWith('{')) ?? '{}').event, 'error', 'Failure must be structured');
  assert.equal(result.stdout, '', 'Invalid command must not report readiness');
});

for (const url of ['invalid', 'https://evil.example/user/board/', 'https://ru.pinterest.com/pin/123/', 'https://user:secret@ru.pinterest.com/user/board/', 'https://ru.pinterest.com/user/board/?token=secret']) {
  test(`invalid board URL is rejected: ${url.replace(/secret/g, 'redacted')}`, () => {
    const result = run(['auth', 'pinterest'], { PINTEREST_BOARD_URL: url });
    assert.equal(result.status, 1, 'Invalid URL must fail before browser launch');
    assert.match(result.stderr, /PINTEREST_BOARD_URL/, 'Error must identify the invalid setting');
    assert.ok(!result.stderr.includes('secret'), 'Error must not echo credentials or query secrets');
  });
}

test('help only lists implemented commands and ignores unrelated configuration', () => {
  const result = run(['--help'], { DATA_DIR: '', PINTEREST_BOARD_URL: 'invalid' });
  assert.equal(result.status, 0, 'Help must work without valid configuration');
  assert.match(result.stdout, /auth pinterest/, 'Help must describe implemented authentication');
  assert.match(result.stdout, /sync \[--full\]/, 'Help must describe file synchronization');
  assert.match(result.stdout, /queue list/, 'Help must describe read-only queue inspection');
  assert.match(result.stdout, /bootstrap/, 'Help must describe explicit history initialization');
  assert.match(result.stdout, /backfill --count N/, 'Help must describe explicit historical import');
  assert.match(result.stdout, /queue skip ID/, 'Help must describe safe manual skipping');
  assert.match(result.stdout, /queue retry ID/, 'Help must describe safe manual retry');
  assert.match(result.stdout, /auth max/, 'Help must describe MAX authentication');
});

test('Pinterest configuration does not require MAX settings', () => {
  assert.equal(pinterestConfiguration({}).boardUrl, 'https://ru.pinterest.com/mixi56453/max7/', 'Default board must be preserved');
  assert.equal(pinterestConfiguration({}).channel, 'chromium', 'Default browser must remain Playwright Chromium');
});

const ready = { challenge: false, login: false, account: true, board: true, heading: true, pins: true };
test('expired access overrides otherwise readable board', () => {
  assert.equal(boardAccess({ ...ready, login: true }), 'auth-required', 'Logged-out signal must stop protected work');
});
test('CAPTCHA overrides otherwise authenticated board', () => {
  assert.equal(boardAccess({ ...ready, challenge: true }), 'captcha', 'Challenge must stop automation');
});
test('changed board structure is not accepted', () => {
  assert.equal(boardAccess({ ...ready, heading: false }), 'unknown', 'Missing expected structure must stop the operation');
});
test('account button does not prove board access', () => {
  assert.equal(boardAccess({ ...ready, board: false }), 'unknown', 'A different board must not be accepted');
});
test('confirmed board access is accepted', () => {
  assert.equal(boardAccess(ready), 'ready', 'Authenticated board with observed structure must be accepted');
});

test('MAX configuration requires an explicit target', async () => {
  const { maxConfiguration } = await import('../src/cli.ts');
  assert.throws(() => maxConfiguration({}), /MAX_CHANNEL_URL/, 'Missing target must fail');
  assert.throws(() => maxConfiguration({ MAX_CHANNEL_URL: 'https://max.ru/channel_du?secret=x' }), /MAX_CHANNEL_URL/, 'Query parameters must be rejected');
  assert.throws(() => maxConfiguration({ MAX_CHANNEL_URL: 'https://evil.example/channel_du' }), /MAX_CHANNEL_URL/, 'Another host must be rejected');
});

test('MAX browser choice is independent from Pinterest', async () => {
  const { maxConfiguration } = await import('../src/cli.ts');
  const configuration = maxConfiguration({ MAX_CHANNEL_URL: 'https://max.ru/channel_du/', PINTEREST_BROWSER_CHANNEL: 'chrome' });
  assert.equal(configuration.channel, 'chromium', 'MAX must default to bundled Chromium independently');
  assert.equal(configuration.channelUrl, 'https://max.ru/channel_du', 'Channel identity must be canonical');
  assert.equal(maxConfiguration({ MAX_CHANNEL_URL: configuration.channelUrl, MAX_BROWSER_CHANNEL: 'chrome' }).channel, 'chrome', 'Installed Chrome must require explicit MAX selection');
});


test('MAX authentication without target fails before modifying data', () => {
  const result = run(['auth', 'max'], { MAX_CHANNEL_URL: '' });
  assert.equal(result.status, 1, 'Missing target must fail');
  assert.match(result.stderr, /MAX_CHANNEL_URL/, 'Error must identify the missing target');
});
