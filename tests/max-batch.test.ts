import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { PublicationPlanner, PublicationSchedule } from '../src/core/planning.ts';
import { scheduleMaxBatch } from '../src/integrations/max/batch.ts';
import { ImportStorage, listQueue } from '../src/storage.ts';
import { acquireStorageOwnership } from '../src/storage-ownership.ts';

const target = 'https://max.ru/channel_du';
let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function fixture(scenario: 'missing-file' | 'normal' | 'collision' | 'race' | 'failed' | 'unknown' | 'reservation' | 'two-uncertain' | 'empty' | 'expired', limit = 3, advanceClock?: (now: number) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'max-batch-'));
  const release = acquireStorageOwnership(directory);
  const storage = new ImportStorage(directory, 'https://ru.pinterest.com/board/');
  storage.bindChannel(target);
  const context = await browser.newContext({ timezoneId: 'Europe/Moscow' });
  const page = await context.newPage();
  const day = new Date(Date.now() + 86400000 + 3 * 3600000);
  const date = `${day.getUTCDate()} ${['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'][day.getUTCMonth()]} ${day.getUTCFullYear()}`;
  const month = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'][day.getUTCMonth()];
  const urls: string[] = [];
  for (let id = 1; id <= (scenario === 'empty' ? 0 : 3); id++) {
    const url = await page.evaluate((id) => {
      const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
      const c = canvas.getContext('2d')!; c.fillStyle = ['red', 'blue', 'green'][id - 1]!; c.fillRect(0, 0, 2, 2);
      return canvas.toDataURL();
    }, id);
    urls.push(url);
    const bytes = Buffer.from(url.split(',')[1]!, 'base64');
    const path = join(directory, `${id}.png`);
    writeFileSync(path, bytes);
    storage.sources([{ id: String(id), url: `https://ru.pinterest.com/pin/${id}/` }]);
    storage.image({ status: 'ready', id: String(id), imageUrl: 'https://i.pinimg.com/photo.png', path, sha256: createHash('sha256').update(bytes).digest('hex'), mime: 'image/png', bytes: bytes.length, width: 2, height: 2 });
  }
  const utc = (hour: number) => new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour - 3)).toISOString();
  for (let id = 1; id <= (scenario === 'two-uncertain' ? 2 : scenario === 'reservation' ? 1 : 0); id++) {
    const image = storage.prepareMax(id, target, utc(9 + id));
    const attempt = storage.beginMaxAttempt(id, target, image.sha256, utc(9 + id));
    storage.finishMax(id, 'uncertain', 'Unknown outcome', attempt);
  }
  if (scenario === 'missing-file') rmSync(join(directory, '1.png'));
  if (scenario === 'failed') writeFileSync(join(directory, '1.png'), 'corrupt');
  const posts: { hour: number; image: string; text?: string }[] = [];
  let sends = 0;
  let checks = 0;
  let expiredReady = false;
  await context.route('https://web.max.ru/**', async (route) => {
    const request = route.request();
    if (request.url().includes('/send?')) {
      sends++;
      const params = new URL(request.url()).searchParams;
      posts.push({ hour: Number(params.get('hour')), image: params.get('image')! });
      if (scenario === 'race') posts.push({ hour: 22, image: urls[2]!, text: 'Manual post' });
      await route.fulfill({ body: 'ok' }); return;
    }
    // Только отдельная финальная verification-страница видит ручную гонку до Send.
    if (scenario === 'collision' && route.request().frame().page() !== page && ++checks === 2) posts.push({ hour: 10, image: urls[2]!, text: 'Manual post' });
    if (scenario === 'expired') {
      if (route.request().frame().page() !== page && ++checks === 2) advanceClock!(Date.parse(utc(10)));
      if (route.request().frame().page() === page && checks >= 2 && sends === 0) {
        const state = listQueue(directory);
        expiredReady = state.items[0]!.status === 'ready' && state.maxAttempts.length === 0;
      }
    }
    const slots = posts.map((post, index) => `<div class="item" data-index="${index}"><div class="dateSeparator"><span class="date">${date}</span></div><div role="listitem">${post.text ?? ''}<div aria-label="Прикрепленные фото"><img src="${post.image}"></div><div role="button">${post.hour}:00</div></div></div>`).join('');
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
      <button aria-label="Открыть профиль Channel" onclick="document.querySelector('.layout').hidden=false"></button>
      <div class="layout absolute" hidden><button aria-label="Перейти назад" onclick="this.parentElement.hidden=true"></button><button><span data-type="action-small">Ссылка</span><span data-type="description"><span data-type="body">${target}</span></span></button></div>
      <div data-testid="composer"><div contenteditable="true"></div><button aria-label="Загрузить файл" onclick="document.querySelector('#upload').hidden=false"></button><button aria-label="Отправить сообщение" oncontextmenu="event.preventDefault();document.querySelector('#plan').hidden=false"></button></div>
      <div id="upload" hidden><button role="menuitem" onclick="document.querySelector('input').click()">Фото или видео</button></div>
      <input type="file" hidden onchange="const reader=new FileReader();reader.onload=()=>{window.photo=reader.result;document.querySelector('[data-testid=composer]').insertAdjacentHTML('beforeend','<div role=list aria-label=&quot;Вложения сообщения&quot;><div role=listitem><img src=&quot;'+reader.result+'&quot;></div></div>')};reader.readAsDataURL(this.files[0])">
      <button id="plan" role="menuitem" hidden onclick="this.hidden=true;document.querySelector('[role=dialog]').hidden=false">Запланировать пост</button>
      <div role="dialog" hidden><span>Запланировать пост</span><span>${month}${day.getUTCFullYear()}</span><button>${day.getUTCDate()}</button>
      <div role="spinbutton" aria-label="Часы" contenteditable="true" aria-valuenow="10" oninput="this.setAttribute('aria-valuenow',this.textContent);update()">10</div><div role="spinbutton" aria-label="Минуты" contenteditable="true" aria-valuenow="0" oninput="this.setAttribute('aria-valuenow',this.textContent);update()">0</div>
      <button id="send" onclick="fetch('/send?hour='+document.querySelector('[aria-label=Часы]').textContent+'&image='+encodeURIComponent(window.photo)).then(()=>{this.parentElement.hidden=true;const pending=document.createElement('div');pending.className='delayedChat';pending.innerHTML='<div role=listitem>Pending</div>';document.body.append(pending)})"></button></div>
      ${posts.length ? `<button aria-label="Открыть отложенные сообщения" onclick="document.querySelector('.delayedChat').hidden=false"></button><div class="delayedChat" hidden><div class="headerTitle">Запланированные посты</div><button aria-label="Перейти назад" onclick="this.parentElement.hidden=true"></button><div class="scrollListScrollable" style="height:300px;overflow:auto"><div class="scrollListContent scrollListContent--bottom">${slots}</div></div></div>` : ''}
      <script>function update(){document.querySelector('#send').textContent='Отправить завтра в '+document.querySelector('[aria-label=Часы]').textContent.padStart(2,'0')+':00'}update()</script>
      ${scenario === 'unknown' && sends ? '<div aria-busy="true"></div>' : ''}` });
  });
  await page.goto('https://web.max.ru/-123');
  // Первый слот завтра: сегодняшний календарь уже исключён минимальным набором дат.
  const planner = new PublicationPlanner(new PublicationSchedule(['10:00', '11:00', '12:00'], 2), limit);
  // Управляем только моментом планирования, используя настоящий планировщик и будущий календарь.
  const actualPlan = planner.plan.bind(planner);
  planner.plan = (options) => actualPlan({ ...options, now: new Date(Math.max(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 6), scenario === 'expired' ? Date.now() : 0)) });
  return { directory, posts, expiresAt: Date.parse(utc(10)), expiredReady: () => expiredReady, sends: () => sends, state: () => listQueue(directory),
    run: () => scheduleMaxBatch({ storage, page, dataDirectory: directory, channelUrl: target, diagnosticsDirectory: join(directory, 'diagnostics'), planner }),
    close: async () => { await context.close(); storage.close(); release(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const scenario of ['missing-file', 'normal', 'collision', 'race', 'failed', 'unknown', 'reservation', 'two-uncertain', 'empty'] as const) {
  test(`bounded batch: ${scenario}`, async () => {
    const f = await fixture(scenario, scenario === 'reservation' ? 2 : ['failed', 'missing-file'].includes(scenario) ? 1 : 3);
    try {
      const result = await f.run();
      if (scenario === 'normal') {
        assert.equal(f.sends(), 3, 'Batch must create up to initial capacity');
        assert.deepEqual(f.state().items.map((job) => job.status), ['scheduled', 'scheduled', 'scheduled'], 'FIFO jobs must be confirmed sequentially');
        assert.deepEqual(f.posts.map((post) => post.hour), [10, 11, 12], 'Fresh reads must select distinct available slots');
      } else if (scenario === 'collision') {
        assert.equal(f.posts[0]!.text, 'Manual post', 'Manual post must be preserved');
        assert.equal(f.sends(), 2, 'Final occupancy must reduce live capacity');
        assert.deepEqual(f.posts.map((post) => post.hour), [10, 11, 12], 'Occupied slot must be skipped during replan');
      } else if (scenario === 'race') {
        assert.equal(f.sends(), 1, 'Change after final check must stop further writes');
        assert.equal(result.stopped, 'schedule-changed-after-check', 'Stop must explain the external race');
        assert.ok(readdirSync(join(f.directory, 'diagnostics')).some((entry) => readdirSync(join(f.directory, 'diagnostics', entry)).includes('race.json')), 'External race must preserve diagnostics');
      } else if (scenario === 'failed' || scenario === 'missing-file') {
        assert.deepEqual(f.state().items.map((job) => job.status), ['failed', 'scheduled', 'ready'], 'Failed FIFO item must not consume the single available capacity');
      } else if (scenario === 'unknown') {
        assert.equal(f.sends(), 1, 'Unknown outcome must stop new writes');
        assert.equal(f.state().items[0]!.status, 'uncertain', 'Unknown job must retain its original assignment');
      } else if (scenario === 'two-uncertain') {
        assert.equal(result.reconciled.length, 2, 'Each uncertainty must be reconciled on an isolated page');
        assert.equal(f.sends(), 1, 'Two unresolved reservations must leave one available capacity');
        assert.deepEqual(f.state().items.map((job) => job.status), ['uncertain', 'uncertain', 'scheduled'], 'Reconciliation must not block the remaining ready job');
        assert.equal(f.posts[0]!.hour, 12, 'Both uncertain minutes must remain reserved');
      } else if (scenario === 'reservation') {
        assert.equal(result.reconciled[0]!.status, 'uncertain', 'Unmatched uncertainty must be reconciled first');
        assert.equal(f.sends(), 1, 'Unresolved reservation must reduce effective final-send limit');
        assert.equal(f.posts[0]!.hour, 11, 'Uncertain slot must remain occupied');
      } else {
        assert.equal(f.sends(), 0, 'Empty queue must not create a synthetic job or send');
        assert.equal(f.state().items.length, 0, 'Empty queue must stay empty');
      }
    } finally { await f.close(); }
  });
}


test('expired final-check slot returns to ready and replans without sending the expired assignment', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = await fixture('expired', 1, (value) => { now = value; });
  now = f.expiresAt - 1000;
  try {
    await f.run();
    assert.ok(f.expiredReady(), 'Batch must observe safe ready state before replanning');
    assert.equal(f.sends(), 1, 'Only the replacement future slot may cross Send');
    assert.deepEqual(f.posts.map((post) => post.hour), [11], 'Expired ten oclock slot must be replaced with eleven oclock');
    assert.deepEqual(f.state().items.map((job) => job.status), ['scheduled', 'ready', 'ready'], 'Replanning must preserve FIFO and initial capacity');
  } finally { await f.close(); }
});
