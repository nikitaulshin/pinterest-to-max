import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { maxConfiguration } from '../src/cli.ts';
import { IntegrationFailure } from '../src/integrations/failure.ts';
import { readScheduledPosts } from '../src/integrations/max/scheduled.ts';

const target = 'https://max.ru/channel_du';
const directory = mkdtempSync(join(tmpdir(), 'max-read-test-'));
let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true, ...(maxConfiguration({ ...process.env, MAX_CHANNEL_URL: target }).channel === 'chrome' ? { channel: 'chrome' } : {}) }); });
after(async () => { await browser?.close(); rmSync(directory, { recursive: true, force: true }); });

const image = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const slot = (index: number, time: string, date = '') => `<div class="item" data-index="${index}" style="height:180px">
  ${date ? `<div class="dateSeparator"><span class="date">${date}</span></div>` : ''}
  <div role="listitem"><div aria-label="Прикрепленные фото"><img loading="lazy" src="${image}"></div><div role="button">${time}</div></div></div>`;

async function fixture(options: { slots?: string; empty?: boolean; identity?: string; script?: string; bottom?: boolean; timezone?: string } = {}) {
  const context = await browser.newContext({ timezoneId: options.timezone ?? 'Europe/Moscow', viewport: { width: 800, height: 400 } });
  const page = await context.newPage();
  await page.route('https://web.max.ru/**', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
    <button aria-label="Открыть профиль Маркетинг" onclick="document.querySelector('.layout').hidden=false">Profile</button>
    <div class="layout absolute"><button aria-label="Перейти назад" onclick="this.parentElement.hidden=true">Back</button>
      <button><span data-type="action-small">Ссылка</span><span data-type="description"><span data-type="body">${options.identity ?? target}</span></span></button></div>
    <div data-testid="composer"><div contenteditable="true"></div><button aria-label="Загрузить файл"></button></div>
    ${options.empty ? '' : `<button aria-label="Открыть отложенные сообщения" onclick="document.querySelector('.delayedChat').hidden=false"></button>
      <div class="delayedChat" hidden><div class="headerTitle">Запланированные посты</div>
      <div class="scrollListScrollable" style="height:150px;overflow:auto"><div class="scrollListContent ${options.bottom === false ? '' : 'scrollListContent--bottom'}">
      ${options.slots ?? slot(0, '15:00', '12 ноября 2026') + slot(1, '15:05') + slot(2, '15:10')}
      </div></div></div>`}
    <script>${options.script ?? ''}</script>` }));
  await page.goto('https://web.max.ru/-123');

  return { page, close: () => context.close() };
}

test('reads all offscreen scheduled posts with Moscow dates and preserves repeated images', async () => {
  const f = await fixture();
  try {
    const result = await readScheduledPosts(f.page, target, directory);
    assert.deepEqual(result.posts.map((post) => post.scheduledAt), ['2026-11-12T12:00:00.000Z', '2026-11-12T12:05:00.000Z', '2026-11-12T12:10:00.000Z'], 'All offscreen posts must have explicit Moscow conversion');
    assert.equal(result.posts[2]?.imageUrls[0], image, 'Repeated images must remain separate posts');
  } finally { await f.close(); }
});

test('empty channel requires matching loaded profile and composer across reload', async () => {
  const f = await fixture({ empty: true });
  try {
    let reloads = 0;
    f.page.on('domcontentloaded', () => { reloads++; });
    assert.deepEqual((await readScheduledPosts(f.page, target, directory)).posts, [], 'Verified empty channel must be readable');
    assert.equal(reloads, 1, 'Missing scheduled controls must be checked after reload');
  } finally { await f.close(); }
});

test('waits for delayed profile identity and upload after reload', async () => {
  const f = await fixture({ empty: true, script: `if(sessionStorage.loaded){
    const profile=document.querySelector('.layout');profile.hidden=true;
    const link=profile.querySelector('span[data-type="action-small"]').parentElement;link.hidden=true;
    const upload=document.querySelector('[aria-label="Загрузить файл"]');upload.disabled=true;
    document.querySelector('[aria-label="Открыть профиль Маркетинг"]').onclick=()=>{
      profile.hidden=false;setTimeout(()=>{link.hidden=false;upload.disabled=false},400);
    };
  }sessionStorage.loaded='1'` });
  try {
    assert.deepEqual((await readScheduledPosts(f.page, target, directory)).posts, [], 'A visible profile button must not imply loaded identity and author controls');
  } finally { await f.close(); }
});

for (const scenario of [
  { name: 'wrong channel', identity: 'https://max.ru/other' },
  { name: 'wrong browser timezone', timezone: 'UTC' },
  { name: 'unknown date', slots: slot(0, '15:00', '12 ноября') },
  { name: 'invalid calendar day', slots: slot(0, '15:00', '31 февраля 2026') },
  { name: 'unknown time', slots: slot(0, '25:00', '12 ноября 2026') },
  { name: 'position gap', slots: slot(0, '15:00', '12 ноября 2026') + slot(2, '15:10') },
  { name: 'virtualized initial window', slots: slot(1, '15:00', '12 ноября 2026') },
  { name: 'empty content without explicit empty state', slots: '' },
  { name: 'unconfirmed bottom', bottom: false },
  { name: 'loading state', script: 'document.querySelector(".scrollListContent").setAttribute("aria-busy","true")' },
  { name: 'virtualization during scroll', script: 'document.querySelector(".scrollListScrollable").addEventListener("scroll",()=>{document.querySelector(".item").remove()},{once:true})' },
  { name: 'new item during scroll', script: `document.querySelector('.scrollListScrollable').addEventListener('scroll',()=>{document.querySelector('.scrollListContent').insertAdjacentHTML('beforeend',${JSON.stringify(slot(3, '16:00'))})},{once:true})` },
  { name: 'changed post during scroll', script: `document.querySelector('.scrollListScrollable').addEventListener('scroll',()=>{document.querySelector('[role="listitem"] [role="button"]').textContent='16:00'},{once:true})` },
  { name: 'unloaded photo', slots: slot(0, '15:00', '12 ноября 2026').replace(image, 'data:image/gif;base64,broken') },
  { name: 'more than documented cap', slots: Array.from({ length: 101 }, (_, index) => slot(index, '15:00', index === 0 ? '12 ноября 2026' : '')).join('') },
  { name: 'missing composer cannot prove empty', empty: true, script: 'document.querySelector("[data-testid=composer]").remove()' },
]) {
  test(`refuses ${scenario.name}`, async () => {
    const f = await fixture(scenario);
    try {
      await assert.rejects(readScheduledPosts(f.page, target, directory), /чтение отложки остановлено/, 'Unconfirmed data must never become a successful snapshot');
    } finally { await f.close(); }
  });
}

test('waits for lazy photo revealed by scrolling', async () => {
  const f = await fixture({ script: `const img=document.querySelectorAll('img')[2];img.removeAttribute('src');
    document.querySelector('.scrollListScrollable').addEventListener('scroll',()=>{img.src=${JSON.stringify(image)}})` });
  try {
    assert.equal((await readScheduledPosts(f.page, target, directory)).posts.length, 3, 'Lazy offscreen media must be checked after scrolling');
  } finally { await f.close(); }
});

test('explicit empty history confirms empty after opening scheduled panel', async () => {
  const f = await fixture({ script: `document.querySelector('.scrollListScrollable').remove();document.querySelector('.delayedChat').insertAdjacentHTML('beforeend','<div class="emptyHistory">Нет запланированных постов</div>')` });
  try {
    assert.deepEqual((await readScheduledPosts(f.page, target, directory)).posts, [], 'Explicit empty history must confirm an empty list');
  } finally { await f.close(); }
});

test('reads populated controls that finish loading before the initial snapshot', async () => {
  const content = `<button aria-label="Открыть отложенные сообщения" onclick="document.querySelector('.delayedChat').hidden=false"></button>
    <div class="delayedChat" hidden><div class="headerTitle">Запланированные посты</div>
    <div class="scrollListScrollable" style="height:150px;overflow:auto"><div class="scrollListContent scrollListContent--bottom">${slot(0, '15:00', '12 ноября 2026')}</div></div></div>`;
  const f = await fixture({ empty: true, script: `setTimeout(()=>document.body.insertAdjacentHTML('beforeend',${JSON.stringify(content)}),400)` });
  try {
    assert.deepEqual((await readScheduledPosts(f.page, target, directory)).posts.map(post => post.scheduledAt), ['2026-11-12T12:00:00.000Z'], 'Controls appearing before a snapshot must enter the full populated-list read');
  } finally { await f.close(); }
});

test('new scheduled controls after reload invalidate empty snapshot', async () => {
  const f = await fixture({ empty: true, script: `if(sessionStorage.loaded){document.querySelector('[data-testid="composer"]').insertAdjacentHTML('afterend','<button aria-label="Открыть отложенные сообщения"></button>')}sessionStorage.loaded='1'` });
  try {
    await assert.rejects(readScheduledPosts(f.page, target, directory), /чтение отложки остановлено/, 'Reload changes must invalidate an empty snapshot');
  } finally { await f.close(); }
});

test('a post changed between passes invalidates the snapshot', async () => {
  const f = await fixture({ script: `const scroll=document.querySelector('.scrollListScrollable');let bottom=false;
    scroll.addEventListener('scroll',()=>{if(bottom&&scroll.scrollTop===0){document.querySelector('[role="listitem"] [role="button"]').textContent='17:00'}if(scroll.scrollTop+scroll.clientHeight>=scroll.scrollHeight-2)bottom=true})` });
  try {
    await assert.rejects(readScheduledPosts(f.page, target, directory), /чтение отложки остановлено/, 'Both complete passes must agree');
  } finally { await f.close(); }
});

test('date changes preserve Moscow midnight across the UTC date boundary', async () => {
  const f = await fixture({ slots: slot(0, '23:59', '31 декабря 2026') + slot(1, '00:01', '1 января 2027') });
  try {
    assert.deepEqual((await readScheduledPosts(f.page, target, directory)).posts.map((post) => post.scheduledAt), ['2026-12-31T20:59:00.000Z', '2026-12-31T21:01:00.000Z'], 'Each explicit date header must be converted independently');
  } finally { await f.close(); }
});

test('observed Today header uses the Moscow calendar date', async () => {
  const f = await fixture({ slots: slot(0, '00:01', 'Сегодня') });
  try {
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
    const expected = new Date(`${today}T00:01:00+03:00`).toISOString();
    assert.equal((await readScheduledPosts(f.page, target, directory)).posts[0]?.scheduledAt, expected, 'Today must refer to the Moscow date captured for the read');
  } finally { await f.close(); }
});

test('slow lazy photo is awaited within a bounded load timeout', async () => {
  const f = await fixture({ script: `const img=document.querySelectorAll('img')[2];img.removeAttribute('src');
    document.querySelector('.scrollListScrollable').addEventListener('scroll',()=>{setTimeout(()=>{img.src=${JSON.stringify(image)}},700)},{once:true})` });
  try {
    assert.equal((await readScheduledPosts(f.page, target, directory)).posts.length, 3, 'Slow image loading must not be mistaken for missing media');
  } finally { await f.close(); }
});


test('reads observed Tomorrow heading as the next Moscow calendar date', async () => {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
  const tomorrow = new Date(`${today}T00:00:00.000Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const expected = new Date(tomorrow.getTime() + 12 * 3_600_000).toISOString();
  const f = await fixture({ slots: slot(0, '15:00', 'Завтра') + slot(1, '15:05') });
  try {
    const posts = (await readScheduledPosts(f.page, target, directory)).posts;
    assert.equal(posts[0]!.scheduledAt, expected, 'Tomorrow must resolve from the verified Moscow reading day');
    assert.equal(Date.parse(posts[1]!.scheduledAt) - Date.parse(expected), 300_000, 'Following posts must inherit the resolved Tomorrow date');
  } finally { await f.close(); }
});

for (const scenario of [
  { name: 'expired login', code: 'auth-required', script: `document.body.insertAdjacentHTML('beforeend', '<button>Войти по номеру телефона</button>')` },
  { name: 'known CAPTCHA iframe', code: 'captcha', script: `document.body.insertAdjacentHTML('beforeend', '<iframe src="about:blank?captcha"></iframe>')` },
  { name: 'unknown structure', code: 'structure-changed', script: `document.querySelector('[data-testid=composer]').remove()` },
]) test(`classifies ${scenario.name} and preserves private diagnostics`, async () => {
  const f = await fixture(scenario);
  try {
    await assert.rejects(readScheduledPosts(f.page, target, directory), error => {
      assert.ok(error instanceof IntegrationFailure, 'Reader must preserve a typed integration failure');
      assert.equal(error.code, scenario.code, 'Access and structural failures must have separate codes');
      assert.ok(error.diagnostics?.startsWith(directory), 'Reader must retain its private diagnostic directory');
      return true;
    });
  } finally { await f.close(); }
});
