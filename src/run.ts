import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { chromium, type BrowserContext } from 'playwright';
import { reportBrowserFailure } from './integrations/diagnostics.ts';
import { randomUUID } from 'node:crypto';
import { RetryDelay } from './core/retry.ts';
import { IntegrationFailure, integrationFailure } from './integrations/failure.ts';
import type { PublicationPlanner } from './core/planning.ts';
import { ImportStorage, listQueue } from './storage.ts';
import { syncPinterest } from './integrations/pinterest/sync.ts';
import { openMaxChannel } from './integrations/max/session.ts';
import { assertMaxAccess } from './integrations/max/scheduled.ts';
import { scheduleMaxBatch } from './integrations/max/batch.ts';

/** Проверяет сохранённую первоначальную политику и обе привязки до открытия браузеров и записи. */
export function validateRunStorage(dataDirectory: string, boardUrl: string, channelUrl: string): void {
  if (!existsSync(join(dataDirectory, 'state.sqlite'))) throw new Error('История доски не инициализирована: выполните bootstrap или первоначальный backfill, затем auth max.');

  const snapshot = listQueue(dataDirectory);
  const board = ('board' in snapshot ? snapshot.board : undefined) as { board_url: string; channel_url: string | null; initialized: number };
  if (!board) throw new Error('Хранилище очереди ещё не инициализировано');
  if (board.board_url !== boardUrl) throw new Error('Доска хранилища не совпадает с PINTEREST_BOARD_URL; используйте другой DATA_DIR');
  if (!board.initialized) throw new Error('История доски не инициализирована: выполните bootstrap или первоначальный backfill.');
  if (!board.channel_url) throw new Error('Канал хранилища не привязан; выполните auth max.');
  if (board.channel_url !== channelUrl) throw new Error('Канал хранилища не совпадает с MAX_CHANNEL_URL; используйте другой DATA_DIR');
}

/** Два последовательных внутри себя цикла разделяют хранилище, но не ожидания браузеров. */
export async function runAutomation(pinterest: { dataDirectory: string; boardUrl: string; channel: string }, max: { dataDirectory: string; channelUrl: string; channel: string }, planner: PublicationPlanner, intervalMs: number): Promise<void> {
  const storage = new ImportStorage(pinterest.dataDirectory, pinterest.boardUrl);
  const controller = new AbortController();
  let context: BrowserContext | undefined;
  const stop = () => {
    controller.abort();
    void context?.close().catch(() => {});
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const signal = controller.signal;

  async function loop(service: string, operation: () => Promise<unknown>) {
    const retry = new RetryDelay(intervalMs);
    let paused = false;
    while (!signal.aborted) {
      let delay = intervalMs;
      if (!paused) {
        try {
          await operation();
          retry.success();
        } catch (error) {
          if (signal.aborted) break;
          const failure = integrationFailure(error);
          const next = failure.code === 'network' ? retry.next() : null;
          paused = next === null;
          delay = next ?? 2_147_483_647;
          console.error(JSON.stringify({ event: 'cycle-error', service, time: new Date().toISOString(),
            operation: 'cycle', screenshotAvailable: false, code: failure.code, reason: failure.message, diagnostics: failure.diagnostics, paused, retryInMs: next,
            ...(paused ? { recovery: `Остановите run; восстановите доступ через auth ${service} или исправьте причину, затем запустите run.` } : {}) }));
        }
      } else delay = 2_147_483_647;
      if (signal.aborted) break;

      await setTimeout(delay, undefined, { signal }).catch(() => {});
    }
  }

  async function schedule() {
    storage.resumeMaxNetworkRetries();
    const snapshot = listQueue(max.dataDirectory);
    if (snapshot.nextReadyId === null && !snapshot.items.some((job) => job.status === 'uncertain')) return;
    signal.throwIfAborted();

    const profile = join(max.dataDirectory, 'profiles/max');
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    try {
      context = await chromium.launchPersistentContext(profile, {
        headless: true, timezoneId: 'Europe/Moscow', handleSIGINT: false, handleSIGTERM: false,
        ...(max.channel === 'chrome' ? { channel: 'chrome' } : {}),
      });
      signal.throwIfAborted();
      const page = context.pages()[0] ?? await context.newPage();
      await openMaxChannel(page, max.channelUrl);
      try {
        await page.getByRole('button', { name: /^Открыть профиль |^Войти по номеру телефона$/ }).waitFor({ state: 'visible', timeout: 30_000 });
      } catch (error) {
        await assertMaxAccess(page);
        throw error;
      }
      await assertMaxAccess(page);
      signal.throwIfAborted();
      const result = await scheduleMaxBatch({ storage, page, dataDirectory: max.dataDirectory, channelUrl: max.channelUrl,
        diagnosticsDirectory: join(max.dataDirectory, 'diagnostics'), planner, retryIntervalMs: intervalMs, signal });
      if (result.failure) throw result.failure;
      console.log(JSON.stringify({ event: 'max-cycle-finished', ...result }));
    } catch (error) {
      throw await reportBrowserFailure({ service: 'max', operation: 'cycle',
        directory: join(max.dataDirectory, 'diagnostics', `max-cycle-${randomUUID()}`), page: context?.pages()[0], error });
    } finally {
      await context?.close().catch(() => {});
      context = undefined;
    }
  }

  try {
    storage.recoverMaxInterrupted();
    console.log(JSON.stringify({ event: 'started', mode: 'run', syncIntervalSeconds: intervalMs / 1000 }));
    await Promise.all([loop('pinterest', async () => {
      const result = await syncPinterest(pinterest, 'sync', storage, signal);
      if (!result || result.status === 'complete') return;
      const reason = result.browserStop ?? (result.traversalStatus === 'partial' ? result.traversalReason : null);
      if (reason) {
        const code = ['network', 'auth-required', 'captcha'].includes(reason) ? reason as 'network' | 'auth-required' | 'captcha' : 'structure-changed';
        throw new IntegrationFailure(code, result.failureReason ?? `Pinterest: ${reason}`, result.diagnostics);
      }
      if (result.networkFailures) throw new IntegrationFailure('network', result.failureReason ?? 'Pinterest: временный сетевой отказ импорта.', result.diagnostics);
    }), loop('max', schedule)]);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    storage.close();
  }
  console.log(JSON.stringify({ event: 'stopped' }));
}
