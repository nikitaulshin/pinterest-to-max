import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { reportBrowserFailure } from '../diagnostics.ts';
import { IntegrationFailure, integrationFailure } from '../failure.ts';
import { readChannelAccess } from './session.ts';

/** Наблюдённый пост; адреса media — кандидаты для проверки изображения, не его идентичность. */
export type ScheduledPost = { scheduledAt: string; imageUrls: string[]; hasText: boolean };

/** Останавливает защищённые действия по наблюдённому login или CAPTCHA iframe. */
export async function assertMaxAccess(page: Page): Promise<void> {
  if (await page.getByRole('button', { name: 'Войти по номеру телефона', exact: true }).isVisible()) throw new IntegrationFailure('auth-required', 'MAX: требуется auth max.');
  if (await page.locator('iframe[src*="captcha"]').count()) throw new IntegrationFailure('captcha', 'MAX: CAPTCHA; восстановите доступ вручную.');
}

/** Читает текущий DOM-контракт MAX; вызывающий удерживает ownership и задаёт Europe/Moscow. */
export async function readScheduledPosts(page: Page, channelUrl: string, diagnosticsDirectory: string): Promise<{
  channelUrl: string;
  posts: ScheduledPost[];
}> {
  const deadline = Date.now() + 120_000;
  const originalUrl = page.url();
  const moscowDay = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
  const readingDay = moscowDay();
  const fail = (reason: string, code: 'auth-required' | 'captcha' | 'structure-changed' = 'structure-changed'): never => { throw new IntegrationFailure(code, `MAX: ${reason}`); };
  const guard = async () => {
    if (moscowDay() !== readingDay) fail('московская дата изменилась во время чтения.');
    if (Date.now() > deadline) fail('истекло время чтения отложки.');
    if (page.url() !== originalUrl) fail('канал изменился во время чтения.');
    await assertMaxAccess(page);
    if (await page.locator('[aria-busy="true"], [role="progressbar"]').count()) fail('загрузка или проверка доступа не завершена.');
    if (await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone) !== 'Europe/Moscow') fail('часовой пояс браузера должен быть Europe/Moscow.');
  };
  const verifyChannel = async () => {
    await guard();
    const identity = page.locator('span[data-type="action-small"]').filter({ hasText: /^Ссылка$/ });
    if (!await identity.isVisible()) {
      const profile = page.getByRole('button', { name: /^Открыть профиль / });
      if (await profile.count() !== 1) fail('профиль канала не подтверждён.');
      await profile.click({ timeout: 5_000 });
    }
    // Кнопка профиля появляется раньше его ссылки и доступных действий после reload.
    const loadedDeadline = Date.now() + 5_000;
    let access = await readChannelAccess(page, channelUrl);
    while (access === 'unknown' && Date.now() < loadedDeadline) {
      await page.waitForTimeout(100);
      await guard();
      access = await readChannelAccess(page, channelUrl);
    }
    if (access !== 'ready') fail('канал или права публикации не подтверждены.');
    const composer = page.locator('[data-testid="composer"]');
    if (await composer.count() !== 1 || !await composer.isVisible()
      || await composer.locator('[contenteditable]').count() !== 1) fail('редактор канала не загружен.');
  };
  const absent = async () => await page.getByRole('button', { name: 'Открыть отложенные сообщения', exact: true }).count() === 0
    && await page.getByText('Запланированные посты', { exact: true }).count() === 0;

  try {
    await verifyChannel();
    if (await absent()) {
      // Пустая отложка скрывает оба control: подтверждаем полный профиль/редактор повторно после reload.
      await page.waitForTimeout(600);
      await verifyChannel();
      if (await absent()) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.getByRole('button', { name: /^Открыть профиль / }).waitFor({ state: 'visible', timeout: 30_000 });
        await verifyChannel();
        await page.waitForTimeout(600);
        await verifyChannel();
        if (await absent()) return { channelUrl, posts: [] };
      }
      // До первого снимка controls могли ещё загружаться; появившийся список читаем полностью.
    }

    const profile = page.locator('.layout.absolute').filter({ has: page.locator('span[data-type="action-small"]').filter({ hasText: /^Ссылка$/ }) });
    if (await profile.count() !== 1) fail('структура открытого профиля не подтверждена.');
    await profile.getByRole('button', { name: 'Перейти назад', exact: true }).click({ timeout: 5_000 });
    await page.getByRole('button', { name: 'Открыть отложенные сообщения', exact: true }).click({ timeout: 5_000 });
    const delayed = page.locator('div.delayedChat');
    await delayed.waitFor({ state: 'visible', timeout: 10_000 });
    if (await delayed.count() !== 1 || (await delayed.locator('.headerTitle').innerText()).trim() !== 'Запланированные посты') fail('отложка не подтверждена.');
    await page.waitForTimeout(600);
    await guard();
    if (await delayed.locator('.emptyHistory').isVisible()) {
      if ((await delayed.locator('.emptyHistory').innerText()).trim() !== 'Нет запланированных постов'
        || await delayed.getByRole('listitem').count()) fail('пустая отложка противоречива.');

      return { channelUrl, posts: [] };
    }

    const scroll = delayed.locator('.scrollListScrollable');
    const content = delayed.locator('.scrollListContent');
    if (await scroll.count() !== 1 || await content.count() !== 1) fail('структура списка не подтверждена.');
    const snapshot = async () => {
      await guard();
      return content.evaluate((element) => [...element.children].map((slot) => ({
        index: slot.getAttribute('data-index'),
        valid: slot.matches('div.item') && slot.querySelectorAll('[role="listitem"]').length === 1,
        date: slot.querySelector('.dateSeparator .date')?.textContent?.trim() ?? '',
        times: [...slot.querySelectorAll('[role="listitem"] [role="button"]')]
          .map((node) => node.textContent?.trim() ?? '').filter((value) => /^\d{1,2}:\d{2}$/.test(value)),
        images: [...slot.querySelectorAll<HTMLImageElement>('[role="listitem"] img')].map((image) => ({
          src: image.currentSrc || image.src, loaded: image.complete && image.naturalWidth > 0,
        })),
        media: slot.querySelector('[aria-label="Прикрепленные фото"]') !== null,
        text: slot.querySelector('[role="listitem"]')?.textContent ?? '',
      })));
    };
    const validate = (slots: Awaited<ReturnType<typeof snapshot>>) => {
      if (slots.length === 0 || slots.length > 100 || slots.some((slot, index) => !slot.valid || slot.index !== String(index) || slot.times.length !== 1)) {
        fail('список неполон, виртуализирован или имеет неизвестную структуру.');
      }
    };
    const first = await snapshot();
    validate(first);
    const structure = (slots: typeof first) => JSON.stringify(slots.map(({ index, valid, date, times, text }) => ({ index, valid, date, times, text })));
    const pass = async () => {
      await scroll.evaluate((element) => { element.scrollTop = 0; });
      await page.waitForTimeout(600);
      for (let index = 0; index < first.length; index++) {
        const item = content.locator(':scope > div.item').nth(index);
        await item.scrollIntoViewIfNeeded({ timeout: 5_000 });
        await page.waitForTimeout(150);
        await page.waitForFunction((element) => {
          if (!element || !element.isConnected) return false;
          const images = [...element.querySelectorAll<HTMLImageElement>('img')];
          return !element.querySelector('[aria-label="Прикрепленные фото"]')
            || images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0);
        }, await item.elementHandle(), { timeout: 5_000 });
        const current = await snapshot();
        validate(current);
        if (structure(current) !== structure(first)) fail('список изменился во время обхода.');
      }
      await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await page.waitForTimeout(600);
      if (!await content.evaluate((element) => element.classList.contains('scrollListContent--bottom'))
        || !await scroll.evaluate((element) => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 2)) fail('нижняя граница списка не подтверждена.');
      const result = await snapshot();
      validate(result);
      if (structure(result) !== structure(first)) fail('список изменился у нижней границы.');
      if (result.some((slot) => slot.media && (slot.images.length === 0 || slot.images.some((image) => !image.loaded)))) fail('изображения списка не загружены.');

      return result;
    };
    const firstPass = await pass();
    const secondPass = await pass();
    if (JSON.stringify(firstPass) !== JSON.stringify(secondPass)) fail('повторный обход не подтвердил стабильный список.');
    await guard();

    let date = '';
    const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    const posts = secondPass.map((slot) => {
      date = slot.date || date;
      if (date === 'Сегодня' || date === 'Завтра') {
        const day = new Date(`${readingDay}T00:00:00.000Z`);
        if (date === 'Завтра') day.setUTCDate(day.getUTCDate() + 1);
        date = `${day.getUTCDate()} ${months[day.getUTCMonth()]} ${day.getUTCFullYear()}`;
      }
      const match = /^(\d{1,2}) (\S+) (\d{4})$/.exec(date);
      const time = /^(\d{1,2}):(\d{2})$/.exec(slot.times[0] ?? '');
      if (!match || !time) return fail('дата или время поста неоднозначны.');
      const month = months.indexOf(match[2] ?? '');
      const [day, year, hour, minute] = [Number(match[1]), Number(match[3]), Number(time[1]), Number(time[2])];
      const utc = new Date(Date.UTC(year, month, day, hour - 3, minute));
      const local = new Date(utc.getTime() + 3 * 3_600_000);
      if (year < 2014 || month < 0 || hour > 23 || minute > 59 || local.getUTCDate() !== day || local.getUTCMonth() !== month) return fail('дата или время поста некорректны.');

      return { scheduledAt: utc.toISOString(), imageUrls: slot.images.map((image) => image.src), hasText: slot.text.replace(slot.times[0]!, '').trim().length > 0 };
    });

    return { channelUrl, posts };
  } catch (error) {
    const directory = join(diagnosticsDirectory, `max-read-${randomUUID()}`);
    let failure = integrationFailure(error);
    try { await assertMaxAccess(page); } catch (accessError) {
      if (accessError instanceof IntegrationFailure) failure = accessError;
    }
    throw await reportBrowserFailure({ service: 'max', operation: 'read-scheduled', directory, page,
      error: new IntegrationFailure(failure.code === 'unknown' ? 'structure-changed' : failure.code, `MAX: чтение отложки остановлено; ${failure.message}`, directory, error) });
  }
}
