import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { pixels, confirmMaxPost } from '../src/integrations/max/confirmation.ts';

let browser: Browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function fixture(variant: string) {
  const page = await browser.newPage();
  await page.route('https://web.max.ru/**', route => route.fulfill({ contentType: 'text/html', body: '<div></div>' }));
  await page.goto('https://web.max.ru/test');
  const images = await page.evaluate(variant => {
    const original = document.createElement('canvas'); original.width = 256; original.height = 256;
    const context = original.getContext('2d')!;
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      context.fillStyle = variant === 'low-information' ? 'red' : `rgb(${x},${y},${(x + y) / 2})`;
      context.fillRect(x, y, 1, 1);
    }
    const candidate = document.createElement('canvas'); candidate.width = 128; candidate.height = 128;
    const target = candidate.getContext('2d')!;
    if (variant === 'flip') { target.translate(128, 0); target.scale(-1, 1); }
    if (variant === 'brightness') target.filter = 'brightness(110%)';
    if (variant === 'crop') target.drawImage(original, 10, 10, 236, 236, 0, 0, 128, 128);
    else target.drawImage(original, 0, 0, 128, 128);
    if (variant === 'overlay') { target.fillStyle = 'black'; target.fillRect(64, 64, 13, 13); }
    return { original: original.toDataURL(), candidate: candidate.toDataURL('image/jpeg', 0.98) };
  }, variant);
  await page.setContent(`<div class="delayedChat"><div role="listitem"><img src="${images.candidate}" onclick="document.querySelector('#viewer').hidden=false"></div></div><div id="viewer" hidden><button aria-label="Скачать"></button><img src="${images.candidate}"><button aria-label="Закрыть" onclick="this.parentElement.hidden=true"></button></div>`);
  const expected = await pixels(page, images.original);
  const intended = { channelUrl: 'https://max.ru/channel', scheduledAt: '2030-01-01T12:00:00.000Z', sha256: 'local-file-hash' };
  const result = { channelUrl: intended.channelUrl, posts: [{ scheduledAt: intended.scheduledAt, imageUrls: [images.candidate], hasText: false }] };

  return { page, confirm: () => confirmMaxPost(page, result, intended, expected) };
}

test('area RGB confirms resized and reencoded photo with versioned metrics', async () => {
  const f = await fixture('same');
  try {
    const evidence = JSON.parse(await f.confirm());
    assert.equal(evidence.method, 'scheduled-image-area-rgb-v1', 'Resized photo must use visual correspondence evidence');
    assert.equal(evidence.metrics.algorithm, 'area-rgb-32-v1', 'Evidence must identify the comparison algorithm');
    assert.ok(evidence.metrics.mae <= 2 && evidence.metrics.rmse <= 3, 'Reencoded photo must satisfy all conservative limits');
  } finally { await f.page.close(); }
});

for (const variant of ['flip', 'crop', 'overlay', 'brightness', 'low-information']) {
  test(`area RGB rejects ${variant} instead of confirming uncertain identity`, async () => {
    const f = await fixture(variant);
    try { await assert.rejects(f.confirm(), /не соответствует/, 'A changed or uninformative photo must remain unconfirmed'); }
    finally { await f.page.close(); }
  });
}
