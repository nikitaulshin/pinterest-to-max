import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import type { PublicationPlanner } from '../../core/planning.ts';
import type { QueueState } from '../../core/queue.ts';
import { listQueue } from '../../storage.ts';
import { reportBrowserFailure } from '../diagnostics.ts';
import { openMaxChannel } from './session.ts';
import { readScheduledPosts } from './scheduled.ts';

/** Читает MAX под ownership вызывающего; не открывает бизнес-хранилище для записи. */
export async function previewPlan(configuration: { dataDirectory: string; channelUrl: string; channel: string }, planner: PublicationPlanner, configuredLimit: number): Promise<void> {
  const queue = listQueue(configuration.dataDirectory);
  const board = ('board' in queue ? queue.board : undefined) as { channel_url?: string } | undefined;
  if (!board?.channel_url) throw new Error('Канал хранилища не привязан; выполните auth max.');
  if (board.channel_url !== configuration.channelUrl) throw new Error('Канал хранилища не совпадает с MAX_CHANNEL_URL; используйте другой DATA_DIR');

  let context: BrowserContext | undefined;
  let stopped = false;
  const stop = () => {
    stopped = true;
    void context?.close().catch(() => {});
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    const profile = join(configuration.dataDirectory, 'profiles/max');
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    context = await chromium.launchPersistentContext(profile, {
      headless: true, timezoneId: 'Europe/Moscow',
      // Завершением контекста управляет CLI, чтобы успеть освободить ownership.
      handleSIGINT: false, handleSIGTERM: false,
      ...(configuration.channel === 'chrome' ? { channel: 'chrome' } : {}),
    });
    if (stopped) return;

    const page = context.pages()[0] ?? await context.newPage();
    await openMaxChannel(page, configuration.channelUrl);
    await page.waitForFunction(() => /^\/-\d+$/.test(location.pathname)
      || !![...document.querySelectorAll('button')].find((button) => button.textContent === 'Войти по номеру телефона'), undefined, { timeout: 30_000 });
    await page.getByRole('button', { name: /^Открыть профиль |^Войти по номеру телефона$/ }).waitFor({ state: 'visible', timeout: 30_000 });
    const snapshot = await readScheduledPosts(page, configuration.channelUrl, join(configuration.dataDirectory, 'diagnostics'));
    const now = new Date();
    const plan = planner.plan({ queue: queue.items as unknown as (QueueState & { scheduled_at: string | null })[], snapshot, channelUrl: configuration.channelUrl, now });
    const moscow = (utc: string) => `${new Date(Date.parse(utc) + 3 * 3_600_000).toISOString().slice(0, -1)}+03:00`;
    const reasons: string[] = [];
    if (!plan.readyCount) reasons.push('Нет готовых безопасных заданий с наступившим временем повтора.');
    if (!plan.availableCapacity) reasons.push('Лимит отложки исчерпан постами MAX и незавершёнными назначениями.');
    if (plan.remainingReadyCount && plan.horizonExhausted) reasons.push('Свободные будущие слоты в горизонте исчерпаны.');
    if (plan.remainingReadyCount && !plan.remainingCapacity) reasons.push('Остаток очереди превышает доступную ёмкость отложки.');

    console.log(JSON.stringify({
      event: 'plan-dry-run', channelUrl: configuration.channelUrl, timezone: 'Europe/Moscow',
      calculatedAt: now.toISOString(), calculatedAtMoscow: moscow(now.toISOString()),
      ...plan, configuredLimit, platformLimit: 100,
      assignments: plan.assignments.map((item) => ({ ...item, scheduledAtMoscow: moscow(item.scheduledAt) })),
      occupiedSlotsMoscow: plan.occupiedSlots.map(moscow), reasons,
      notice: 'Это снимок, не резервирование; перед созданием требуется новое чтение MAX.',
    }));
  } catch (error) {
    if (stopped) return;

    throw await reportBrowserFailure({ service: 'max', operation: 'plan-dry-run',
      directory: join(configuration.dataDirectory, 'diagnostics', `max-plan-${randomUUID()}`),
      error, page: context?.pages()[0] });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await context?.close().catch(() => {});
  }
}
