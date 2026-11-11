import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportBrowserFailure } from '../src/integrations/diagnostics.ts';
import { chromium } from 'playwright';
import { authenticateMax } from '../src/integrations/max/session.ts';
import { authenticatePinterest } from '../src/integrations/pinterest/session.ts';
import { IntegrationFailure } from '../src/integrations/failure.ts';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'private-diagnostics-'));
  const events: Record<string, unknown>[] = [];
  t.mock.method(console, 'error', (line: string) => events.push(JSON.parse(line)));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, events };
}

test('closed browser preserves the original failure and explicitly reports the missing screenshot', async (t) => {
  const { directory, events } = fixture(t);
  const cause = new Error('page.goto: net::ERR_CONNECTION_RESET https://cdn.test/photo?token=secret');
  const failure = await reportBrowserFailure({ directory, service: 'max', operation: 'submit', jobId: 7, error: cause,
    page: { screenshot: async () => { throw new Error('Target page has been closed'); } } });
  assert.equal(failure.cause, cause, 'Optional screenshot failures must preserve the original cause');
  assert.equal(failure.code, 'network', 'Optional screenshot failures must preserve the network code');
  assert.equal(events[0]!.screenshotAvailable, false, 'The event must explicitly report an unavailable screenshot');
  assert.equal(events[0]!.jobId, 7, 'The event must retain the available job identity');
  assert.equal(events[0]!.diagnosticWritten, true, 'Closed browsers must not prevent the safe JSON report');
});

test('unwritable diagnostics preserve the original failure and report that no artifacts were written', async (t) => {
  const f = fixture(t);
  const blocker = join(f.directory, 'file');
  writeFileSync(blocker, 'not a directory');
  const cause = new IntegrationFailure('auth-required', 'MAX: требуется auth max.');
  const failure = await reportBrowserFailure({ directory: join(blocker, 'child'), service: 'pinterest', operation: 'sync', error: cause,
    page: { screenshot: async () => Buffer.from('private screenshot') } });
  assert.equal(failure.cause, cause, 'Disk errors must never replace the original cause');
  assert.equal(failure.code, 'auth-required', 'Disk errors must never replace the original failure code');
  assert.equal(f.events[0]!.screenshotAvailable, false, 'Unavailable directories cannot claim a screenshot');
  assert.equal(f.events[0]!.diagnosticWritten, false, 'Unavailable directories must explicitly report failed diagnostics');
});

test('screenshots and summaries are private even with a permissive process umask', async (t) => {
  const { directory, events } = fixture(t);
  const previous = process.umask(0);
  t.after(() => process.umask(previous));
  const output = join(directory, 'diagnostics');
  await reportBrowserFailure({ directory: output, service: 'max', operation: 'read-scheduled', error: new Error('controlled failure'),
    page: { screenshot: async (options) => {
      assert.equal(options?.path, undefined, 'Playwright must return a buffer without creating a public intermediate file');
      return Buffer.from('private screenshot');
    } } });
  assert.equal(statSync(output).mode & 0o777, 0o700, 'Diagnostic directories must be private');
  assert.equal(statSync(join(output, 'error.png')).mode & 0o777, 0o600, 'Screenshot bytes must be private');
  assert.equal(statSync(join(output, 'summary.json')).mode & 0o777, 0o600, 'Summary bytes must be private');
  assert.equal(events[0]!.screenshotAvailable, true, 'A fully written screenshot must be reported');
});

test('private error details never enter error events or summaries', async (t) => {
  const { directory, events } = fixture(t);
  const cause = new Error('MAX: password=hunter2 cookie=session-secret code=123456 https://cdn.test/a?token=raw-secret');
  const failure = await reportBrowserFailure({ directory, service: 'max', operation: 'auth', error: cause });
  const publicText = JSON.stringify(events) + readFileSync(join(directory, 'summary.json'), 'utf8');
  assert.doesNotMatch(publicText, /hunter2|session-secret|123456|raw-secret|cdn.test/, 'Private credentials and request URLs must never enter diagnostics');
  assert.equal(failure.cause, cause, 'Raw errors must remain available only through the in-memory cause');
});


test('a screenshot write failure leaves the original browser cause and the JSON report intact', async (t) => {
  const { directory, events } = fixture(t);
  mkdirSync(join(directory, 'error.png'));
  const cause = new IntegrationFailure('network', 'Controlled network failure');
  const failure = await reportBrowserFailure({ directory, service: 'max', operation: 'submit', error: cause,
    page: { screenshot: async () => Buffer.from('private screenshot') } });
  assert.equal(failure.cause, cause, 'A failed screenshot write must preserve the original browser cause');
  assert.equal(failure.code, 'network', 'A failed screenshot write must preserve the original browser code');
  assert.equal(events[0]!.screenshotAvailable, false, 'A failed file write cannot claim a screenshot');
  assert.equal(events[0]!.diagnosticWritten, true, 'Screenshot failure must not block the safe JSON report');
});


test('typed integration failures cannot bypass private detail redaction', async (t) => {
  const { directory, events } = fixture(t);
  const cause = new IntegrationFailure('auth-required', 'MAX: token=session-secret code=123456 https://cdn.test/a?token=raw-secret');
  const failure = await reportBrowserFailure({ directory, service: 'max', operation: 'auth', error: cause });
  assert.doesNotMatch(JSON.stringify(events) + readFileSync(join(directory, 'summary.json'), 'utf8'), /session-secret|123456|raw-secret|cdn.test/, 'Typed failures must not bypass redaction');
  assert.equal(failure.code, 'auth-required', 'Redaction must preserve the typed failure code');
  assert.equal(failure.cause, cause, 'Redaction must preserve the original typed failure as its cause');
});


for (const service of ['max', 'pinterest'] as const) {
  test(`${service} launch failure retains a safe installation hint and the original private cause`, async (t) => {
    const { directory, events } = fixture(t);
    const cause = new Error('browserType.launch: executable missing https://private.test/browser?token=launch-secret');
    t.mock.method(chromium, 'launchPersistentContext', async () => { throw cause; });
    const operation = service === 'max'
      ? authenticateMax({ dataDirectory: directory, channelUrl: 'https://max.ru/channel_du', channel: 'chromium' })
      : authenticatePinterest({ dataDirectory: directory, boardUrl: 'https://ru.pinterest.com/board/', channel: 'chromium' });
    await assert.rejects(operation, (error: unknown) => {
      assert.ok(error instanceof IntegrationFailure, 'Launch failures must expose a safe typed failure');
      assert.match(error.message, /не удалось открыть браузер.*установку.*владельца профиля/, 'Launch failures must preserve the operator recovery hint');
      let original: unknown = error;
      while (original instanceof Error && original.cause) original = original.cause;
      assert.equal(original, cause, 'The original launch cause must survive diagnostic wrapping');
      return true;
    });
    assert.doesNotMatch(JSON.stringify(events), /private.test|launch-secret/, 'Raw launch command details must never enter logs');
    assert.equal(events[0]!.screenshotAvailable, false, 'Failed browser startup cannot provide a screenshot');
  });
}
