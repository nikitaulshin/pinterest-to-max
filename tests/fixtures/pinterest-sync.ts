import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';

// Подготавливает результат будущего обработчика без добавления команд управления очередью.
if (process.env.QUEUE_FIXTURE_STATUS) {
  const database = new DatabaseSync(join(process.env.DATA_DIR!, 'state.sqlite'));
  database.prepare(`UPDATE queue SET status = ?, scheduled_at = ?, next_attempt_at = ?, error = ?, max_post_url = ?`)
    .run(process.env.QUEUE_FIXTURE_STATUS, '2026-11-07T12:00:00.000Z', '2026-11-07T11:00:00.000Z', 'Preserved diagnostic', 'https://web.max.ru/preserved-post');
  database.close();
}

// Воспроизводит определённый отказ до внешней отправки либо занятый шаг обработчика.
if (process.env.QUEUE_FIXTURE_SAFE_STATUS) {
  const database = new DatabaseSync(join(process.env.DATA_DIR!, 'state.sqlite'));
  database.prepare(`UPDATE queue SET status = ?, scheduled_at = ?, next_attempt_at = ?, error = ?, max_post_url = NULL`)
    .run(process.env.QUEUE_FIXTURE_SAFE_STATUS, '2026-11-07T12:00:00.000Z', '2099-11-07T11:00:00.000Z', 'Recoverable diagnostic');
  database.close();
}

// Воспроизводит сохранённое хранилище предыдущего этапа с его очередью и ошибками.
if (process.env.QUEUE_FIXTURE_VERSION === '1') {
  const database = new DatabaseSync(join(process.env.DATA_DIR!, 'state.sqlite'));
  database.exec(`BEGIN IMMEDIATE;
    ALTER TABLE pins DROP COLUMN classification;
    DROP TABLE bootstrap_runs;
    DROP TABLE backfill_runs;
    DROP TABLE queue_events;
    DROP TABLE max_attempts;
    UPDATE board_state SET initialized = 0, last_full_sync_at = NULL;
    PRAGMA user_version = 1;
    COMMIT;`);
  database.close();
}

// Авария после реального rename проверяет границу файла и транзакции через публичный CLI.
if (process.env.SYNC_SCENARIO === 'crash-after-file' || process.env.BACKFILL_CRASH === 'file') {
  const rename = fs.rename;
  fs.rename = async (...args) => {
    await rename(...args);
    process.kill(process.pid, 'SIGKILL');
  };
  syncBuiltinESMExports();
}

// Авария после commit, но до диагностического итога не должна повторно расходовать лимит.
if (process.env.BACKFILL_CRASH === 'commit' || process.env.BACKFILL_CRASH === 'limit') {
  let results = 0;
  const appendFile = fs.appendFile;
  fs.appendFile = async (...args) => {
    if (String(args[0]).endsWith('results.jsonl') && ++results === (process.env.BACKFILL_CRASH === 'limit' ? 2 : 1)) process.kill(process.pid, 'SIGKILL');
    await appendFile(...args);
  };
  syncBuiltinESMExports();
}

// Подмена браузерной границы действует только в отдельном CLI-процессе теста.
const launch = chromium.launchPersistentContext.bind(chromium);
chromium.launchPersistentContext = async (directory, options) => {
  const context = await launch(directory, options);
  const page = context.pages()[0] ?? await context.newPage();
  const scenario = process.env.SYNC_SCENARIO;
  if (scenario === 'download-failure' || scenario === 'unsupported') {
    const screenshot = page.screenshot.bind(page);
    page.screenshot = async (options) => {
      console.log(JSON.stringify({ event: 'fixture-error-screenshot', url: page.url() }));
      return await screenshot(options);
    };
  }
  const signature = 'c6c5d3974290d1bff2e2f72626f49add';
  const image = `https://i.pinimg.com/originals/c6/c5/d3/${signature}.png`;
  const png = Buffer.from(await page.evaluate((changed) => {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 2;
    const drawing = canvas.getContext('2d')!;
    drawing.fillStyle = changed ? 'red' : 'black';
    drawing.fillRect(0, 0, 8, 2);

    return canvas.toDataURL().split(',')[1]!;
  }, scenario === 'changed-image'), 'base64');
  const distinct = scenario?.startsWith('backfill');
  const images = new Map<string, Buffer>();
  const imageFor = (id: string) => distinct ? image.replace(signature, `${signature.slice(0, -3)}${id}`) : image;
  if (distinct) {
    for (const id of ['100', '101', '102', '103', '104']) {
      const bytes = Buffer.from(await page.evaluate((id) => {
        const canvas = document.createElement('canvas');
        canvas.width = 8;
        canvas.height = 2;
        const drawing = canvas.getContext('2d')!;
        drawing.fillStyle = `rgb(${Number(id)}, 0, 0)`;
        drawing.fillRect(0, 0, 8, 2);

        return canvas.toDataURL().split(',')[1]!;
      }, scenario === 'backfill-mixed' && id === '102' ? '100' : id), 'base64');
      images.set(imageFor(id), bytes);
    }
  }
  let downloads = 0;
  context.request.get = (async (url: string) => {
    if (scenario === 'known-no-download' || process.argv.includes('bootstrap')) throw new Error('Known pins must not download again');
    const status = scenario === 'download-failure' && ++downloads === 2 ? 503 : 200;

    const bytes = images.get(String(url)) ?? png;

    return {
      status: () => status, url: () => String(url), headers: () => ({ 'content-type': 'image/png', 'content-length': String(bytes.length) }),
      body: async () => bytes, dispose: async () => {},
    };
  }) as unknown as typeof context.request.get;
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('https://i.pinimg.com/')) return route.fulfill({ contentType: 'image/png', body: images.get(url) ?? png });
    if (/\/pin\//.test(url)) {
      const id = /\/pin\/(\d+)/.exec(url)![1];
      if (scenario === 'interrupted' && id === '101') return await new Promise<never>(() => {});
      if ((scenario === 'captcha' || scenario === 'auth' || scenario === 'structure') && id === '101') {
        return route.fulfill({ contentType: 'text/html', body: '<meta charset="utf-8">' + (scenario === 'captcha' ? '<body>verify you are human</body>' : scenario === 'auth' ? '<button>Войти</button>' : '<body>Changed</body>') });
      }
      if (scenario === 'story' && id === '101') {
        return route.fulfill({ contentType: 'text/html', body: `<div data-test-id="closeup-body-image-container"><div data-test-id="story-pin-page-drag-surface" data-pin-drag-id="${id}"><div data-test-id="story-pin-image-block"><img src="${imageFor(String(id))}"></div></div></div>` });
      }
      return route.fulfill({ contentType: 'text/html', body: `<div data-test-id="closeup-image" data-pin-drag-id="${id}"><div data-test-id="closeup-image-main"><img src="${imageFor(String(id))}"></div></div>` });
    }
    const firstId = scenario === 'history' ? 900 : scenario === 'new-pins' ? 200 : 100;
    const card = (id: number) => `<div data-test-id="pin" data-test-pin-id="${id}" data-pin-drag-id="${id}" data-test-pin-slot-index="${id - firstId}"><div data-test-id="pinWrapper"><a href="/pin/${id}/">Pin</a></div>${(scenario === 'unsupported' || scenario === 'backfill-mixed') && id === 101 ? '' : `<div data-test-image-signature="${distinct ? `${signature.slice(0, -3)}${id}` : signature}"><div data-test-id="non-story-pin-image"><img src="${imageFor(String(id))}"></div></div>`}</div>`;
    const cards = card(firstId) + card(firstId + 1) + card(firstId + 2) + (scenario === 'backfill-mixed' ? card(firstId + 3) + card(firstId + 4) : '');
    const update = ['partial', 'bootstrap-crash', 'backfill-partial'].includes(scenario ?? '') ? `<script>addEventListener('scroll',()=>document.querySelector('[data-test-id="pin-count"]').textContent='4 пина');</script>` : '';
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><button data-test-id="header-accounts-options-button" aria-label="Аккаунты">Account</button>
      <div data-test-id="board-header"><h1>Board</h1><div data-test-id="board-count-info"><span data-test-id="pin-count">${scenario === 'backfill-mixed' ? '5 пинов' : '3 пина'}</span></div></div>
      <div data-test-id="board-feed"><div data-test-id="base-board-pin-grid"><div data-test-id="masonry-container" aria-busy="false">${cards}</div>${['partial', 'bootstrap-crash', 'backfill-partial'].includes(scenario ?? '') ? '' : '<div data-test-id="more-ideas-feed"></div>'}</div></div><div style="height:10000px"></div>${update}` });
  });

  return context;
};
