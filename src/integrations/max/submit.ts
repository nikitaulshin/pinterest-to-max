import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Page } from 'playwright';
import type { ImportStorage } from '../../storage.ts';
import { assertMaxAccess, readScheduledPosts, type ScheduledPost } from './scheduled.ts';
import { IntegrationFailure, integrationFailure } from '../failure.ts';
import { reportBrowserFailure, writeDiagnostic } from '../diagnostics.ts';
import { pixels, confirmMaxPost } from './confirmation.ts';

async function closePanels(page: Page) {
  const delayed = page.locator('div.delayedChat');
  if (await delayed.isVisible()) await delayed.getByRole('button', { name: 'Перейти назад', exact: true }).click({ timeout: 5_000 });
  const profile = page.locator('.layout.absolute').filter({ has: page.locator('span[data-type="action-small"]').filter({ hasText: /^Ссылка$/ }) });
  if (await profile.isVisible()) await profile.getByRole('button', { name: 'Перейти назад', exact: true }).click({ timeout: 5_000 });
}

async function selectTime(page: Page, scheduledAt: string) {
  const date = new Date(Date.parse(scheduledAt) + 3 * 3_600_000);
  const months = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  const short = ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'];
  const dialog = page.getByRole('dialog').filter({ has: page.getByText('Запланировать пост', { exact: true }) });
  await dialog.waitFor({ state: 'visible', timeout: 5_000 });
  const heading = dialog.getByText(new RegExp(`^(${months.join('|')})\\s*\\d{4}$`, 'i'));
  const label = (await heading.innerText()).toLowerCase().match(/^(\S+)\s*(\d{4})$/);
  if (!label) throw new Error('MAX: месяц календаря не подтверждён.');
  const delta = (date.getUTCFullYear() - Number(label[2])) * 12 + date.getUTCMonth() - months.indexOf(label[1]!);
  if (!Number.isInteger(delta) || Math.abs(delta) > 24) throw new Error('MAX: дата вне проверяемого календаря.');
  for (let index = 0; index < Math.abs(delta); index++) await dialog.getByRole('button', { name: delta > 0 ? 'Следующий месяц' : 'Предыдущий месяц', exact: true }).click({ timeout: 5_000 });
  if ((await heading.innerText()).toLowerCase().replace(/\s/g, '') !== `${months[date.getUTCMonth()]}${date.getUTCFullYear()}`) throw new Error('MAX: выбранный месяц не подтверждён.');
  await dialog.getByRole('button', { name: String(date.getUTCDate()), exact: true }).click({ timeout: 5_000 });
  for (const [name, value] of [['Часы', date.getUTCHours()], ['Минуты', date.getUTCMinutes()]] as const) {
    const input = dialog.getByRole('spinbutton', { name, exact: true });
    await input.press('ControlOrMeta+A');
    await input.pressSequentially(String(value));
    if (await input.getAttribute('aria-valuenow') !== String(value)) throw new Error('MAX: время формы не подтверждено.');
  }

  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
  const tomorrow = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date(new Date().getTime() + 86_400_000));
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date(scheduledAt));
  const labelDay = day === today ? 'сегодня' : day === tomorrow ? 'завтра' : `${date.getUTCDate()} ${short[date.getUTCMonth()]}`;

  return dialog.getByRole('button', { name: `Отправить ${labelDay} в ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`, exact: true });
}

/** Создаёт ровно одну отложку; вызывающий удерживает ownership и закрывает выделенную страницу после исхода. */
export async function submitMaxPost(options: {
  storage: ImportStorage; page: Page; jobId: number; channelUrl: string; scheduledAt: string; effectiveLimit: number; diagnosticsDirectory: string; signal?: AbortSignal;
}): Promise<{ status: 'ready' | 'failed' | 'uncertain' | 'scheduled'; reason: string | null; scheduleChanged?: boolean; failure?: IntegrationFailure }> {
  const { storage, page, jobId, channelUrl, diagnosticsDirectory } = options;
  if (!Number.isSafeInteger(options.effectiveLimit) || options.effectiveLimit < 1 || options.effectiveLimit > 100) throw new Error('MAX: лимит должен быть целым от 1 до 100.');
  const instant = Date.parse(options.scheduledAt);
  if (!Number.isFinite(instant) || instant % 60_000 !== 0 || instant <= Date.now()) throw new Error('MAX: требуется будущее время с точностью до минуты.');
  const scheduledAt = new Date(instant).toISOString();
  const originalUrl = page.url();
  options.signal?.throwIfAborted();
  const image = storage.prepareMax(jobId, channelUrl, scheduledAt);
  let attempt: string | undefined;
  let replanRequired = false;
  let fileFailure = false;
  const readImage = () => {
    try { return readFileSync(image.path); } catch (error) {
      fileFailure = true;
      throw new Error('MAX: локальный файл недоступен.', { cause: error });
    }
  };
  let verifiedPosts: ScheduledPost[];
  const requireFuture = () => {
    options.signal?.throwIfAborted();
    if (instant <= Date.now()) {
      replanRequired = true;
      throw new Error('MAX: запрошенное время уже прошло.');
    }
  };
  const available = (posts: ScheduledPost[]) => {
    requireFuture();
    if (posts.length >= options.effectiveLimit || posts.some((post) => post.scheduledAt === scheduledAt)) {
      replanRequired = true;
      throw new Error('MAX: слот занят или лимит отложки исчерпан.');
    }
  };

  try {
    const bytes = readImage();
    if (createHash('sha256').update(bytes).digest('hex') !== image.sha256) throw new Error('MAX: локальный файл не соответствует сохранённому SHA-256.');
    const expected = await pixels(page, `data:${image.mime};base64,${bytes.toString('base64')}`).catch((error: unknown) => {
      fileFailure = true;
      throw new Error('MAX: локальный файл не декодируется.', { cause: error });
    });
    available((await readScheduledPosts(page, channelUrl, diagnosticsDirectory)).posts);
    await closePanels(page);
    const composer = page.locator('[data-testid="composer"]');
    const emptyText = async () => {
      if ((await composer.locator('[contenteditable]').innerText()).trim()) throw new Error('MAX: редактор содержит текст, отправка остановлена.');
    };
    await emptyText();
    const preview = composer.getByRole('list', { name: 'Вложения сообщения', exact: true });
    if (await preview.count()) {
      const filename = basename(image.path);
      if (!/^[a-f0-9]{64}\.(jpg|png|webp)$/.test(filename) || !filename.startsWith(image.sha256 + '.')
        || await preview.count() !== 1 || await preview.getByRole('listitem').count() !== 1
        || await preview.getByRole('listitem').getAttribute('aria-label') !== filename
        || await preview.locator('img').count() !== 1 || await preview.locator('img').getAttribute('alt') !== filename) {
        throw new Error('MAX: редактор содержит чужое или неоднозначное вложение.');
      }
      // После аварии переиспользуем только одно доказанно своё фото без текста.
    } else {
      options.signal?.throwIfAborted();
      await composer.getByRole('button', { name: 'Загрузить файл', exact: true }).click({ timeout: 5_000 });
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 5_000 }),
        page.getByRole('menuitem', { name: 'Фото или видео', exact: true }).click({ timeout: 5_000 }),
      ]);
      await chooser.setFiles(image.path, { timeout: 10_000 });
    }
    await preview.waitFor({ state: 'visible', timeout: 10_000 });
    await preview.getByRole('listitem').first().locator('img').waitFor({ state: 'visible', timeout: 10_000 });
    if (await preview.getByRole('listitem').count() !== 1 || await preview.locator('img').count() !== 1) throw new Error('MAX: единственное фото в редакторе не подтверждено.');
    const source = await preview.locator('img').evaluate((image) => (image as HTMLImageElement).currentSrc || (image as HTMLImageElement).src);
    if ((await pixels(page, source)).decodedPixels !== expected.decodedPixels) throw new Error('MAX: фото редактора не соответствует локальному изображению.');
    await composer.getByRole('button', { name: 'Отправить сообщение', exact: true }).click({ button: 'right', timeout: 5_000 });
    await page.getByRole('menuitem', { name: 'Запланировать пост', exact: true }).click({ timeout: 5_000 });
    const send = await selectTime(page, scheduledAt);
    await emptyText();
    if (!await send.isEnabled()) throw new Error('MAX: MAX отклонил выбранное время.');

    const verification = await page.context().newPage();
    try {
      await verification.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await verification.getByRole('button', { name: /^Открыть профиль / }).waitFor({ timeout: 30_000 });
      verifiedPosts = (await readScheduledPosts(verification, channelUrl, diagnosticsDirectory)).posts;
      available(verifiedPosts);
    } finally { await verification.close(); }
    requireFuture();
    if (createHash('sha256').update(readImage()).digest('hex') !== image.sha256) throw new Error('MAX: файл изменился перед отправкой.');

    if (page.url() !== originalUrl || await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone) !== 'Europe/Moscow') throw new Error('MAX: канал или часовой пояс изменились перед отправкой.');
    await emptyText();

    options.signal?.throwIfAborted();
    requireFuture();
    attempt = storage.beginMaxAttempt(jobId, channelUrl, image.sha256, scheduledAt);
    await send.click({ timeout: 5_000 });
    await page.getByRole('dialog').filter({ has: page.getByText('Запланировать пост', { exact: true }) }).waitFor({ state: 'hidden', timeout: 10_000 });
    await page.locator('div.delayedChat').getByRole('listitem').first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.getByRole('button', { name: /^Открыть профиль / }).waitFor({ timeout: 30_000 });
    const result = await readScheduledPosts(page, channelUrl, diagnosticsDirectory);
    const evidence = await confirmMaxPost(page, result, { channelUrl, scheduledAt, sha256: image.sha256 }, expected);
    storage.finishMax(jobId, 'scheduled', null, attempt, evidence);

    // Сравнение метаданных консервативно: смена media URL тоже останавливает партию.
    const metadata = (posts: ScheduledPost[]) => JSON.stringify(posts.map((post) => JSON.stringify({
      scheduledAt: post.scheduledAt, hasText: post.hasText, imageUrls: [...post.imageUrls].sort(),
    })).sort());
    const scheduleChanged = metadata(verifiedPosts) !== metadata(result.posts.filter((post) => post.scheduledAt !== scheduledAt));
    if (scheduleChanged) {
      const directory = join(diagnosticsDirectory, `max-submit-${attempt}`);
      writeDiagnostic(join(directory, 'race.json'), { jobId, attempt, code: 'schedule-changed-after-check' });
    }

    return { status: 'scheduled', reason: null, scheduleChanged };
  } catch (error) {
    let failure = integrationFailure(error);
    try { await assertMaxAccess(page); } catch (accessError) {
      if (accessError instanceof IntegrationFailure) failure = accessError;
    }
    const status = attempt ? 'uncertain' : replanRequired || options.signal?.aborted ? 'ready' : 'failed';
    const reason = options.signal?.aborted
      ? attempt ? 'MAX: отправка прервана; результат неопределён, требуется сверка.' : 'MAX: подготовка прервана; задание готово к пересчёту.'
      : failure.message;
    try { storage.finishMax(jobId, status, reason, attempt); } catch {
      // Ошибка сохранения не превращает исходную ошибку браузера в отказ диска.
      const diagnostic = await reportBrowserFailure({ service: 'max', operation: 'submit', directory: join(diagnosticsDirectory, `max-submit-${attempt ?? `job-${jobId}`}`), page, jobId, error });
      throw new IntegrationFailure('unknown', 'MAX: не удалось сохранить исход; остановите run, исправьте хранилище и перезапустите для восстановления.', diagnostic.diagnostics, error);
    }

    const directory = join(diagnosticsDirectory, `max-submit-${attempt ?? `job-${jobId}`}`);
    const failureDetail = await reportBrowserFailure({ service: 'max', operation: 'submit', directory, page, jobId,
      error: new IntegrationFailure(failure.code, failure.message, directory, error) });
    // После намерения повторяется только сверка; доступ и структура могут остановить интеграцию.
    const pausesIntegration = !attempt || ['auth-required', 'captcha', 'structure-changed'].includes(failure.code);

    return { status, reason, ...(!fileFailure && !replanRequired && pausesIntegration
      && !reason.startsWith('MAX: локальный файл') && !reason.startsWith('MAX: файл изменился') ? { failure: failureDetail } : {}) };
  }
}
