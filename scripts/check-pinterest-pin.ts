import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { pinterestConfiguration } from '../src/cli.ts';
import { acquireStorageOwnership } from '../src/storage-ownership.ts';
import { extractOnePin } from '../src/integrations/pinterest/pin.ts';

// Явная live-проверка: node --env-file-if-exists=.env scripts/check-pinterest-pin.ts.
process.umask(0o077);
const configuration = pinterestConfiguration(process.env);
const release = acquireStorageOwnership(configuration.dataDirectory);
try {
  const diagnostics = join(configuration.dataDirectory, 'diagnostics', `pin-${Date.now()}`);
  mkdirSync(diagnostics, { recursive: true, mode: 0o700 });
  const context = await chromium.launchPersistentContext(join(configuration.dataDirectory, 'profiles/pinterest'), {
    headless: false,
    ...(configuration.channel === 'chrome' ? { channel: 'chrome' } : {}),
  });
  let page = context.pages()[0];
  try {
    page ??= await context.newPage();
    const pin = await extractOnePin(page, configuration.boardUrl);
    assert.match(pin.id, /^\d+$/, 'Live pin must have a numeric ID');
    assert.equal(new URL(pin.url).pathname, `/pin/${pin.id}/`, 'Live pin URL must match its ID');
    assert.ok(pin.imageUrls.length > 1, 'Live pin must expose image candidates');
    writeFileSync(join(diagnostics, 'pin.json'), JSON.stringify({ date: new Date().toISOString(), boardUrl: configuration.boardUrl, ...pin }, null, 2), { mode: 0o600 });
    await page.screenshot({ path: join(diagnostics, 'pin.png') });
    chmodSync(join(diagnostics, 'pin.png'), 0o600);
    console.log(JSON.stringify({ event: 'pinterest-pin-verified', id: pin.id, url: pin.url, candidates: pin.imageUrls.length, diagnostics }));
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
    console.error(JSON.stringify({ event: 'pinterest-pin-failed', diagnostics, screenshotAvailable }));
    throw error;
  } finally {
    await context.close();
  }
} finally { release(); }
