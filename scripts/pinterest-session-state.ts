import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';

import { pinterestConfiguration } from '../src/cli.ts';
import { acquireStorageOwnership } from '../src/storage-ownership.ts';

type PinterestState = Awaited<ReturnType<BrowserContext['storageState']>>;

const pinterest = (host: string) => /(^|\.)pinterest\.com$/.test(host);

function requirePinterestState(state: PinterestState): PinterestState {
  if (!Array.isArray(state?.cookies) || !Array.isArray(state?.origins)
    || !state.cookies.every(cookie => typeof cookie.domain === 'string' && pinterest(cookie.domain))
    || !state.origins.every(origin => {
      const url = new URL(origin.origin);
      return url.protocol === 'https:' && pinterest(url.hostname) && url.origin === origin.origin && !url.port;
    })) throw new Error('Состояние должно принадлежать только Pinterest.');

  return state;
}

// Переносит только состояние Pinterest без навигации и изменения чужого профиля.
process.umask(0o077);
async function transfer(): Promise<void> {
  const [action, file, ...extra] = process.argv.slice(2);
  if ((action !== 'export' && action !== 'import') || !file || extra.length) {
    throw new Error('Использование: node scripts/pinterest-session-state.ts export|import STATE_FILE');
  }
  const configuration = pinterestConfiguration(process.env);
  const stateFile = resolve(file);
  const state = action === 'import' ? requirePinterestState(JSON.parse(readFileSync(stateFile, 'utf8')) as PinterestState) : undefined;
  const release = acquireStorageOwnership(configuration.dataDirectory);

  try {
    const context = await chromium.launchPersistentContext(join(configuration.dataDirectory, 'profiles/pinterest'), {
      headless: true,
      ...(configuration.channel === 'chrome' ? { channel: 'chrome' } : {}),
    });

    try {
      if (action === 'export') {
        const browserState = await context.storageState({ indexedDB: true });
        const exported = {
          cookies: browserState.cookies.filter(cookie => pinterest(cookie.domain)),
          origins: browserState.origins.filter(origin => pinterest(new URL(origin.origin).hostname)),
        };
        writeFileSync(stateFile, JSON.stringify(exported), { flag: 'wx', mode: 0o600 });
      } else {
        await context.setStorageState(state!);
      }
      console.log(JSON.stringify({ event: 'pinterest-session-state', action }));
    } finally {
      await context.close();
    }
  } finally {
    release();
  }
}

await transfer().catch(() => {
  console.error('Перенос Pinterest не выполнен. Проверьте команду export|import STATE_FILE, файл, браузер и владельца профиля; состояние авторизации не выводится.');
  process.exitCode = 1;
});
