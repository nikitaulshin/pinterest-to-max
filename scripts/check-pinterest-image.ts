import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { pinterestConfiguration } from '../src/cli.ts';
import { acquireStorageOwnership } from '../src/storage-ownership.ts';
import { extractOnePin } from '../src/integrations/pinterest/pin.ts';
import { downloadPinImage } from '../src/integrations/pinterest/image.ts';

// Явная live-проверка: node --env-file-if-exists=.env scripts/check-pinterest-image.ts.
process.umask(0o077);
const configuration = pinterestConfiguration(process.env);
const release = acquireStorageOwnership(configuration.dataDirectory);
try {
  const diagnostics = join(configuration.dataDirectory, 'diagnostics', `image-${Date.now()}`);
  mkdirSync(diagnostics, { recursive: true, mode: 0o700 });
  const context = await chromium.launchPersistentContext(join(configuration.dataDirectory, 'profiles/pinterest'), {
    headless: false,
    ...(configuration.channel === 'chrome' ? { channel: 'chrome' } : {}),
  });
  let page = context.pages()[0];
  try {
    page ??= await context.newPage();
    const pin = await extractOnePin(page, configuration.boardUrl);
    const result = await downloadPinImage(page, pin, configuration.dataDirectory);
    writeFileSync(join(diagnostics, 'image.json'), JSON.stringify({ date: new Date().toISOString(), boardUrl: configuration.boardUrl, pin, result }, null, 2), { mode: 0o600 });
    assert.equal(result.status, 'ready', 'Live image must be downloaded and decoded');
    if (result.status !== 'ready') throw new Error('Live image is not ready');
    const bytes = readFileSync(result.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), result.sha256, 'Saved live file must match SHA256');
    assert.equal(result.width * result.height, Math.max(...result.variants.map((variant) => variant.width * variant.height)), 'Live result must use the largest decoded observed variant');
    const decoded = await page.evaluate(async ({ encoded, mime }) => {
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
      const result = { width: bitmap.width, height: bitmap.height };
      bitmap.close();

      return result;
    }, { encoded: bytes.toString('base64'), mime: result.mime });
    assert.deepEqual(decoded, { width: result.width, height: result.height }, 'Persisted file must decode to the selected dimensions');
    writeFileSync(join(diagnostics, 'decode.json'), JSON.stringify({ ...decoded, sha256: result.sha256, file: result.path, imageUrl: result.imageUrl }, null, 2), { mode: 0o600 });
    await page.screenshot({ path: join(diagnostics, 'pin.png') });
    chmodSync(join(diagnostics, 'pin.png'), 0o600);
    console.log(JSON.stringify({ event: 'pinterest-image-verified', id: pin.id, width: result.width, height: result.height, diagnostics }));
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
    console.error(JSON.stringify({ event: 'pinterest-image-failed', diagnostics, screenshotAvailable }));
    throw error;
  } finally {
    await context.close();
  }
} finally { release(); }
