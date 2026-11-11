import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Page } from 'playwright';
import { IntegrationFailure, integrationFailure } from './failure.ts';

/** Сохраняет приватный JSON; отказ диска не подменяет исход операции. */
export function writeDiagnostic(path: string, value: unknown): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    if (existsSync(path)) chmodSync(path, 0o600);
    writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
    chmodSync(path, 0o600);
    return true;
  } catch {
    return false;
  }
}

/** Сохраняет буфер Playwright сразу с приватными правами; закрытый браузер допустим. */
export async function captureScreenshot(directory: string, page?: Pick<Page, 'screenshot'>): Promise<boolean> {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    if (!page) return false;

    const bytes = await page.screenshot({ timeout: 5_000 });
    const path = join(directory, 'error.png');
    if (existsSync(path)) chmodSync(path, 0o600);
    writeFileSync(path, bytes, { mode: 0o600 });
    chmodSync(path, 0o600);
    return true;
  } catch {
    return false;
  }
}

/** Пишет единый безопасный контракт ошибки; cause остаётся только в памяти. */
export async function reportBrowserFailure(options: {
  service: 'max' | 'pinterest'; operation: string; directory: string; error: unknown; page?: Pick<Page, 'screenshot'> | undefined; jobId?: number; screenshotAvailable?: boolean;
}): Promise<IntegrationFailure> {
  const failure = integrationFailure(options.error);
  const screenshotAvailable = options.screenshotAvailable ?? await captureScreenshot(options.directory, options.page);
  const event = {
    event: 'browser-error', time: new Date().toISOString(), service: options.service, operation: options.operation,
    ...(options.jobId === undefined ? {} : { jobId: options.jobId }), code: failure.code,
    reason: failure.message, diagnostics: options.directory, screenshotAvailable,
    ...(screenshotAvailable ? { screenshot: join(options.directory, 'error.png') } : {}),
  };
  const diagnosticWritten = writeDiagnostic(join(options.directory, 'summary.json'), event);
  console.error(JSON.stringify({ ...event, diagnosticWritten }));

  return new IntegrationFailure(failure.code, failure.message, options.directory, options.error);
}
