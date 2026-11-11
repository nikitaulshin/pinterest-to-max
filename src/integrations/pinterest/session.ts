import { randomUUID } from 'node:crypto';
import { IntegrationFailure, integrationFailure } from '../failure.ts';
import { reportBrowserFailure } from '../diagnostics.ts';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
import type { Page } from 'playwright';

/** Наблюдённые признаки страницы без полей ввода, cookies и состояния приложения. */
export interface BoardSignals {
  challenge: boolean;
  login: boolean;
  account: boolean;
  board: boolean;
  heading: boolean;
  pins: boolean;
}

/** Приоритет защиты и утраты входа выше признаков доступной доски. */
export function boardAccess(signals: BoardSignals): 'captcha' | 'auth-required' | 'ready' | 'unknown' {
  if (signals.challenge) return 'captcha';
  if (signals.login) return 'auth-required';
  if (signals.account && signals.board && signals.heading && signals.pins) return 'ready';

  return 'unknown';
}

/** Читает подтверждённые элементы доски, не извлекая учётные данные. */
export async function readBoardAccess(page: Page, boardUrl: string) {
  const visible = async (selector: string) => {
    for (const element of await page.locator(selector).all()) {
      if (await element.isVisible()) return true;
    }

    return false;
  };
  const text = await page.locator('body').innerText();
  const actual = new URL(page.url());
  const expected = new URL(boardUrl);

  return boardAccess({
    challenge: await visible('iframe[src*="captcha"], iframe[title*="challenge" i], iframe[title*="captcha" i]')
      || /verify you are human|подтвердите, что вы человек|unusual traffic|необычный трафик|access denied|доступ заблокирован/i.test(text),
    login: await page.getByRole('button', { name: 'Войти', exact: true }).first().isVisible()
      || /Вы вышли из системы/.test(text) || /\/login\/?$/.test(actual.pathname),
    account: await visible('button[data-test-id="header-accounts-options-button"][aria-label="Аккаунты"]'),
    board: actual.hostname === expected.hostname && actual.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, ''),
    heading: await visible('h1, h2, h3'),
    pins: await page.locator('a[href^="/pin/"]').evaluateAll((links) => links.some((link) => /^\/pin\/\d+\/$/.test(link.getAttribute('href') ?? '') && link.getClientRects().length > 0)),
  });
}

/** Открывает отдельный persistent profile и ждёт только ручного входа на сайте. */
export async function authenticatePinterest(configuration: { dataDirectory: string; boardUrl: string; channel: string }) {
  const profile = join(configuration.dataDirectory, 'profiles/pinterest');
  mkdirSync(profile, { recursive: true, mode: 0o700 });

  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    ...(configuration.channel === 'chrome' ? { channel: 'chrome' } : {}),
  }).catch(async (error: unknown) => {
    throw await reportBrowserFailure({ service: 'pinterest', operation: 'auth',
      directory: join(configuration.dataDirectory, 'diagnostics', `pinterest-auth-${randomUUID()}`),
      error: new IntegrationFailure(integrationFailure(error).code, 'Pinterest: не удалось открыть браузер; проверьте установку выбранного браузера и владельца профиля.', undefined, error) });
  });
  const controller = new AbortController();
  const stop = () => { controller.abort(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(configuration.boardUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    let manualLogin = false;
    let unknownSince = Date.now();
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      controller.signal.throwIfAborted();
      const access = await readBoardAccess(page, configuration.boardUrl);
      if (access === 'captcha') throw new Error('Pinterest: CAPTCHA или блокировка. Автоматические действия остановлены; восстановите доступ вручную.');
      if (access === 'ready') {
        console.log(JSON.stringify({ event: 'authenticated', service: 'pinterest' }));
        return;
      }
      if (access === 'auth-required') {
        if (!manualLogin) {
          console.log(JSON.stringify({ event: 'auth-required', service: 'pinterest', message: 'Требуется ручной вход Pinterest. Введите пароль и код только на сайте; после входа вернитесь на настроенную доску.' }));
          manualLogin = true;
        }
        unknownSince = Date.now();
      } else if (Date.now() - unknownSince > 30_000) {
        throw new Error('Pinterest: структура страницы или доступ к заданной доске не подтверждены. Операция остановлена.');
      }

      await setTimeout(500, undefined, { signal: controller.signal });
    }

    throw new Error('Pinterest: доступ не подтверждён за 5 минут. Повторите auth pinterest для ручного входа.');
  } catch (error) {
    if (controller.signal.aborted) return;
    throw await reportBrowserFailure({ service: 'pinterest', operation: 'auth',
      directory: join(configuration.dataDirectory, 'diagnostics', `pinterest-auth-${randomUUID()}`),
      error, page: context.pages()[0] });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await context.close().catch(() => {});
  }
}
