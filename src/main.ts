import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { help, parseCommand, pinterestConfiguration, maxConfiguration, planningConfiguration, maxScheduledLimit, syncInterval } from './cli.ts';
import { PublicationPlanner } from './core/planning.ts';
import { authenticatePinterest } from './integrations/pinterest/session.ts';
import { ImportStorage, listQueue, channelBoard } from './storage.ts';
import { acquireStorageOwnership } from './storage-ownership.ts';
import { authenticateMax } from './integrations/max/session.ts';
import { syncPinterest } from './integrations/pinterest/sync.ts';
import { runAutomation, validateRunStorage } from './run.ts';
import { previewPlan } from './integrations/max/plan.ts';

process.umask(0o077);

async function main(): Promise<number> {
  const command = parseCommand(process.argv.slice(2));
  if (command === 'help') {
    console.log(help);
    return 0;
  }

  const directory = process.env.DATA_DIR ?? './data';
  if (!directory.trim()) throw new Error('DATA_DIR должен содержать путь к каталогу');
  const dataDirectory = resolve(directory);
  if (command === 'queue-list') {
    console.log(JSON.stringify(listQueue(dataDirectory)));
    return 0;
  }

  if (command === 'plan-dry-run') {
    const max = maxConfiguration(process.env);
    const schedule = planningConfiguration(process.env);
    const limit = maxScheduledLimit(process.env);
    const planner = new PublicationPlanner(schedule, limit);
    schedule.futureSlots(new Date()).next();

    const release = acquireStorageOwnership(dataDirectory);
    try { await previewPlan(max, planner, limit); } finally { release(); }
    return 0;
  }

  if (command === 'run') {
    const missing = ['MAX_CHANNEL_URL', 'PUBLICATION_SLOTS', 'MAX_SCHEDULED_LIMIT'].filter((name) => !process.env[name]?.trim());
    if (missing.length) throw new Error(`Для run нужны настройки: ${missing.join(', ')}`);

    const pinterest = pinterestConfiguration(process.env);
    const max = maxConfiguration(process.env);
    const schedule = planningConfiguration(process.env);
    const planner = new PublicationPlanner(schedule, maxScheduledLimit(process.env));
    const interval = syncInterval(process.env);
    schedule.futureSlots(new Date()).next();
    validateRunStorage(dataDirectory, pinterest.boardUrl, max.channelUrl);

    const release = acquireStorageOwnership(dataDirectory);
    try {
      validateRunStorage(dataDirectory, pinterest.boardUrl, max.channelUrl);
      await runAutomation(pinterest, max, planner, interval);
    } finally { release(); }
    return 0;
  }

  const configuration = command === 'auth-max' || command === 'idle' || (typeof command === 'object' && command.mode === 'queue-change')
    ? undefined : pinterestConfiguration(process.env);
  const max = command === 'auth-max' ? maxConfiguration(process.env) : undefined;
  const release = acquireStorageOwnership(dataDirectory);
  try {
    if (max) {
      const board = channelBoard(dataDirectory, max.channelUrl) ?? pinterestConfiguration({ ...process.env, PINTEREST_BROWSER_CHANNEL: undefined }).boardUrl;
      if (!await authenticateMax(max)) return 0;

      const storage = new ImportStorage(dataDirectory, board);
      try { storage.bindChannel(max.channelUrl); } finally { storage.close(); }
      console.log(JSON.stringify({ event: 'authenticated', service: 'max' }));
      return 0;
    }
    if (typeof command === 'object' && command.mode === 'queue-change') {
      const storage = new ImportStorage(dataDirectory);
      try {
        storage.changeQueue(command.id, command.action);
        console.log(JSON.stringify({ event: `queue-${command.action}`, id: command.id }));
      } finally { storage.close(); }
      return 0;
    }
    if (command === 'auth-pinterest' && configuration) {
      await authenticatePinterest(configuration);
      return 0;
    }
    if (configuration && (command === 'sync' || command === 'sync-full' || command === 'bootstrap' || (typeof command === 'object' && command.mode === 'backfill'))) {
      const storage = new ImportStorage(dataDirectory, configuration.boardUrl);
      try {
        if (command === 'sync' || command === 'sync-full') storage.requireInitialized();

        const result = await syncPinterest(configuration, command, storage);
        return result.status === 'complete' ? 0 : 1;
      } finally { storage.close(); }
    }

    for (const directory of ['images', 'profiles/pinterest', 'profiles/max']) {
      mkdirSync(join(dataDirectory, directory), { recursive: true, mode: 0o700 });
    }
    const database = new DatabaseSync(join(dataDirectory, 'state.sqlite'));
    try {
      // Idle владеет хранилищем как рабочий процесс, пока автоматический цикл ещё не реализован.
      await new Promise<void>((resolve) => {
        const keepAlive = setInterval(() => {}, 2_147_483_647);
        const stop = () => {
          clearInterval(keepAlive);
          process.removeListener('SIGINT', stop);
          process.removeListener('SIGTERM', stop);
          resolve();
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        console.log(JSON.stringify({ event: 'started', mode: 'idle' }));
      });
    } finally { database.close(); }
    console.log(JSON.stringify({ event: 'stopped' }));
    return 0;
  } finally { release(); }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(JSON.stringify({ event: 'error', message: error instanceof Error ? error.message : 'Ошибка запуска' }));
  process.exitCode = 1;
}
