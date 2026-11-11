import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, type Browser } from 'playwright';
import { ImportStorage, listQueue } from '../src/storage.ts';
import { acquireStorageOwnership } from '../src/storage-ownership.ts';
import { reconcileMaxPost } from '../src/integrations/max/reconcile.ts';
import { IntegrationFailure, integrationFailure } from '../src/integrations/failure.ts';
import { submitMaxPost } from '../src/integrations/max/submit.ts';

const target = 'https://max.ru/channel_du';
const scheduledAt = '2030-01-12T12:00:00.000Z';
let browser: Browser;
let png: Buffer;
const photo = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><path fill="red" d="M0 0h2v2H0z"/></svg>')}`;
before(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.MAX_BROWSER_CHANNEL === 'chrome' ? { channel: 'chrome' } : {}) });
  const page = await browser.newPage();
  png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
    const context = canvas.getContext('2d')!; context.fillStyle = 'red'; context.fillRect(0, 0, 2, 2);
    return canvas.toDataURL().split(',')[1]!;
  }), 'base64');
  await page.close();
});
after(async () => { await browser?.close(); });

type Scenario = 'past' | 'incomplete' | 'read-error' | 'unnamed-calendar' | 'delayed-preview' | 'success' | 'absent' | 'duplicate' | 'different' | 'missing' | 'text' | 'slot-changed' | 'draft-text' | 'bad-file' | 'unreadable' | 'viewer' | 'taint' | 'lower-cap' | 'today' | 'tomorrow' | 'browser-close' | 'disabled-time';
async function fixture(scenario: Scenario, uncertain = false) {
  const today = new Date(Math.floor((Date.now() + 600_000) / 60_000) * 60_000);
  const intended = scenario === 'past' ? '2020-01-12T12:00:00.000Z' : scenario === 'today' ? today.toISOString() : scenario === 'tomorrow' ? new Date(today.getTime() + 86_400_000).toISOString() : scheduledAt;
  const moscow = new Date(Date.parse(intended) + 3 * 3_600_000);
  const calendarMonths = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  const dateMonths = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const time = `${String(moscow.getUTCHours()).padStart(2, '0')}:${String(moscow.getUTCMinutes()).padStart(2, '0')}`;
  const directory = mkdtempSync(join(tmpdir(), 'max-submit-'));
  const release = acquireStorageOwnership(directory);
  const storage = new ImportStorage(directory, 'https://ru.pinterest.com/board/');
  storage.bindChannel(target);
  const sha256 = createHash('sha256').update(png).digest('hex');
  const path = join(directory, `${sha256}.png`);
  writeFileSync(path, png);
  storage.sources([{ id: '1', url: 'https://ru.pinterest.com/pin/1/' }]);
  storage.image({ status: 'ready', id: '1', imageUrl: 'https://i.pinimg.com/image.png', path, sha256, mime: 'image/png', bytes: png.length, width: 2, height: 2 });
  if (scenario === 'bad-file') writeFileSync(path, 'corrupt');
  const context = await browser.newContext({ timezoneId: 'Europe/Moscow' });
  let sends = 0;
  let creates = uncertain ? scenario === 'absent' ? 0 : scenario === 'duplicate' ? 2 : 1 : 0;
  if (uncertain) {
    storage.prepareMax(1, target, intended);
    const attempt = storage.beginMaxAttempt(1, target, sha256, intended);
    storage.finishMax(1, 'uncertain', 'Unknown external outcome', attempt);
  }
  let initialLoads = 0;
  let durable = false;
  await context.route('https://unreadable.example/**', (route) => route.fulfill({ contentType: 'image/png', headers: { 'access-control-allow-origin': 'https://other.example' }, body: png }));
  await context.route('https://web.max.ru/**', async (route) => {
    if (route.request().url().endsWith('/send')) {
      sends++;
      const state = listQueue(directory);
      durable = state.items[0]!.status === 'submitting' && state.maxAttempts.length === 1 && state.maxAttempts[0]!.status === 'submitting';
      if (scenario === 'browser-close') { await route.abort(); await route.request().frame().page().close(); return; }
      creates = scenario === 'absent' ? 0 : scenario === 'duplicate' ? 2 : 1;
      await route.fulfill({ contentType: 'text/plain', body: 'ok' });
      return;
    }
    initialLoads++;
    const count = scenario === 'lower-cap' ? 1 : scenario === 'slot-changed' && initialLoads >= 3 ? 1 : creates;
    const image = scenario === 'different' || scenario === 'viewer' ? photo.replace('red', 'blue') : scenario === 'taint' ? 'https://unreadable.example/photo.png' : photo;
    const slots = Array.from({ length: count }, (_, index) => `<div class="item" data-index="${scenario === 'incomplete' ? index + 1 : index}"><div class="dateSeparator"><span class="date">${moscow.getUTCDate()} ${dateMonths[moscow.getUTCMonth()]} ${moscow.getUTCFullYear()}</span></div>
      <div role="listitem">${scenario === 'text' ? '<span>Unexpected caption</span>' : ''}${scenario === 'missing' ? '' : `<div aria-label="Прикрепленные фото"><img src="${image}" onclick="document.querySelector('#viewer').hidden=false"></div>`}<div role="button">${scenario === 'lower-cap' ? '16:00' : time}</div></div></div>`).join('');
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
      <button aria-label="Открыть профиль Маркетинг" onclick="document.querySelector('.layout').hidden=false">Profile</button>
      <div class="layout absolute" hidden><button aria-label="Перейти назад" onclick="this.parentElement.hidden=true">Back</button>
      <button><span data-type="action-small">Ссылка</span><span data-type="description"><span data-type="body">${target}</span></span></button></div>
      <div data-testid="composer"><div contenteditable="true">${scenario === 'draft-text' ? 'Unsent text' : ''}</div>
      <button aria-label="Загрузить файл" onclick="document.querySelector('#upload').hidden=false"></button>
      <button aria-label="Отправить сообщение" oncontextmenu="event.preventDefault();document.querySelector('#plan').hidden=false"></button></div>
      <div id="upload" role="menu" hidden><button role="menuitem" onclick="document.querySelector('input').click()">Фото или видео</button></div>
      <input type="file" hidden onchange="const reader=new FileReader();reader.onload=()=>{document.querySelector('[data-testid=composer]').insertAdjacentHTML('beforeend','<div role=&quot;list&quot; aria-label=&quot;Вложения сообщения&quot; style=&quot;min-height:40px&quot;></div>');setTimeout(()=>document.querySelector('[role=list]').insertAdjacentHTML('beforeend','<div role=&quot;listitem&quot;><img src=&quot;'+reader.result+'&quot;></div>'),${scenario === 'delayed-preview' ? 400 : 0});};reader.readAsDataURL(this.files[0]);document.querySelector('#upload').hidden=true">
      <button id="plan" role="menuitem" hidden onclick="this.hidden=true;document.querySelector('[role=dialog]').hidden=false">Запланировать пост</button>
      <div role="dialog" ${scenario === 'unnamed-calendar' ? '' : 'aria-label="Запланировать пост"'} hidden><div><span>Запланировать пост</span></div><span>${calendarMonths[moscow.getUTCMonth()]}${moscow.getUTCFullYear()}</span><button>${moscow.getUTCDate()}</button>
      <div role="spinbutton" aria-label="Часы" contenteditable="true" aria-valuenow="15" oninput="this.setAttribute('aria-valuenow',this.textContent)">15</div>
      <div role="spinbutton" aria-label="Минуты" contenteditable="true" aria-valuenow="0" oninput="this.setAttribute('aria-valuenow',this.textContent)">0</div>
      <button ${scenario === 'disabled-time' ? 'disabled' : ''} onclick="fetch('/send').then(()=>{this.parentElement.hidden=true;const pending=document.createElement('div');pending.className='delayedChat';pending.innerHTML='<div role=listitem>Pending</div>';document.body.append(pending)})">Отправить ${scenario === 'today' ? 'сегодня' : scenario === 'tomorrow' ? 'завтра' : '12 янв.'} в ${time}</button></div>
      ${count ? `<button aria-label="Открыть отложенные сообщения" onclick="document.querySelector('.delayedChat').hidden=false"></button>
      <div class="delayedChat" hidden><div class="headerTitle">Запланированные посты</div><button aria-label="Перейти назад" onclick="this.parentElement.hidden=true"></button>
      <div class="scrollListScrollable" style="height:150px;overflow:auto"><div class="scrollListContent scrollListContent--bottom">${slots}</div></div></div>` : ''}
      <img alt="Unrelated avatar" src="${photo}"><div id="viewer" hidden><button aria-label="Скачать"></button><img src="${scenario === 'viewer' ? photo : image}"><button aria-label="Закрыть" onclick="this.parentElement.hidden=true"></button></div>
      ${scenario === 'unreadable' ? '<div aria-busy="true"></div>' : ''}` });
  });
  const page = await context.newPage();
  await page.goto('https://web.max.ru/-123');
  return { directory, storage, page, path, sha256, sends: () => sends, durable: () => durable,
    submit: (signal?: AbortSignal) => submitMaxPost({ storage, page, ...(signal ? { signal } : {}), jobId: 1, channelUrl: target, scheduledAt: intended, effectiveLimit: scenario === 'lower-cap' ? 1 : 100, diagnosticsDirectory: join(directory, 'diagnostics') }),
    reconcile: () => reconcileMaxPost({ storage, page, jobId: 1, channelUrl: target, diagnosticsDirectory: join(directory, 'diagnostics') }),
    state: () => listQueue(directory),
    close: async () => { await context.close(); storage.close(); release(); rmSync(directory, { recursive: true, force: true }); } };
}

test('single operation confirms decoded equal pixels across encodings without external post ID', async () => {
  const f = await fixture('success');
  try {
    assert.equal((await f.submit()).status, 'scheduled', 'Matching pixels must confirm one scheduled post');
    const state = f.state();
    assert.equal(f.sends(), 1, 'Create must be clicked exactly once');
    assert.ok(f.durable(), 'Submitting and attempt must commit before the create action');
    assert.equal(state.items[0]!.max_post_url, null, 'External ID must remain optional');
    assert.equal(JSON.parse(String(state.maxAttempts[0]!.evidence)).method, 'scheduled-image-decoded-rgba', 'Confirmation must record decoded pixel evidence');
    assert.deepEqual(readFileSync(f.path), png, 'Successful submission must preserve source bytes');
    await assert.rejects(f.submit(), /не готово/, 'Scheduled job without external ID must not repeat');
    assert.equal(f.sends(), 1, 'Rejected repeat must never click Send');
  } finally { await f.close(); }
});

test('waits for image inside a visible attachment list before validating preview', async () => {
  const f = await fixture('delayed-preview');
  try {
    assert.equal((await f.submit()).status, 'scheduled', 'An attachment container must not imply its image is already rendered');
    assert.equal(f.sends(), 1, 'Delayed preview must still create exactly one post');
  } finally { await f.close(); }
});

test('recognizes the calendar by its visible heading when native dialog has no accessible name', async () => {
  const f = await fixture('unnamed-calendar');
  try {
    assert.equal((await f.submit()).status, 'scheduled', 'Observed calendar heading must identify the unnamed dialog');
    assert.equal(f.sends(), 1, 'Calendar recognition must preserve a single Send');
  } finally { await f.close(); }
});

test('observed viewer can confirm original when scheduled thumbnail differs', async () => {
  const f = await fixture('viewer');
  try {
    assert.equal((await f.submit()).status, 'scheduled', 'Full viewer image must be checked after thumbnail mismatch');
    assert.equal(JSON.parse(String(f.state().maxAttempts[0]!.evidence)).method, 'viewer-image-decoded-rgba', 'Viewer evidence must identify the checked source');
  } finally { await f.close(); }
});

for (const scenario of ['absent', 'duplicate', 'different', 'missing', 'text', 'taint', 'browser-close'] as const) {
  test(`${scenario} after Send remains uncertain and cannot be retried`, async () => {
    const f = await fixture(scenario);
    try {
      assert.equal((await f.submit()).status, 'uncertain', 'Unconfirmed result must remain uncertain');
      assert.equal(f.sends(), 1, 'Uncertain outcome must never repeat creation');
      assert.equal(f.state().maxAttempts[0]!.status, 'uncertain', 'Attempt must preserve unknown outcome');
      assert.throws(() => f.storage.changeQueue(1, 'retry'), /сверки/, 'Uncertain job without post URL must reject retry');
      await assert.rejects(f.submit(), /не готово/, 'Internal operation must also reject uncertain jobs');
      assert.deepEqual(readFileSync(f.path), png, 'Unknown outcome must retain local image');
    } finally { await f.close(); }
  });
}

for (const scenario of ['bad-file', 'draft-text', 'unreadable', 'disabled-time'] as const) {
  test(`${scenario} before creation preserves a definite safe failure`, async () => {
    const f = await fixture(scenario);
    try {
      assert.equal((await f.submit()).status, 'failed', 'Pre-create rejection must be a definite failure');
      assert.equal(f.sends(), 0, 'Rejected preparation must not create posts');
      assert.equal(f.state().maxAttempts.length, 0, 'Rejected preparation must not claim an external attempt');
      assert.ok(f.state().items[0]!.error, 'Definite failure must preserve a concrete reason');
      assert.ok(readFileSync(f.path).length, 'Pre-create rejection must retain the existing file');
      f.storage.changeQueue(1, 'retry');
      assert.equal(f.state().items[0]!.status, 'ready', 'Definite failure must allow explicit retry');
    } finally { await f.close(); }
  });
}

test('a manually occupied slot at the final check returns the job to ready', async () => {
  const f = await fixture('slot-changed');
  try {
    assert.equal((await f.submit()).status, 'ready', 'Changed occupancy must leave the job available for another slot');
    assert.equal(f.sends(), 0, 'Final collision must prevent creation');
    assert.equal(f.state().maxAttempts.length, 0, 'No external attempt may be committed after the collision');
  } finally { await f.close(); }
});


test('same-day scheduling uses the observed Today confirmation label', async () => {
  const f = await fixture('today');
  try {
    assert.equal((await f.submit()).status, 'scheduled', 'Today label must allow a future same-day post');
    assert.equal(f.sends(), 1, 'Today submission must send exactly once');
  } finally { await f.close(); }
});

test('effective cap below MAX global cap blocks an additional post', async () => {
  const f = await fixture('lower-cap');
  try {
    assert.equal((await f.submit()).status, 'ready', 'Configured cap must be respected before sending');
    assert.equal(f.sends(), 0, 'Effective cap must prevent an extra post');
  } finally { await f.close(); }
});


for (const limit of [0, 101, 1.5, Number.NaN]) {
  test(`invalid effective cap ${limit} is rejected before job mutation`, async () => {
    const f = await fixture('success');
    try {
      const before = f.state();
      await assert.rejects(submitMaxPost({ storage: f.storage, page: f.page, jobId: 1, channelUrl: target, scheduledAt, effectiveLimit: limit, diagnosticsDirectory: join(f.directory, 'diagnostics') }), /лимит/, 'Invalid limit must fail before changing state');
      assert.deepEqual(f.state(), before, 'Rejected configuration must preserve queue and history');
      assert.equal(f.sends(), 0, 'Rejected configuration must not create posts');
    } finally { await f.close(); }
  });
}


test('reconciliation confirms one existing post without Send or external ID and preserves history', async () => {
  const f = await fixture('success', true);
  try {
    const before = f.state();
    assert.equal((await f.reconcile()).status, 'scheduled', 'Existing matching post must confirm uncertainty');
    const after = f.state();
    assert.equal(f.sends(), 0, 'Reconciliation must never create a post');
    assert.equal(after.items[0]!.max_post_url, null, 'External post ID must remain optional');
    assert.equal(after.maxAttempts.length, 1, 'Reconciliation must preserve the original attempt');
    assert.equal(after.maxAttempts[0]!.id, before.maxAttempts[0]!.id, 'Evidence must bind the original attempt');
    assert.equal(after.maxAttempts[0]!.status, 'scheduled', 'Original attempt must become confirmed');
    assert.equal(after.queueEvents.length, before.queueEvents.length + 1, 'Confirmation must append one history event');
    assert.equal(JSON.parse(String(after.queueEvents.at(-1)!.previous_state)).status, 'uncertain', 'History must retain the uncertain state');
    assert.deepEqual(readFileSync(f.path), png, 'Confirmation must preserve the image bytes');
    assert.throws(() => f.storage.changeQueue(1, 'retry'), /повтор|сверки/, 'Confirmed job without URL must reject retry');
    await assert.rejects(f.reconcile(), /неопределённой/, 'Confirmed job must never be reconsidered from an empty queue');
    assert.equal(f.sends(), 0, 'Repeated reconciliation must not create posts');
  } finally { await f.close(); }
});

for (const scenario of ['absent', 'duplicate', 'different', 'missing', 'text', 'taint', 'unreadable', 'past', 'incomplete', 'read-error'] as const) {
  test(`reconciliation ${scenario} preserves uncertainty without creation`, async () => {
    const f = await fixture(scenario, true);
    try {
      const before = f.state();
      if (scenario === 'read-error') await f.page.close();
      assert.equal((await f.reconcile()).status, 'uncertain', 'Missing proof must preserve uncertainty');
      const after = f.state();
      assert.deepEqual(after.items, before.items, 'Unconfirmed reconciliation must preserve the original job');
      assert.deepEqual(after.maxAttempts, before.maxAttempts, 'Unconfirmed reconciliation must retain attempt history');
      assert.deepEqual(after.queueEvents, before.queueEvents, 'Missing proof must not create a misleading transition');
      assert.equal(f.sends(), 0, 'Reconciliation must never click Send');
      assert.deepEqual(readFileSync(f.path), png, 'Uncertainty must preserve source bytes');
      assert.throws(() => f.storage.changeQueue(1, 'retry'), /сверки/, 'Uncertainty must reject retry');
    } finally { await f.close(); }
  });
}

test('reconciliation cannot confirm with an unrelated attempt and rolls back its history event', async () => {
  const f = await fixture('success', true);
  try {
    const before = f.state();
    assert.throws(() => f.storage.finishMax(1, 'scheduled', null, 'unrelated-attempt', '{}'), /не найдена/, 'An unrelated attempt must never confirm the job');
    assert.deepEqual(f.state(), before, 'Rejected confirmation must atomically roll back history and state');
    assert.equal(f.sends(), 0, 'Rejected confirmation must not create a post');
  } finally { await f.close(); }
});


test('scheduled completion without evidence preserves submitting state and history', async () => {
  const f = await fixture('success');
  try {
    f.storage.prepareMax(1, target, scheduledAt);
    const attempt = f.storage.beginMaxAttempt(1, target, f.sha256, scheduledAt);
    const before = f.state();
    assert.throws(() => f.storage.finishMax(1, 'scheduled', null, attempt), /доказательств/, 'Scheduled completion must require confirmation evidence');
    assert.deepEqual(f.state(), before, 'Missing proof must preserve submitting state, attempt and history');
    assert.equal(f.sends(), 0, 'Rejected completion must not create a post');
  } finally { await f.close(); }
});


test('next-day scheduling uses the observed Tomorrow confirmation label', async () => {
  const f = await fixture('tomorrow');
  try {
    assert.equal((await f.submit()).status, 'scheduled', 'Observed tomorrow label must allow next-day scheduling');
    assert.equal(f.sends(), 1, 'Tomorrow submission must send exactly once');
  } finally { await f.close(); }
});

test('proven network failure before intent defers and resumes the same safe job', async t => {
  const f = await fixture('success');
  try {
    t.mock.method(f.page, 'reload', async () => { throw new Error('net::ERR_CONNECTION_RESET https://cdn.test/a?token=secret'); });
    const result = await f.submit();
    assert.equal(result.status, 'failed', 'A proven failure before intent must be definite');
    assert.equal(result.failure?.code, 'network', 'Safe failures must preserve the transport code');
    assert.equal(f.sends(), 0, 'Pre-create network failure must not send');
    assert.equal(f.state().maxAttempts.length, 0, 'Pre-create failure must not leave external intent');
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    f.storage.deferMaxNetworkRetry(1, 20);
    now += 5000;
    f.storage.resumeMaxNetworkRetries();
    assert.equal(f.state().items[0]!.status, 'ready', 'The due retry must resume the existing job');
    assert.equal(f.state().items.length, 1, 'Deferral must not duplicate jobs');
  } finally { await f.close(); }
});

test('network failure after intent remains uncertain and never becomes a normal retry', async t => {
  const f = await fixture('success');
  try {
    const reload = f.page.reload.bind(f.page);
    t.mock.method(f.page, 'reload', async (...args: Parameters<typeof reload>) => {
      if (f.sends()) throw new Error('net::ERR_CONNECTION_RESET https://cdn.test/a?token=secret');
      return await reload(...args);
    });
    const result = await f.submit();
    assert.equal(result.status, 'uncertain', 'Any network error after intent must preserve uncertainty');
    assert.equal(result.failure, undefined, 'A per-job uncertain transport outcome must not pause every other job');
    assert.equal(f.sends(), 1, 'Only one Send may occur');
    assert.throws(() => f.storage.deferMaxNetworkRetry(1, 20), /до намерения/, 'Uncertain jobs must never enter the network retry queue');
    assert.throws(() => f.storage.changeQueue(1, 'retry'), /сверки/, 'CLI retry must preserve uncertainty');
    await assert.rejects(f.submit(), /не готово/, 'The external attempt must block a second create');
    assert.equal(f.sends(), 1, 'Rejected retries must not send again');
  } finally { await f.close(); }
});


test('abort before durable intent returns the same job to ready without Send', async t => {
  const f = await fixture('success');
  const controller = new AbortController();
  const prepare = f.storage.prepareMax.bind(f.storage);
  t.mock.method(f.storage, 'prepareMax', (...args: Parameters<typeof prepare>) => {
    const image = prepare(...args);
    controller.abort();
    return image;
  });
  try {
    assert.equal((await f.submit(controller.signal)).status, 'ready', 'Abort before intent must remain safely repeatable');
    assert.equal(f.state().maxAttempts.length, 0, 'Abort before intent must not create an attempt');
    assert.match(String(f.state().items[0]!.error), /подготовка прервана.*пересчёту/, 'Abort reason must not falsely blame the local file');
    assert.equal(f.sends(), 0, 'Abort must prevent external creation');
  } finally { await f.close(); }
});

test('abort after durable intent persists uncertainty before browser diagnostics', async t => {
  const f = await fixture('success');
  const controller = new AbortController();
  const begin = f.storage.beginMaxAttempt.bind(f.storage);
  t.mock.method(f.storage, 'beginMaxAttempt', (...args: Parameters<typeof begin>) => {
    const attempt = begin(...args);
    controller.abort();
    void f.page.close();
    return attempt;
  });
  t.mock.method(f.page, 'screenshot', async () => {
    assert.equal(f.state().items[0]!.status, 'uncertain', 'Outcome must commit before optional diagnostics');
    throw new Error('Controlled closed browser');
  });
  try {
    assert.equal((await f.submit(controller.signal)).status, 'uncertain', 'Abort after intent must require reconciliation');
    assert.equal(f.state().maxAttempts[0]!.status, 'uncertain', 'Attempt and job must agree after abort');
    assert.match(String(f.state().items[0]!.error), /отправка прервана.*сверка/, 'Interrupted creation must retain its reconciliation reason');
  } finally { await f.close(); }
});

for (const draft of ['own', 'foreign', 'unnamed', 'multiple', 'different-pixels', 'text'] as const) {
  test(`preexisting ${draft} photo draft is reused only with unambiguous ownership and image proof`, async () => {
    const f = await fixture('success');
    try {
      let uploads = 0; f.page.on('filechooser', () => { uploads++; });
      await f.page.addInitScript(({ draft, filename, source }) => {
        document.addEventListener('DOMContentLoaded', () => {
        const composer = document.querySelector('[data-testid="composer"]')!;
        const list = document.createElement('div');
        list.setAttribute('role', 'list'); list.setAttribute('aria-label', 'Вложения сообщения');
        const item = document.createElement('div'); item.setAttribute('role', 'listitem');
        const name = draft === 'foreign' ? 'foreign.png' : filename;
        if (draft !== 'unnamed') item.setAttribute('aria-label', name);
        const image = document.createElement('img'); image.alt = name;
        image.src = draft === 'different-pixels' ? source.replace('red', 'blue') : source;
        item.append(image); list.append(item);
        if (draft === 'multiple') list.append(item.cloneNode(true));
        composer.append(list);
        if (draft === 'text') composer.querySelector('[contenteditable]')!.textContent = 'Unsent foreign text';
        });
      }, { draft, filename: basename(f.path), source: photo });
      await f.page.reload();
      assert.equal((await f.submit()).status, draft === 'own' ? 'scheduled' : 'failed', 'Only a positively identified own draft may be reused');
      assert.equal(f.sends(), draft === 'own' ? 1 : 0, 'Unknown draft must never trigger Send');
      assert.equal(uploads, 0, 'Persisted drafts must never be replaced with a fresh upload');
      if (draft !== 'own') {
        assert.equal(await f.page.getByRole('list', { name: 'Вложения сообщения', exact: true }).count(), 1, 'Rejected draft must remain untouched');
        assert.equal(f.state().maxAttempts.length, 0, 'Rejected draft must not create external intent');
      }
    } finally { await f.close(); }
  });
}


test('corrupted local bytes are rejected before the MAX upload chooser opens', async () => {
  const f = await fixture('bad-file');
  let uploads = 0;
  f.page.on('filechooser', () => { uploads++; });
  try {
    assert.equal((await f.submit()).status, 'failed', 'Corrupt bytes must fail before preparing external content');
    assert.equal(uploads, 0, 'Corrupt bytes must never reach the upload chooser');
    assert.equal(f.sends(), 0, 'Corrupt bytes must never trigger Send');
    assert.equal(f.state().maxAttempts.length, 0, 'Corrupt bytes must never create a send intent');
    assert.equal(readFileSync(f.path, 'utf8'), 'corrupt', 'Failed validation must preserve the file for investigation');
  } finally { await f.close(); }
});


test('failed outcome persistence pauses the integration while preserving the original browser cause', async (t) => {
  const f = await fixture('success');
  const cause = new Error('net::ERR_CONNECTION_RESET https://cdn.test/a?token=secret');
  const events: Record<string, unknown>[] = [];
  t.mock.method(console, 'error', (line: string) => events.push(JSON.parse(line)));
  t.mock.method(f.page, 'reload', async () => { throw cause; });
  t.mock.method(f.storage, 'finishMax', () => { throw new Error('Controlled database write failure'); });
  try {
    await assert.rejects(f.submit(), (error: unknown) => {
      assert.ok(error instanceof IntegrationFailure, 'Persistence failures must use a safe typed error');
      assert.equal(integrationFailure(error).code, 'unknown', 'Failed persistence must pause rather than schedule a network retry');
      let original: unknown = error;
      while (original instanceof Error && original.cause) original = original.cause;
      assert.equal(original, cause, 'The original browser cause must survive the persistence failure');
      assert.match(error.message, /не удалось сохранить исход/, 'The operator must be told to repair persistent state');
      return true;
    });
    assert.equal(events.find((event) => event.operation === 'submit')?.code, 'network', 'Diagnostics must retain the original browser classification');
    assert.equal(f.state().items[0]!.status, 'preparing', 'Failed writes must not falsely claim a saved terminal outcome');
    assert.equal(f.sends(), 0, 'Persistence failures must not trigger Send');
    await assert.rejects(f.submit(), /не готово/, 'Unresolved preparation must block a repeated Send');
    assert.equal(f.sends(), 0, 'A repeated invocation must still perform no Send');
  } finally { await f.close(); }
});


test('failed reconciliation proof persistence pauses writes and preserves the unresolved attempt atomically', async (t) => {
  const f = await fixture('success', true);
  const cause = new Error('Controlled reconciliation database write failure');
  t.mock.method(f.storage, 'finishMax', () => { throw cause; });
  try {
    await assert.rejects(f.reconcile(), (error: unknown) => {
      assert.ok(error instanceof IntegrationFailure, 'Proof persistence failures must expose a safe typed failure');
      assert.equal(integrationFailure(error).code, 'unknown', 'Failed proof persistence must pause the integration');
      assert.equal(error.cause, cause, 'The original database failure must remain available in memory');
      assert.match(error.message, /не удалось сохранить подтверждение/, 'Failed proof persistence must explain the required recovery');
      return true;
    });
    assert.equal(f.state().items[0]!.status, 'uncertain', 'Failed proof persistence must not falsely confirm the job');
    assert.equal(f.state().maxAttempts[0]!.status, 'uncertain', 'Failed proof persistence must preserve the unresolved attempt');
    assert.equal(f.state().maxAttempts[0]!.evidence, null, 'Failed proof persistence must not claim a saved proof');
    assert.equal(f.sends(), 0, 'Reconciliation must never trigger Send');
  } finally { await f.close(); }
});
