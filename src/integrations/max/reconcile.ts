import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ImportStorage } from '../../storage.ts';
import { reportBrowserFailure } from '../diagnostics.ts';
import { IntegrationFailure, integrationFailure } from '../failure.ts';
import { pixels, confirmMaxPost } from './confirmation.ts';
import { readScheduledPosts } from './scheduled.ts';

/** Сверяет uncertain без создания поста; отсутствие доказательств сохраняет исходную попытку и файл. */
export async function reconcileMaxPost(options: {
  storage: ImportStorage; page: Page; jobId: number; channelUrl: string; diagnosticsDirectory: string;
}): Promise<{ status: 'uncertain' | 'scheduled'; reason: string | null; failure?: IntegrationFailure }> {
  const { storage, page, jobId, channelUrl, diagnosticsDirectory } = options;
  const intended = storage.maxReconciliation(jobId, channelUrl);
  let evidence: Awaited<ReturnType<typeof confirmMaxPost>>;

  try {
    if (Date.parse(intended.scheduledAt) <= Date.now()) throw new Error('MAX: назначенное время прошло, требуется ручной разбор.');
    const bytes = readFileSync(intended.path);
    if (createHash('sha256').update(bytes).digest('hex') !== intended.sha256) throw new Error('MAX: локальный файл не соответствует сохранённому SHA-256.');
    const expected = await pixels(page, `data:${intended.mime};base64,${bytes.toString('base64')}`);
    const result = await readScheduledPosts(page, channelUrl, diagnosticsDirectory);
    evidence = await confirmMaxPost(page, result, { ...intended, channelUrl }, expected);
  } catch (error) {
    const detail = integrationFailure(error).code === 'unknown' ? integrationFailure(error).message : 'MAX: сверка недоступна; результат остаётся неопределённым.';
    const reason = `${detail} Требуется ручной разбор; повторная отправка запрещена.`;
    const directory = join(diagnosticsDirectory, `max-reconcile-${intended.attempt}`);
    const failure = await reportBrowserFailure({ service: 'max', operation: 'reconcile', directory, page, jobId, error });

    return { status: 'uncertain', reason, ...(failure.code !== 'unknown' ? { failure: new IntegrationFailure(failure.code, failure.message, directory, error) } : {}) };
  }

  try { storage.finishMax(jobId, 'scheduled', null, intended.attempt, evidence); } catch (error) {
    const failure = await reportBrowserFailure({ service: 'max', operation: 'reconcile', jobId, page,
      directory: join(diagnosticsDirectory, `max-reconcile-${intended.attempt}`), error });
    throw new IntegrationFailure('unknown', 'MAX: не удалось сохранить подтверждение; остановите run, исправьте хранилище и повторите сверку.', failure.diagnostics, error);
  }

  return { status: 'scheduled', reason: null };

}
