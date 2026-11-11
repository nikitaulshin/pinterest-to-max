import type { Page } from 'playwright';
import type { PublicationPlanner } from '../../core/planning.ts';
import type { QueueState } from '../../core/queue.ts';
import { listQueue, type ImportStorage } from '../../storage.ts';
import { readScheduledPosts } from './scheduled.ts';
import { reconcileMaxPost } from './reconcile.ts';
import { submitMaxPost } from './submit.ts';

/** Выполняет ограниченную партию; вызывающий держит ownership, открывает канал и закрывает контекст/хранилище. */
export async function scheduleMaxBatch(options: {
  storage: ImportStorage; page: Page; dataDirectory: string; channelUrl: string;
  diagnosticsDirectory: string; planner: PublicationPlanner; retryIntervalMs?: number; signal?: AbortSignal;
}) {
  const { storage, page, dataDirectory, channelUrl, diagnosticsDirectory, planner } = options;
  const queue = () => listQueue(dataDirectory).items as unknown as (QueueState & { scheduled_at: string | null })[];
  const reconciled = [];
  for (const job of queue().filter((job) => job.status === 'uncertain')) {
    options.signal?.throwIfAborted();
    const reconciliation = await page.context().newPage();
    try {
      await reconciliation.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await reconciliation.getByRole('button', { name: /^Открыть профиль / }).waitFor({ timeout: 30_000 });
      const result = await reconcileMaxPost({ storage, page: reconciliation, jobId: job.id, channelUrl, diagnosticsDirectory });
      if (result.failure) throw result.failure;
      reconciled.push({ jobId: job.id, ...result });
    } finally { await reconciliation.close(); }
  }

  options.signal?.throwIfAborted();
  const plan = async () => planner.plan({ queue: queue(), snapshot: await readScheduledPosts(page, channelUrl, diagnosticsDirectory), channelUrl, now: new Date() });
  let current = await plan();
  const batchLimit = current.availableCapacity;
  const attemptLimit = current.readyCount;
  const results = [];
  let scheduledCount = 0;
  let collisions = 0;
  while (scheduledCount < batchLimit && results.length < attemptLimit && collisions < 100) {
    options.signal?.throwIfAborted();
    const assignment = current.assignments[0];
    if (!assignment) break;

    const submission = await page.context().newPage();
    let result;
    try {
      await submission.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await submission.getByRole('button', { name: /^Открыть профиль / }).waitFor({ timeout: 30_000 });
      result = await submitMaxPost({ storage, page: submission, ...assignment, channelUrl, diagnosticsDirectory,
        effectiveLimit: current.effectiveLimit - current.reservationCount, ...(options.signal ? { signal: options.signal } : {}) });
    } finally { await submission.close(); }

    options.signal?.throwIfAborted();
    if (result.status === 'failed' && result.failure?.code === 'network') storage.deferMaxNetworkRetry(assignment.jobId, options.retryIntervalMs ?? 300_000);
    if (result.failure) return { batchLimit, reconciled, results: [...results, { ...assignment, ...result }], stopped: result.failure.code, failure: result.failure };
    if (result.status === 'ready') {
      // Ограничиваем повторные расчёты при непрерывном ручном изменении отложки.
      collisions++;
    } else {
      results.push({ ...assignment, ...result });
    }
    if (result.status === 'scheduled') scheduledCount++;
    if (result.status === 'uncertain' || result.scheduleChanged) {
      return { batchLimit, reconciled, results, stopped: result.scheduleChanged ? 'schedule-changed-after-check' : 'uncertain' };
    }

    // Свежая страница исключает локально устаревший список MAX после отправки.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.getByRole('button', { name: /^Открыть профиль / }).waitFor({ timeout: 30_000 });
    current = await plan();
  }

  return { batchLimit, reconciled, results, stopped: collisions === 100 ? 'collision-bound' : null };
}
