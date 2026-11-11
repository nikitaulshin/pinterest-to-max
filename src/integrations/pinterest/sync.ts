import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';
import { captureScreenshot, reportBrowserFailure, writeDiagnostic } from '../diagnostics.ts';
import { IntegrationFailure, integrationFailure } from '../failure.ts';
import { traverseBoard } from './board.ts';
import type { BoardTraversal } from './board.ts';
import { preparePinImage } from './image.ts';
import type { ImportStorage } from '../../storage.ts';

/** Обходит доску; bootstrap сохраняет только историю, sync подготавливает новые материалы. */
export async function syncPinterest(configuration: { dataDirectory: string; boardUrl: string; channel: string }, command: 'sync' | 'sync-full' | 'bootstrap' | { mode: 'backfill'; count: number; resume?: string }, storage: ImportStorage, signal?: AbortSignal) {
  const mode = typeof command === 'object' ? command.mode : command;
  const backfill = typeof command === 'object' ? storage.beginBackfill(command.count, command.resume) : null;
  const bootstrap = mode === 'bootstrap';
  const full = mode !== 'sync';
  const runId = backfill?.id ?? (bootstrap ? storage.beginBootstrap() : null);
  const diagnostics = join(configuration.dataDirectory, 'diagnostics', `sync-${Date.now()}-${randomUUID()}`);
  const log = (event: string, fields: object) => console.log(JSON.stringify({ time: new Date().toISOString(), service: 'pinterest', operation: mode, event, ...fields }));
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let stopped = false;
  const stop = () => { stopped = true; void context?.close().catch(() => {}); };
  if (signal) {
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  } else {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  let traversal: BoardTraversal = { status: 'partial', pins: [], expectedCount: null, reason: 'browser-error' };
  let ready = 0;
  let known = 0;
  let materialFailures = 0;
  let networkFailures = 0;
  let browserFailures = 0;
  let browserStop: string | null = null;
  let failureReason: string | undefined;
  let screenshotAvailable = false;
  const screenshot = join(diagnostics, 'error.png');
  let rootError: unknown;

  try {
    if (stopped) throw new Error('Pinterest: операция прервана.');

    log('pinterest-sync-started', { full, diagnostics, ...(backfill ? { runId, ...backfill } : {}) });
    await mkdir(join(configuration.dataDirectory, 'profiles/pinterest'), { recursive: true, mode: 0o700 });
    context = await chromium.launchPersistentContext(join(configuration.dataDirectory, 'profiles/pinterest'), {
      headless: true, handleSIGINT: false, handleSIGTERM: false,
      ...(configuration.channel === 'chrome' ? { channel: 'chrome' } : {}),
    });
    page = context.pages()[0] ?? await context.newPage();
    if (stopped) throw new Error('Pinterest: операция прервана.');

    traversal = await traverseBoard(page, configuration.boardUrl, bootstrap || backfill ? {
      onProgress: (progress) => {
        if (backfill) storage.backfillProgress(runId!, progress.pins, progress.expectedCount);
        else storage.bootstrapProgress(runId!, progress.pins, progress.expectedCount);
        log(backfill ? 'pinterest-backfill-progress' : 'pinterest-bootstrap-progress', { runId, observed: progress.pins.length, expectedCount: progress.expectedCount });
      },
    } : {});
    if (backfill) storage.backfillProgress(runId!, traversal.pins, traversal.expectedCount);
    else if (bootstrap) storage.bootstrapProgress(runId!, traversal.pins, traversal.expectedCount);
    else storage.sources(traversal.pins);
    writeDiagnostic(join(diagnostics, 'sources.json'), { ...traversal, pins: traversal.pins.map((pin) => ({ ...pin, imageUrls: pin.imageUrls?.map((url) => url.split('?')[0]) })) });
    log('pinterest-board-traversed', { status: traversal.status, reason: traversal.reason, observed: traversal.pins.length, expectedCount: traversal.expectedCount });
    failureReason = traversal.failureReason;
    // Частичная доска не разрешает продолжать браузерные действия после потери доступа или структуры.
    if (traversal.status === 'partial' && ['captcha', 'auth-required', 'structure-changed', 'board-changed', 'browser-error', 'network', 'unknown-count', 'unknown-slot'].includes(traversal.reason)) browserStop = traversal.reason;

    if (!bootstrap && !browserStop) {
      for (const pin of traversal.pins) {
        if (stopped) break;
        if (backfill && storage.backfill(runId!).acceptedCount >= backfill.requestedCount) break;
        if (storage.imported(pin.id, !!backfill)) {
          known++;
          await journal({ id: pin.id, status: 'known' });
          log('pinterest-image-processed', { id: pin.id, status: 'known', ready, known, processed: ready + known + materialFailures + browserFailures, total: traversal.pins.length });
          continue;
        }

        const result = await preparePinImage(page, pin, configuration.boardUrl, configuration.dataDirectory);
        storage.image(result, backfill?.id);
        await journal({ ...result, imageUrl: result.imageUrl?.split('?')[0], ...('variants' in result ? { variants: result.variants.map((variant) => ({ ...variant, url: variant.url.split('?')[0] })) } : {}) });
        if (result.status === 'ready') ready++;
        else {
          if (result.code === 'network') { networkFailures++; failureReason = result.reason; }
          if (/CAPTCHA|блокировка/.test(result.reason)) browserStop = 'captcha';
          else if (/ручной вход/.test(result.reason)) browserStop = 'auth-required';
          else if (/структура пина|представление пина не подтверждено/.test(result.reason)) browserStop = 'structure-changed';
          if (browserStop) browserFailures++;
          else materialFailures++;
          if (!screenshotAvailable) screenshotAvailable = await captureScreenshot(diagnostics, page);
        }
        log('pinterest-image-processed', { id: pin.id, status: result.status, ready, known, materialFailures, browserFailures, processed: ready + known + materialFailures + browserFailures, total: traversal.pins.length, ...(result.status === 'failed' ? { reason: result.reason, screenshotAvailable } : {}) });
        if (browserStop) break;
      }
    }
  } catch (error) {
    rootError = error;
    failureReason = integrationFailure(error).message;
    browserStop = stopped ? 'interrupted' : integrationFailure(error).code === 'network' ? 'network' : 'browser-or-storage-error';
  }

  try {
    return await finish();
  } catch (error) {
    const diagnostic = await reportBrowserFailure({ service: 'pinterest', operation: mode, directory: diagnostics, page, error: rootError ?? error });
    throw new IntegrationFailure('unknown', 'Pinterest: не удалось сохранить исход; остановите run и исправьте хранилище.', diagnostic.diagnostics, rootError ?? error);
  } finally {
    await context?.close().catch(() => {});
    signal?.removeEventListener('abort', stop);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }

  async function journal(value: unknown) {
    try {
      await appendFile(join(diagnostics, 'results.jsonl'), `${JSON.stringify(value)}\n`, { mode: 0o600 });
    } catch { /* Необязательный журнал не подменяет результат импорта. */ }
  }

  async function finish() {
    const traversalComplete = traversal.status === 'complete';
    const operation = backfill ? storage.backfill(runId!) : null;
    const shortfall = operation ? operation.requestedCount - operation.acceptedCount : 0;
    const complete = traversalComplete && !browserStop && !stopped && (backfill ? shortfall === 0 : materialFailures === 0);
    const reason = stopped ? 'interrupted' : browserStop ?? (traversalComplete && shortfall > 0 ? 'insufficient-eligible-images' : traversal.reason);
    if (backfill) storage.finishBackfill(runId!, traversalComplete && !stopped, complete, reason);
    if (bootstrap) storage.finishBootstrap(runId!, complete, stopped ? 'interrupted' : browserStop ?? traversal.reason);

    if (!complete) {
      if (!screenshotAvailable) screenshotAvailable = await captureScreenshot(diagnostics, page);
      const code = networkFailures ? 'network' : ['network', 'auth-required', 'captcha', 'structure-changed'].includes(reason) ? reason as IntegrationFailure['code'] : 'unknown';
      await reportBrowserFailure({ service: 'pinterest', operation: mode, directory: diagnostics, screenshotAvailable,
        error: rootError ?? new IntegrationFailure(code, failureReason ?? `Pinterest: ${reason}`) });
    }

    const summary = {
      status: complete ? 'complete' : 'incomplete',
      mode, ...(runId ? { runId } : {}),
      ...(operation ? { requestedCount: operation.requestedCount, acceptedCount: operation.acceptedCount, shortfall, reason } : {}),
      full, traversalStatus: traversal.status, traversalReason: traversal.reason,
      expectedCount: traversal.expectedCount, observed: traversal.pins.length, ready, known, materialFailures, browserFailures, networkFailures, failureReason,
      unprocessed: bootstrap ? 0 : traversal.pins.length - ready - known - materialFailures - browserFailures, browserStop: stopped ? 'interrupted' : browserStop,
      diagnostics, screenshotAvailable, ...(screenshotAvailable ? { screenshot } : {}),
    };
    const diagnosticWritten = writeDiagnostic(join(diagnostics, 'summary.json'), summary);
    log('pinterest-sync-finished', { ...summary, diagnosticWritten });

    return summary;
  }
}
