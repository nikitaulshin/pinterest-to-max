import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { pinterestConfiguration } from '../src/cli.ts';
import { traverseBoard } from '../src/integrations/pinterest/board.ts';

let browser: Browser;
before(async () => { browser = await chromium.launch(pinterestConfiguration(process.env).channel === 'chrome' ? { channel: 'chrome' } : {}); });
after(async () => { await browser?.close(); });

const url = 'https://ru.pinterest.com/example/board/';
const card = (slot: number, id = String(100 + slot)) => `<div data-test-id="pin" data-test-pin-id="${id}" data-pin-drag-id="${id}" data-test-pin-slot-index="${slot}"><div data-test-id="pinWrapper"><a href="/pin/${id}/">Pin</a></div></div>`;
const ideas = `<div data-test-id="more-ideas-feed"><div data-test-id="masonry-container">${card(0, '999')}</div></div>`;

async function fixture(total: number, cards: string, tail: string, update = '') {
  const page = await browser.newPage();
  await page.route(url, (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
    <button data-test-id="header-accounts-options-button" aria-label="Аккаунты">Account</button>
    <div data-test-id="board-header"><h1>Board</h1><div data-test-id="board-count-info"><span data-test-id="pin-count">${total}&nbsp;пинов</span></div></div>
    <div data-test-id="board-feed"><div data-test-id="base-board-pin-grid"><div><div data-test-id="masonry-container" aria-busy="false">${cards}</div></div>${tail}</div></div>
    <div style="height:10000px"></div><script>${update}</script>` }));

  return page;
}

// Браузерные fixtures проверяют наблюдённую границу DOM без обращения к Pinterest.
test('full traversal keeps the first known pin and reads virtualized pins beyond the first screen', async () => {
  const page = await fixture(3, card(0), '', `let step=0;addEventListener('scroll',()=>{const grid=document.querySelector('[aria-busy]');if(step===0){grid.innerHTML=${JSON.stringify(card(1))};step++;}else if(step===1){grid.innerHTML=${JSON.stringify(card(2))};grid.parentElement.insertAdjacentHTML('afterend',${JSON.stringify(ideas)});step++;}});`);
  try {
    const result = await traverseBoard(page, url, { timeoutMs: 3000, pollMs: 20 });
    assert.equal(result.status, 'complete', 'Virtualized traversal must reach the confirmed end');
    assert.deepEqual(result.pins.map((pin) => pin.id), ['100', '101', '102'], 'Known first pin must not stop full traversal');
    assert.equal(await page.locator('[data-test-pin-id="100"]').count(), 0, 'First DOM node must have been removed');
  } finally { await page.close(); }
});

test('repeated cards are deduplicated in board slot order', async () => {
  const page = await fixture(3, card(2) + card(0) + card(1) + card(1), ideas);
  try {
    const result = await traverseBoard(page, url);
    assert.equal(result.status, 'complete', 'Repeated cards must not prevent confirmed completion');
    assert.deepEqual(result.pins.map((pin) => pin.id), ['100', '101', '102'], 'Order must follow board slots rather than DOM order');
  } finally { await page.close(); }
});

test('recommendations and advertising outside the primary masonry are excluded', async () => {
  const page = await fixture(1, card(0) + ideas, `<div>${card(0, '888')}</div>`);
  try {
    const result = await traverseBoard(page, url);
    assert.equal(result.status, 'complete', 'Primary board must complete independently of recommendations');
    assert.deepEqual(result.pins.map((pin) => pin.id), ['100'], 'Only confirmed primary-grid cards may be imported');
  } finally { await page.close(); }
});

test('identical screens and an end recommendation do not replace missing board pins', async () => {
  const page = await fixture(2, card(0), ideas);
  try {
    const result = await traverseBoard(page, url, { timeoutMs: 250, pollMs: 20 });
    assert.equal(result.status, 'partial', 'Missing slot must prevent completion');
    assert.equal(result.reason, 'timeout', 'Loading must have a bounded deadline');
    assert.deepEqual(result.pins.map((pin) => pin.id), ['100'], 'Partial traversal must retain observed pins');
  } finally { await page.close(); }
});

test('a count change during traversal preserves pins and reports partial', async () => {
  const page = await fixture(2, card(0), '', `addEventListener('scroll',()=>{document.querySelector('[data-test-id="pin-count"]').textContent='1 пин';});`);
  try {
    const result = await traverseBoard(page, url, { timeoutMs: 2000, pollMs: 20 });
    assert.equal(result.status, 'partial', 'Changing board count must prevent completion');
    assert.equal(result.reason, 'count-changed', 'Count change must be explicit');
    assert.equal(result.pins.length, 1, 'Count change must retain earlier pins');
  } finally { await page.close(); }
});

test('busy board does not complete even with every pin and the end block', async () => {
  const page = await fixture(1, card(0), ideas, `document.querySelector('[aria-busy]').setAttribute('aria-busy','true');`);
  try {
    const result = await traverseBoard(page, url, { timeoutMs: 250, pollMs: 20 });
    assert.equal(result.status, 'partial', 'Busy grid must not be treated as complete');
    assert.equal(result.pins.length, 1, 'Busy grid must retain observed pins');
  } finally { await page.close(); }
});

test('conflicting slot identity stops traversal without losing previous pins', async () => {
  const page = await fixture(2, card(0), '', `addEventListener('scroll',()=>{document.querySelector('[aria-busy]').innerHTML=${JSON.stringify(card(0, '999'))};});`);
  try {
    const result = await traverseBoard(page, url, { timeoutMs: 2000, pollMs: 20 });
    assert.equal(result.status, 'partial', 'Conflicting membership must prevent completion');
    assert.equal(result.reason, 'membership-changed', 'Conflicting slot must be explicit');
    assert.deepEqual(result.pins.map((pin) => pin.id), ['100'], 'Earlier identity must be retained');
  } finally { await page.close(); }
});

test('complete count alone does not prove the end of the board', async () => {
  const page = await fixture(1, card(0), '');
  try {
    const result = await traverseBoard(page, url, { timeoutMs: 250, pollMs: 20 });
    assert.equal(result.status, 'partial', 'Count without an observed end must not complete');
    assert.equal(result.pins.length, 1, 'Observed pin must remain available');
  } finally { await page.close(); }
});

test('lost authentication stops traversal while retaining observed pins', async () => {
  const page = await fixture(2, card(0), '', `addEventListener('scroll',()=>{const button=document.createElement('button');button.textContent='Войти';document.body.append(button);});`);
  try {
    const result = await traverseBoard(page, url, { timeoutMs: 2000, pollMs: 20 });
    assert.equal(result.status, 'partial', 'Lost authentication must stop traversal');
    assert.equal(result.reason, 'auth-required', 'Authentication failure must be explicit');
    assert.deepEqual(result.pins.map((pin) => pin.id), ['100'], 'Authentication failure must retain earlier pins');
  } finally { await page.close(); }
});


test('traversal retains observed originals while unsupported cards remain independent sources', async () => {
  const signature = 'c6c5d3974290d1bff2e2f72626f49add';
  const original = `https://i.pinimg.com/originals/c6/c5/d3/${signature}.jpg`;
  const small = `https://i.pinimg.com/236x/c6/c5/d3/${signature}.jpg`;
  const withImage = card(0).replace('</a>', `</a><div data-test-image-signature="${signature}"><div data-test-id="non-story-pin-image"><img src="${small}" srcset="${original} 2x"></div></div>`);
  const page = await fixture(2, withImage + card(1), ideas);
  try {
    const result = await traverseBoard(page, url);
    assert.equal(result.status, 'complete', 'Unsupported material must not interrupt identity traversal');
    assert.deepEqual(result.pins[0]?.imageUrls, [small, original], 'Observed card originals must survive DOM virtualization');
    assert.match(result.pins[1]?.imageError ?? '', /неподдерживаемый/, 'Unsupported material must retain an explicit error');
    assert.equal(result.pins[1]?.id, '101', 'Unsupported source must remain available for diagnostics');
  } finally { await page.close(); }
});
