import { chromium } from 'playwright';

// Ограничивает реальный браузер наблюдённой landing/profile разметкой для отдельного CLI.
const launch = chromium.launchPersistentContext.bind(chromium);
chromium.launchPersistentContext = async (directory, options) => {
  if (process.env.MAX_SCENARIO === 'forbid') throw new Error('Browser must not launch for mismatched binding');
  if (!String(directory).endsWith('/profiles/max')) throw new Error('MAX must use its own profile');

  const context = await launch(directory, { ...options, headless: true });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'max.ru') return route.fulfill({ contentType: 'text/html', body: '<meta charset="utf-8"><a href="https://web.max.ru/channel_du">Открыть в браузере</a>' });
    if (url.pathname === '/channel_du') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<script>location.replace("/-123")</script>' });
    if (process.env.MAX_SCENARIO === 'expired') return route.fulfill({ contentType: 'text/html', body: '<meta charset="utf-8"><button>Войти по номеру телефона</button>' });

    return route.fulfill({ contentType: 'text/html', body: `<meta charset="utf-8">
      <button aria-label="Открыть профиль Маркетинг" onclick="document.querySelector('#profile').hidden=false">Маркетинг</button>
      <div id="profile" hidden><button><span data-type="action-small">Ссылка</span><span data-type="description"><span data-type="body">https://max.ru/${process.env.MAX_SCENARIO === 'mismatch' ? 'other' : 'channel_du'}</span></span></button></div>
      <button aria-label="Загрузить файл"></button><button aria-label="Открыть отложенные сообщения"></button>
    ` });
  });

  return context;
};
