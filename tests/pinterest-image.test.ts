import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { pinterestConfiguration } from '../src/cli.ts';
import { extractPin } from '../src/integrations/pinterest/pin.ts';
import { downloadPinImage, preparePinImage } from '../src/integrations/pinterest/image.ts';

let browser: Browser;
before(async () => { browser = await chromium.launch(pinterestConfiguration(process.env).channel === 'chrome' ? { channel: 'chrome' } : {}); });
after(async () => { await browser?.close(); });
const signature = 'c6c5d3974290d1bff2e2f72626f49add';
const small = `https://i.pinimg.com/236x/c6/c5/d3/${signature}.png`;
const large = `https://i.pinimg.com/originals/c6/c5/d3/${signature}.png`;
const pin = { id: '100', url: 'https://ru.pinterest.com/pin/100/', signature, imageUrls: [small, large] };

async function fixture() {
  const page = await browser.newPage();
  const directory = await mkdtemp(join(tmpdir(), 'pinterest-image-'));
  const png = async (width: number) => Buffer.from(await page.evaluate((width) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = 2;
    canvas.getContext('2d')!.fillRect(0, 0, width, 2);

    return canvas.toDataURL('image/png').split(',')[1]!;
  }, width), 'base64');
  const bodies = new Map([[small, await png(2)], [large, await png(8)]]);
  const requests: string[] = [];
  let mode = 'ok';
  const request = { async get(url: string, options: { maxRedirects: number }) {
    requests.push(url);
    assert.equal(options.maxRedirects, 0, 'Redirects must never be followed automatically');
    if (mode === 'network') throw new Error('ECONNRESET https://i.pinimg.com/a?token=secret');
    if (mode === 'abort' || (mode === 'abort-large' && url === large)) throw new Error('Connection aborted');
    const original = bodies.get(url)!;
    const body = mode === 'corrupt' ? Buffer.concat([original.subarray(0, 8), Buffer.alloc(original.length - 20), original.subarray(-12)]) : mode === 'html' ? Buffer.from('<html>Login</html>') : mode === 'truncated' ? original.subarray(0, original.length - 12) : original;

    return { status: () => mode === 'temporary-http' ? 503 : mode === 'forbidden' ? 403 : mode === 'redirect' ? 302 : 200, url: () => url, headers: () => ({ 'content-type': mode === 'html' ? 'text/html' : 'image/png', 'content-length': String(mode === 'truncated' ? original.length : body.length) }), body: async () => body, dispose: async () => {} };
  } };
  const downloadPage = { context: () => ({ request }), evaluate: page.evaluate.bind(page) } as unknown as Page;

  return { page, directory, bodies, requests, downloadPage, mode(value: string) { mode = value; }, async close() { await page.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('largest decoded observed variant replaces thumbnail and is atomically saved with SHA256', async () => {
  const f = await fixture();
  try {
    const result = await downloadPinImage(f.downloadPage, pin, f.directory);
    assert.equal(result.status, 'ready', 'Valid image must become ready');
    if (result.status !== 'ready') return;
    assert.equal(result.imageUrl, large, 'Largest decoded variant must be selected');
    assert.equal(result.width, 8, 'Actual file dimensions must determine resolution');
    assert.deepEqual(await readFile(result.path), f.bodies.get(large), 'Saved bytes must match the selected variant');
    assert.equal(result.sha256, createHash('sha256').update(f.bodies.get(large)!).digest('hex'), 'Hash must cover exact saved bytes');
    assert.deepEqual(await readdir(join(f.directory, 'images')), [`${result.sha256}.png`], 'Only the final file may remain');
    assert.equal((await stat(result.path)).mode & 0o777, 0o600, 'Image must remain private');
    assert.deepEqual(f.requests, [small, large], 'Only observed CDN URLs may be requested');
  } finally { await f.close(); }
});

for (const mode of ['abort', 'truncated', 'html', 'redirect', 'corrupt']) {
  test(`${mode} response retains source and fails without a ready file`, async () => {
    const f = await fixture();
    f.mode(mode);
    try {
      const result = await downloadPinImage(f.downloadPage, pin, f.directory);
      assert.equal(result.status, 'failed', 'Invalid download must fail');
      if (result.status !== 'failed') return;
      assert.equal(result.url, pin.url, 'Failure must retain pin source');
      assert.equal(result.imageUrl, small, 'Failure must retain attempted image URL');
      assert.ok(result.reason.length > 0, 'Failure must explain its reason');
      await assert.rejects(readdir(join(f.directory, 'images')), { code: 'ENOENT' }, 'Failure must not create a ready file');
    } finally { await f.close(); }
  });
}

test('insecure and unrelated image sources fail before a request', async () => {
  const f = await fixture();
  try {
    for (const imageUrl of [small.replace('https:', 'http:'), small.replace('i.pinimg.com', 'example.com')]) {
      const result = await downloadPinImage(f.downloadPage, { ...pin, imageUrls: [imageUrl] }, f.directory);
      assert.equal(result.status, 'failed', 'Untrusted URL must fail');
    }
    assert.deepEqual(f.requests, [], 'Untrusted URLs must never be requested');
  } finally { await f.close(); }
});

test('unsupported material fails independently before opening unrelated thumbnails', async () => {
  const f = await fixture();
  try {
    const result = await preparePinImage(f.page, { id: pin.id, url: pin.url, imageError: 'Pinterest: неподдерживаемый материал.' }, 'https://ru.pinterest.com/example/board/', f.directory);
    assert.equal(result.status, 'failed', 'Unsupported material must not become ready');
    if (result.status !== 'failed') return;
    assert.match(result.reason, /неподдерживаемый/, 'Unsupported failure must preserve its reason');
    assert.equal(result.url, pin.url, 'Unsupported failure must preserve source');
    assert.equal(f.page.url(), 'about:blank', 'Unsupported material must not open recommendations');
  } finally { await f.close(); }
});


test('an unavailable large observed variant cannot silently fall back to a thumbnail', async () => {
  const f = await fixture();
  f.mode('abort-large');
  try {
    const result = await downloadPinImage(f.downloadPage, pin, f.directory);
    assert.equal(result.status, 'failed', 'Unverified maximum must not produce a ready thumbnail');
    if (result.status !== 'failed') return;
    assert.equal(result.imageUrl, large, 'Failure must identify the unavailable large variant');
    await assert.rejects(readdir(join(f.directory, 'images')), { code: 'ENOENT' }, 'Thumbnail must not be saved as final');
  } finally { await f.close(); }
});


test('an arbitrary confirmed source opens its pin directly without traversing the board again', async () => {
  const f = await fixture();
  const navigations: string[] = [];
  try {
    await f.page.route('**/*', (route) => {
      if (route.request().isNavigationRequest()) {
        navigations.push(route.request().url());
        return route.fulfill({ contentType: 'text/html', body: `<div data-test-id="closeup-image" data-pin-drag-id="100"><div data-test-id="closeup-image-main"><img src="${small}"></div></div>` });
      }

      return route.fulfill({ contentType: 'image/png', body: f.bodies.get(small)! });
    });
    const extracted = await extractPin(f.page, pin, 'https://ru.pinterest.com/example/board/');
    assert.deepEqual(navigations, [pin.url], 'Arbitrary extraction must not navigate to the board or slot zero');
    assert.deepEqual(extracted.imageUrls, [small, large], 'Card maximum must survive closeup extraction');
  } finally { await f.close(); }
});

for (const mode of ['network', 'temporary-http', 'forbidden', 'corrupt']) test(`classifies ${mode} without saving a partial file`, async () => {
  const f = await fixture();
  f.mode(mode);
  try {
    const result = await downloadPinImage(f.downloadPage, pin, f.directory);
    assert.equal(result.status, 'failed', 'The source must retain a failed outcome');
    if (result.status !== 'failed') return;
    assert.equal(result.code, ['network', 'temporary-http'].includes(mode) ? 'network' : 'unknown', 'Only proven transport and temporary HTTP errors may request retry');
    assert.doesNotMatch(result.reason, /token=secret/, 'Public reasons must not expose raw CDN queries');
    await assert.rejects(readdir(join(f.directory, 'images')), { code: 'ENOENT' }, 'Failed input must not create a ready file');
  } finally { await f.close(); }
});
