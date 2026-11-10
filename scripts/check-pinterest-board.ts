import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { pinterestConfiguration } from '../src/cli.ts';
import { acquireStorageOwnership } from '../src/storage-ownership.ts';
import { traverseBoard } from '../src/integrations/pinterest/board.ts';

// Явная live-проверка: node --env-file-if-exists=.env scripts/check-pinterest-board.ts.
process.umask(0o077);
const configuration = pinterestConfiguration(process.env);
const release = acquireStorageOwnership(configuration.dataDirectory);
try {
  const diagnostics = join(configuration.dataDirectory, 'diagnostics', `board-${Date.now()}`);
  mkdirSync(diagnostics, { recursive: true, mode: 0o700 });
  const context = await chromium.launchPersistentContext(join(configuration.dataDirectory, 'profiles/pinterest'), {
    headless: false,
    ...(configuration.channel === 'chrome' ? { channel: 'chrome' } : {}),
  });
  let page = context.pages()[0];
  try {
    page ??= await context.newPage();
    const result = await traverseBoard(page, configuration.boardUrl);
    writeFileSync(join(diagnostics, 'board.json'), JSON.stringify({ date: new Date().toISOString(), boardUrl: configuration.boardUrl, ...result }, null, 2), { mode: 0o600 });
    await page.screenshot({ path: join(diagnostics, 'board.png') });
    chmodSync(join(diagnostics, 'board.png'), 0o600);
    console.log(JSON.stringify({ event: 'pinterest-board-checked', status: result.status, count: result.pins.length, expectedCount: result.expectedCount, reason: result.reason, diagnostics }));
    assert.equal(result.status, 'complete', 'Live board traversal must confirm the end');
    assert.equal(result.pins.length, result.expectedCount, 'Live board traversal must cover every pin');
    assert.equal(new Set(result.pins.map((pin) => pin.id)).size, result.pins.length, 'Live board pins must be unique');
  } catch (error) {
    const screenshot = join(diagnostics, 'error.png');
    let screenshotAvailable = false;
    try {
      if (page) {
        await page.screenshot({ path: screenshot });
        chmodSync(screenshot, 0o600);
        screenshotAvailable = true;
      }
    } catch { /* Закрытый браузер не должен скрывать исходную ошибку. */ }
    console.error(JSON.stringify({ event: 'pinterest-board-failed', diagnostics, screenshotAvailable }));
    throw error;
  } finally {
    await context.close();
  }
} finally { release(); }
