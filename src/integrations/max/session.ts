import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { chromium, type Page } from 'playwright';

/** Проверяет видимый профиль канала и доступные действия без чтения сообщений и полей. */
export async function readChannelAccess(page: Page, channelUrl: string): Promise<'auth-required' | 'ready' | 'mismatch' | 'unknown'> {
  if (await page.getByRole('button', { name: 'Войти по номеру телефона', exact: true }).isVisible()) return 'auth-required';

  const location = new URL(page.url());
  if (location.origin !== 'https://web.max.ru' || !/^\/-\d+$/.test(location.pathname)) return 'unknown';

  const profile = page.getByRole('button', { name: /^Открыть профиль / });
  if (await profile.count() !== 1 || !await profile.isVisible()) return 'unknown';

  const link = page.getByRole('button').filter({ has: page.locator('span[data-type="action-small"]').filter({ hasText: /^Ссылка$/ }) });
  if (await link.count() !== 1 || !await link.isVisible()) return 'unknown';

  const identity = link.locator('span[data-type="description"] > span[data-type="body"]');
  if (await identity.count() !== 1) return 'unknown';
  if ((await identity.innerText()).trim() !== channelUrl) return 'mismatch';

  const upload = page.getByRole('button', { name: 'Загрузить файл', exact: true });
  const scheduled = page.getByRole('button', { name: 'Открыть отложенные сообщения', exact: true });
  if (await upload.count() !== 1 || !await upload.isVisible() || !await upload.isEnabled()
    || await scheduled.count() !== 1 || !await scheduled.isVisible() || !await scheduled.isEnabled()) return 'unknown';

  return page.url() === location.href ? 'ready' : 'unknown';
}

/** Сохраняет только отдельную сессию MAX; канал проверяется до возврата успеха. */
export async function authenticateMax(configuration: { dataDirectory: string; channelUrl: string; channel: string }): Promise<boolean> {
  const profile = join(configuration.dataDirectory, 'profiles/max');
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    ...(configuration.channel === 'chrome' ? { channel: 'chrome' } : {}),
  }).catch(() => { throw new Error('MAX: не удалось открыть браузер. Проверьте установку выбранного браузера и владельца профиля.'); });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(configuration.channelUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const browser = page.getByRole('link', { name: 'Открыть в браузере', exact: true });
    await browser.waitFor({ state: 'visible', timeout: 30_000 });
    if (await browser.count() !== 1 || await browser.getAttribute('href') !== `https://web.max.ru${new URL(configuration.channelUrl).pathname}`) {
      throw new Error('MAX: ссылка веб-интерфейса заданного канала не подтверждена.');
    }
    await browser.click();

    let prompted = false;
    let profileOpened = false;
    let unknownSince = Date.now();
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      controller.signal.throwIfAborted();
      const access = await readChannelAccess(page, configuration.channelUrl);
      if (access === 'ready') return true;
      if (access === 'unknown' && !profileOpened && /^\/-\d+$/.test(new URL(page.url()).pathname)) {
        const profile = page.getByRole('button', { name: /^Открыть профиль / });
        if (await profile.count() === 1 && await profile.isVisible()) {
          await profile.click();
          profileOpened = true;
        }
      }
      if (access === 'mismatch') throw new Error('MAX: открытый канал не совпадает с MAX_CHANNEL_URL.');
      if (access === 'auth-required') {
        if (!prompted) console.log(JSON.stringify({ event: 'auth-required', service: 'max', message: 'Войдите вручную только на сайте MAX. Пароль и код CLI не запрашивает.' }));
        prompted = true;
        unknownSince = Date.now();
      } else if (!(prompted && !/^\/-\d+$/.test(new URL(page.url()).pathname)) && Date.now() - unknownSince > 30_000) {
        throw new Error('MAX: структура, заданный канал или права публикации не подтверждены. Действия остановлены.');
      }
      await setTimeout(500, undefined, { signal: controller.signal });
    }
    throw new Error('MAX: доступ не подтверждён за 5 минут; повторите auth max.');
  } catch (error) {
    if (controller.signal.aborted) return false;
    const diagnostics = join(configuration.dataDirectory, 'diagnostics', `max-auth-${randomUUID()}`);
    let screenshotAvailable = false;
    try {
      mkdirSync(diagnostics, { recursive: true, mode: 0o700 });
      await context.pages()[0]?.screenshot({ path: join(diagnostics, 'error.png') });
      screenshotAvailable = context.pages().length > 0;
    } catch { /* Диагностика не подменяет исходную ошибку браузера. */ }
    console.error(JSON.stringify({ event: 'browser-error', service: 'max', operation: 'auth', code: 'access-unconfirmed', diagnostics, screenshotAvailable }));
    if (error instanceof Error && error.message.startsWith('MAX:')) throw error;

    throw new Error('MAX: браузерная проверка не завершена. Проверьте сеть и доступ, затем повторите auth max.', { cause: error });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await context.close();
  }
}
