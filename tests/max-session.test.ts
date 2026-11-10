import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { maxConfiguration } from '../src/cli.ts';
import { readChannelAccess } from '../src/integrations/max/session.ts';

const target = 'https://max.ru/channel_du';

for (const scenario of [
  { name: 'matching profile and enabled author controls confirm access', identity: target, controls: true, expected: 'ready' },
  { name: 'another profile cannot confirm configured channel', identity: 'https://max.ru/other', controls: true, expected: 'mismatch' },
  { name: 'matching profile without publication controls cannot confirm rights', identity: target, controls: false, expected: 'unknown' },
  { name: 'disabled author controls cannot confirm rights', identity: target, controls: true, disabled: true, expected: 'unknown' },
  { name: 'expired session overrides matching profile', identity: target, controls: true, login: true, expected: 'auth-required' },
]) {
  test(scenario.name, async () => {
    const browser = await chromium.launch({ headless: true, ...(maxConfiguration({ ...process.env, MAX_CHANNEL_URL: target }).channel === 'chrome' ? { channel: 'chrome' } : {}) });
    try {
      const page = await browser.newPage();
      await page.route('https://web.max.ru/**', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
        <button aria-label="Открыть профиль Маркетинг">Маркетинг</button>
        <button><span data-type="action-small">Ссылка</span><span data-type="description"><span data-type="body">${scenario.identity}</span></span></button>
        ${scenario.controls ? `<button aria-label="Загрузить файл" ${scenario.disabled ? 'disabled' : ''}></button><button aria-label="Открыть отложенные сообщения"></button>` : ''}
        ${scenario.login ? '<button>Войти по номеру телефона</button>' : ''}
      ` }));
      await page.goto('https://web.max.ru/-123');
      assert.equal(await readChannelAccess(page, target), scenario.expected, 'Access must require matching profile, session and author controls');
    } finally { await browser.close(); }
  });
}
