import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { PublicationSchedule } from '../../src/core/planning.ts';

// Подменяет только браузерную сеть отдельного CLI, сохраняя реальные DOM и контекст.
const launch = chromium.launchPersistentContext.bind(chromium);
chromium.launchPersistentContext = async (directory, options) => {
  if (process.env.PLAN_SCENARIO === 'forbid') throw new Error('Browser must not launch');
  if (!String(directory).endsWith('/profiles/max') || !options?.headless || options.timezoneId !== 'Europe/Moscow') {
    throw new Error('Dry-run must use its headless Moscow MAX profile');
  }
  const context = await launch(directory, options);
  const audit = (event: string) => appendFileSync(join(process.env.DATA_DIR!, 'browser-audit'), `${event}\n`);
  context.on('close', () => audit('closed'));
  const next = new PublicationSchedule(['09:00', '15:00', '21:00']).futureSlots(new Date()).next().value!;
  const date = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric' }).format(next).replace(/ г\.$/, '');
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }).format(next);
  await context.exposeBinding('forbiddenSend', () => { audit('send'); throw new Error('Dry-run must never send or upload'); });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (process.env.PLAN_SCENARIO === 'signal') {
      process.stderr.write('fixture-browser-opening\n');
      await new Promise(() => {});
      return;
    }
    if (url.hostname === 'max.ru') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<a href="https://web.max.ru/channel_du">Открыть в браузере</a>' });
    if (url.pathname === '/channel_du') return route.fulfill({ contentType: 'text/html', body: '<script>location.replace("/-123")</script>' });
    if (process.env.PLAN_SCENARIO === 'expired') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<button>Войти по номеру телефона</button>' });
    const empty = process.env.PLAN_SCENARIO === 'empty';
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
      <button aria-label="Открыть профиль Канал" onclick="document.querySelector('.layout').hidden=false">Профиль</button>
      <div class="layout absolute"><button aria-label="Перейти назад" onclick="this.parentElement.hidden=true">Назад</button>
      <button><span data-type="action-small">Ссылка</span><span data-type="description"><span data-type="body">https://max.ru/${process.env.PLAN_SCENARIO === 'wrong-ui' ? 'other' : 'channel_du'}</span></span></button></div>
      <div data-testid="composer"><div contenteditable="true"></div><button aria-label="Загрузить файл" onclick="forbiddenSend()"></button></div>
      <button aria-label="Отправить" onclick="forbiddenSend()"></button>
      ${empty ? '' : `<button aria-label="Открыть отложенные сообщения" onclick="document.querySelector('.delayedChat').hidden=false"></button>
      <div class="delayedChat" hidden><div class="headerTitle">Запланированные посты</div>
      <div class="scrollListScrollable" style="height:150px;overflow:auto"><div class="scrollListContent scrollListContent--bottom">
      <div class="item" data-index="${process.env.PLAN_SCENARIO === 'incomplete' ? '1' : '0'}"><div class="dateSeparator"><span class="date">${date}</span></div><div role="listitem"><div role="button">${time}</div></div></div>
      </div></div></div>`}` });
  });

  return context;
};
