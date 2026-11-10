import { resolve } from 'node:path';

/** Описывает только реализованные команды и их влияние на данные. */
export const help = `Использование: npm start -- [команда]
  --help          Показать справку без открытия хранилища.
  auth pinterest  Ручной вход в видимом браузере и проверка доски;
                  сохраняет только профиль DATA_DIR/profiles/pinterest.
  auth max        Ручной вход в отдельном профиле MAX, проверка канала и прав;
                  привязка MAX_CHANNEL_URL после проверки, без создания постов.
  bootstrap       Полный обход истории без скачивания и добавления заданий;
                  только завершённый обход разрешает обычную синхронизацию.
  sync [--full]   Полный обход, скачивание изображений и сохранение очереди;
                  источники и результаты — DATA_DIR/diagnostics/sync-*/.
                  Неполный обход или ошибки материалов дают ненулевой код.
  backfill --count N [--resume ID]  Добавить N уникальных изображений истории;
                  --resume продолжает исходный сохранённый запрос.
  queue skip ID   Пропустить неотправленное ready/failed; файл и история сохраняются.
  queue retry ID  Повторить failed без созданного поста с прежним порядком;
                  preparing/submitting/scheduled запрещены, uncertain требует сверки.
  queue list      Снимок очереди и источников без изменения данных и браузера.
Без команды: прежний режим idle до SIGINT/SIGTERM.
Настройки Pinterest: DATA_DIR, PINTEREST_BOARD_URL (https://ru.pinterest.com/mixi56453/max7),
PINTEREST_BROWSER_CHANNEL (chromium по умолчанию; chrome — явный выбор Google Chrome).
Настройки MAX: MAX_CHANNEL_URL (обязателен), MAX_BROWSER_CHANNEL (chromium или chrome).
Пароли и коды вводятся только на сайте, CLI их не запрашивает.
При занятом профиле сначала остановите использующий его процесс.`;

/** Проверяет команду до создания файлов и запуска браузера. */
export function parseCommand(args: string[]): 'idle' | 'help' | 'auth-pinterest' | 'auth-max' | 'sync' | 'sync-full' | 'bootstrap' | 'queue-list' | { mode: 'queue-change'; action: 'skip' | 'retry'; id: number } | { mode: 'backfill'; count: number; resume?: string } {
  if (args.length === 0) return 'idle';
  if (args.length === 1 && args[0] === '--help') return 'help';
  if (args.length === 2 && args[0] === 'auth' && args[1] === 'max') return 'auth-max';
  if (args.length === 2 && args[0] === 'auth' && args[1] === 'pinterest') return 'auth-pinterest';
  if (args.length === 2 && args[0] === 'queue' && args[1] === 'list') return 'queue-list';
  if (args.length === 1 && args[0] === 'bootstrap') return 'bootstrap';
  if (args.length === 1 && args[0] === 'sync') return 'sync';
  if (args.length === 2 && args[0] === 'sync' && args[1] === '--full') return 'sync-full';

  if (args[0] === 'queue' && (args[1] === 'skip' || args[1] === 'retry')) {
    if (args.length !== 3 || !/^[1-9]\d*$/.test(args[2] ?? '') || !Number.isSafeInteger(Number(args[2]))) {
      throw new Error('queue skip/retry требует положительный целый ID задания');
    }

    return { mode: 'queue-change', action: args[1], id: Number(args[2]) };
  }

  if (args[0] === 'backfill') {
    const options = args.slice(1);
    if ((options.length !== 2 && options.length !== 4) || options[0] !== '--count'
      || !/^[1-9]\d*$/.test(options[1] ?? '') || !Number.isSafeInteger(Number(options[1]))
      || (options.length === 4 && (options[2] !== '--resume' || !options[3]?.trim()))) {
      throw new Error('backfill требует положительное целое --count N и необязательный --resume ID');
    }

    return { mode: 'backfill', count: Number(options[1]), ...(options[3] ? { resume: options[3] } : {}) };
  }

  throw new Error('Неизвестная команда. Используйте --help.');
}

/** Проверяет только настройки Pinterest; настройки MAX не требуются. */
export function pinterestConfiguration(env: NodeJS.ProcessEnv) {
  const directory = env.DATA_DIR ?? './data';
  if (!directory.trim()) throw new Error('DATA_DIR должен содержать путь к каталогу');

  let board: URL;
  try {
    board = new URL(env.PINTEREST_BOARD_URL ?? 'https://ru.pinterest.com/mixi56453/max7');
  } catch {
    throw new Error('PINTEREST_BOARD_URL должен быть HTTPS-адресом доски Pinterest');
  }
  const segments = board.pathname.split('/').filter(Boolean);
  if (board.protocol !== 'https:' || !['pinterest.com', 'www.pinterest.com', 'ru.pinterest.com'].includes(board.hostname)
    || board.port || board.username || board.password || board.search || board.hash
    || segments.length !== 2 || !segments.every((segment) => /^[\w-]+$/.test(segment))
    || ['pin', 'search', 'ideas', 'login', 'settings', 'business'].includes(segments[0] ?? '')) {
    throw new Error('PINTEREST_BOARD_URL должен быть HTTPS-адресом доски Pinterest без параметров');
  }

  const channel = env.PINTEREST_BROWSER_CHANNEL ?? 'chromium';
  if (channel !== 'chromium' && channel !== 'chrome') {
    throw new Error('PINTEREST_BROWSER_CHANNEL: допустимы chromium или chrome');
  }
  board.pathname = `/${segments.join('/')}/`;

  return { dataDirectory: resolve(directory), boardUrl: board.href, channel };
}

/** Проверяет явный канал MAX независимо от настроек браузера Pinterest. */
export function maxConfiguration(env: NodeJS.ProcessEnv) {
  const directory = env.DATA_DIR ?? './data';
  if (!directory.trim()) throw new Error('DATA_DIR должен содержать путь к каталогу');
  if (!env.MAX_CHANNEL_URL?.trim()) throw new Error('MAX_CHANNEL_URL обязателен для auth max');

  let target: URL;
  try {
    target = new URL(env.MAX_CHANNEL_URL);
  } catch {
    throw new Error('MAX_CHANNEL_URL должен быть HTTPS-адресом канала MAX');
  }
  if (target.protocol !== 'https:' || target.hostname !== 'max.ru'
    || target.port || target.username || target.password || target.search || target.hash
    || !/^\/[\w-]+\/?$/.test(target.pathname)) {
    throw new Error('MAX_CHANNEL_URL должен быть HTTPS-адресом канала max.ru без параметров');
  }
  const channel = env.MAX_BROWSER_CHANNEL ?? 'chromium';
  if (channel !== 'chromium' && channel !== 'chrome') {
    throw new Error('MAX_BROWSER_CHANNEL: допустимы chromium или chrome');
  }
  target.pathname = target.pathname.replace(/\/$/, '');

  return { dataDirectory: resolve(directory), channelUrl: target.href, channel };
}
