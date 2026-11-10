import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nextReadyJob, QueueJob, type QueueState } from './core/queue.ts';

/** Снимок подтверждённого источника для записи, без зависимости от браузера. */
export interface ImportSource {
  id: string;
  url: string;
  signature?: string;
  imageUrls?: string[];
  imageError?: string;
}

/** Результат подготовки файла до начала транзакции хранения. */
export type ImportImage = { status: 'failed'; id: string; imageUrl: string | null; reason: string } | {
  status: 'ready'; id: string; imageUrl: string; path: string; sha256: string;
  mime: string; bytes: number; width: number; height: number;
};

/** Сохраняет источники отдельно от файлов, связывая готовый файл и задание атомарно. */
export class ImportStorage {
  #database: DatabaseSync;
  #directory: string;

  constructor(directory: string, boardUrl?: string) {
    if (!boardUrl && !existsSync(join(directory, 'state.sqlite'))) throw new Error('Хранилище очереди ещё не инициализировано');
    this.#directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(join(directory, 'state.sqlite'));
    try {
      this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
      this.#transaction(() => {
        const version = this.#database.prepare('PRAGMA user_version').get()!.user_version;
        if (version !== 0 && version !== 1 && version !== 2 && version !== 3 && version !== 4) throw new Error('Неподдерживаемая версия хранилища');
        if (version === 0) this.#database.exec(`
          CREATE TABLE board_state (
            id INTEGER PRIMARY KEY CHECK (id = 1), board_url TEXT NOT NULL, channel_url TEXT,
            initialized INTEGER NOT NULL DEFAULT 0, last_full_sync_at TEXT
          );
          CREATE TABLE images (
            sha256 TEXT PRIMARY KEY, path TEXT NOT NULL, mime TEXT NOT NULL,
            bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL
          );
          CREATE TABLE pins (
            id TEXT PRIMARY KEY, url TEXT NOT NULL, signature TEXT, image_urls TEXT NOT NULL,
            image_url TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
            image_sha256 TEXT REFERENCES images(sha256), status TEXT NOT NULL, error TEXT
          );
          CREATE TABLE queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT, pin_id TEXT NOT NULL UNIQUE REFERENCES pins(id),
            image_sha256 TEXT NOT NULL UNIQUE REFERENCES images(sha256), added_at TEXT NOT NULL,
            status TEXT NOT NULL, scheduled_at TEXT, next_attempt_at TEXT, error TEXT, max_post_url TEXT
          );
          PRAGMA user_version = 1;
        `);
        if (version === 0 || version === 1) this.#database.exec(`
          ALTER TABLE pins ADD COLUMN classification TEXT NOT NULL DEFAULT 'candidate'
            CHECK (classification IN ('baseline', 'candidate'));
          CREATE TABLE bootstrap_runs (
            id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
            status TEXT NOT NULL, observed INTEGER NOT NULL DEFAULT 0,
            expected_count INTEGER, reason TEXT
          );
          PRAGMA user_version = 2;
        `);
        if (Number(version) < 3) this.#database.exec(`
          CREATE TABLE backfill_runs (
            id TEXT PRIMARY KEY, requested_count INTEGER NOT NULL, accepted_count INTEGER NOT NULL DEFAULT 0,
            started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL,
            observed INTEGER NOT NULL DEFAULT 0, expected_count INTEGER, reason TEXT
          );
          PRAGMA user_version = 3;
        `);
        if (Number(version) < 4) this.#database.exec(`
          CREATE TABLE queue_events (
            id INTEGER PRIMARY KEY, queue_id INTEGER NOT NULL REFERENCES queue(id),
            occurred_at TEXT NOT NULL, action TEXT NOT NULL, previous_state TEXT NOT NULL
          );
          PRAGMA user_version = 4;
        `);
        const board = this.#database.prepare('SELECT board_url FROM board_state WHERE id = 1').get();
        if (boardUrl && board && board.board_url !== boardUrl) throw new Error('Доска хранилища не совпадает с PINTEREST_BOARD_URL; используйте другой DATA_DIR');
        if (!board && !boardUrl) throw new Error('Хранилище не содержит доску');
        if (boardUrl) this.#database.prepare('INSERT INTO board_state (id, board_url) VALUES (1, ?) ON CONFLICT DO NOTHING').run(boardUrl);
      });
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  /** Привязывает проверенный через UI канал, не разрешая смену существующей привязки. */
  bindChannel(channelUrl: string) {
    this.#transaction(() => {
      const board = this.#database.prepare('SELECT channel_url FROM board_state WHERE id = 1').get()!;
      if (board.channel_url && board.channel_url !== channelUrl) throw new Error('Канал хранилища не совпадает с MAX_CHANNEL_URL; используйте другой DATA_DIR');

      this.#database.prepare('UPDATE board_state SET channel_url = ? WHERE id = 1').run(channelUrl);
    });
  }

  /** Фиксирует все прочитанные источники, включая ошибочные и ещё не обработанные. */
  sources(sources: ImportSource[]) {
    this.#transaction(() => this.#sources(sources, 'candidate'));
  }

  #sources(sources: ImportSource[], classification: 'baseline' | 'candidate') {
    const now = new Date().toISOString();
    const insert = this.#database.prepare(`INSERT INTO pins
        (id, url, signature, image_urls, first_seen_at, last_seen_at, status, error, classification)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
        url = excluded.url, signature = excluded.signature, image_urls = excluded.image_urls,
        last_seen_at = excluded.last_seen_at`);
    for (const source of sources) insert.run(source.id, source.url, source.signature ?? null,
      JSON.stringify(source.imageUrls ?? []), now, now, source.imageError ? 'failed' : 'discovered', source.imageError ?? null, classification);
  }

  /** Исключает историю и уже импортированные пины из обычного скачивания. */
  imported(id: string, backfill = false): boolean {
    if (backfill) return !!this.#database.prepare(`SELECT 1 FROM pins WHERE id = ? AND
      (EXISTS (SELECT 1 FROM queue WHERE pin_id = pins.id) OR
       EXISTS (SELECT 1 FROM queue WHERE image_sha256 = pins.image_sha256))`).get(id);

    return !!this.#database.prepare("SELECT 1 FROM pins WHERE id = ? AND (image_sha256 IS NOT NULL OR classification = 'baseline')").get(id);
  }

  /** Не сбрасывает уже сохранённое задание при повторном импорте. */
  image(image: ImportImage, backfillId?: string) {
    this.#transaction(() => {
      if (image.status === 'failed') {
        this.#database.prepare(`UPDATE pins SET image_url = ?, status = 'failed', error = ?
          WHERE id = ? AND image_sha256 IS NULL`).run(image.imageUrl, image.reason, image.id);
        return;
      }
      if (backfillId) {
        const run = this.backfill(backfillId);
        if (run.acceptedCount >= run.requestedCount) return;
      }

      this.#database.prepare(`INSERT INTO images (sha256, path, mime, bytes, width, height)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(image.sha256,
        relative(this.#directory, image.path), image.mime, image.bytes, image.width, image.height);
      this.#database.prepare(`UPDATE pins SET image_sha256 = ?, image_url = ?, status = 'ready', error = NULL
        WHERE id = ? AND image_sha256 IS NULL`).run(image.sha256, image.imageUrl, image.id);
      const inserted = this.#database.prepare(`INSERT INTO queue (pin_id, image_sha256, added_at, status)
        SELECT id, image_sha256, ?, 'ready' FROM pins WHERE id = ?
        ON CONFLICT DO NOTHING`).run(new Date().toISOString(), image.id);
      if (backfillId && inserted.changes) this.#database.prepare(
        'UPDATE backfill_runs SET accepted_count = accepted_count + 1 WHERE id = ?').run(backfillId);
    });
  }

  /** Требует явного завершения первоначальной политики до обычного импорта. */
  requireInitialized() {
    if (!this.#database.prepare('SELECT initialized FROM board_state WHERE id = 1').get()!.initialized) {
      throw new Error('История доски не инициализирована: выполните bootstrap или первоначальный backfill.');
    }
  }

  /** Начинает явный обход истории; незавершённая операция не разрешает обычный импорт. */
  beginBootstrap(): string {
    const id = randomUUID();
    this.#database.prepare(`INSERT INTO bootstrap_runs (id, started_at, status) VALUES (?, ?, 'running')`)
      .run(id, new Date().toISOString());

    return id;
  }

  /** Атомарно сохраняет прочитанные источники и прогресс, не меняя существующие задания. */
  bootstrapProgress(id: string, sources: ImportSource[], expectedCount: number | null) {
    this.#transaction(() => {
      this.#sources(sources, 'baseline');
      this.#database.prepare('UPDATE bootstrap_runs SET observed = ?, expected_count = ? WHERE id = ?')
        .run(sources.length, expectedCount, id);
    });
  }

  /** Подтверждает инициализацию только после доказанного полного обхода. */
  finishBootstrap(id: string, complete: boolean, reason: string) {
    this.#transaction(() => {
      const now = new Date().toISOString();
      this.#database.prepare('UPDATE bootstrap_runs SET status = ?, reason = ?, finished_at = ? WHERE id = ?')
        .run(complete ? 'complete' : 'incomplete', reason, now, id);
      if (complete) this.#database.prepare('UPDATE board_state SET initialized = 1, last_full_sync_at = ? WHERE id = 1').run(now);
    });
  }

  /** Создаёт порцию истории либо проверяет исходный лимит возобновляемой операции. */
  beginBackfill(count: number, resume?: string) {
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error('Количество backfill должно быть положительным целым');
    if (resume) {
      const run = this.backfill(resume);
      if (run.requestedCount !== count) throw new Error('Количество --count не совпадает с исходным лимитом backfill');

      return run;
    }
    const id = randomUUID();
    this.#database.prepare(`INSERT INTO backfill_runs (id, requested_count, started_at, status) VALUES (?, ?, ?, 'running')`)
      .run(id, count, new Date().toISOString());

    return this.backfill(id);
  }

  /** Возвращает сохранённый лимит и число атомарно принятых заданий. */
  backfill(id: string) {
    const run = this.#database.prepare('SELECT requested_count, accepted_count FROM backfill_runs WHERE id = ?').get(id);
    if (!run) throw new Error('Операция backfill не найдена');

    return { id, requestedCount: Number(run.requested_count), acceptedCount: Number(run.accepted_count) };
  }

  /** Сохраняет полный исторический набор даже после достижения лимита порции. */
  backfillProgress(id: string, sources: ImportSource[], expectedCount: number | null) {
    this.#transaction(() => {
      this.#sources(sources, 'baseline');
      this.#database.prepare('UPDATE backfill_runs SET observed = ?, expected_count = ? WHERE id = ?')
        .run(sources.length, expectedCount, id);
    });
  }

  /** Полный обход подтверждает историю независимо от недобора подходящих файлов. */
  finishBackfill(id: string, traversalComplete: boolean, complete: boolean, reason: string) {
    this.#transaction(() => {
      const now = new Date().toISOString();
      this.#database.prepare('UPDATE backfill_runs SET status = ?, reason = ?, finished_at = ? WHERE id = ?')
        .run(complete ? 'complete' : 'incomplete', reason, now, id);
      if (traversalComplete) this.#database.prepare('UPDATE board_state SET initialized = 1, last_full_sync_at = ? WHERE id = 1').run(now);
    });
  }

  /** Меняет свободное задание атомарно с сохранением исходного состояния и ошибок. */
  changeQueue(id: number, action: 'skip' | 'retry') {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('ID задания должен быть положительным целым');

    this.#transaction(() => {
      const state = this.#database.prepare('SELECT * FROM queue WHERE id = ?').get(id);
      if (!state) throw new Error('Задание очереди не найдено');
      const job = new QueueJob(state as unknown as QueueState);
      const status = action === 'skip' ? job.skip() : job.retry();

      this.#database.prepare(`INSERT INTO queue_events (queue_id, occurred_at, action, previous_state)
        VALUES (?, ?, ?, ?)`).run(id, new Date().toISOString(), action, JSON.stringify(state));
      this.#database.prepare('UPDATE queue SET status = ?, next_attempt_at = NULL WHERE id = ?').run(status, id);
    });
  }

  /** Закрывает соединение после завершения импорта. */
  close() { this.#database.close(); }

  #transaction(action: () => void) {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      action();
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }
}

/** Читает согласованный снимок без создания БД, миграции или браузерного профиля. */
export function listQueue(directory: string) {
  const database = new DatabaseSync(join(directory, 'state.sqlite'), { readOnly: true });
  try {
    const version = database.prepare('PRAGMA user_version').get()!.user_version;
    if (version !== 1 && version !== 2 && version !== 3 && version !== 4) {
      throw new Error('Хранилище очереди ещё не инициализировано или его версия не поддерживается');
    }
    database.exec('BEGIN');
    const items = database.prepare(`SELECT queue.*, pins.url AS source_url, pins.image_url,
      images.path, images.mime, images.bytes, images.width, images.height
      FROM queue JOIN pins ON pins.id = queue.pin_id JOIN images ON images.sha256 = queue.image_sha256
      ORDER BY queue.added_at, queue.id`).all();
    const nextReadyId = nextReadyJob(items as unknown as QueueState[], new Date());
    const queueEvents = version >= 4 ? database.prepare('SELECT * FROM queue_events ORDER BY id').all() : [];
    const sources = database.prepare('SELECT * FROM pins ORDER BY first_seen_at, id').all();
    const history = version >= 2 ? {
      board: database.prepare('SELECT * FROM board_state').get(),
      ...(version >= 3 ? { backfillRuns: database.prepare('SELECT * FROM backfill_runs ORDER BY started_at, id').all() } : {}),
      bootstrapRuns: database.prepare('SELECT * FROM bootstrap_runs ORDER BY started_at, id').all(),
    } : {};
    database.exec('COMMIT');

    return { event: 'queue-list', items, sources, nextReadyId, queueEvents, ...history };
  } finally { database.close(); }
}

/** Читает прежнюю доску и запрещает смену канала до браузера и изменения хранилища. */
export function channelBoard(directory: string, channelUrl: string): string | undefined {
  if (!existsSync(join(directory, 'state.sqlite'))) return undefined;

  const database = new DatabaseSync(join(directory, 'state.sqlite'), { readOnly: true });
  try {
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'board_state'").get()) return undefined;

    const board = database.prepare('SELECT board_url, channel_url FROM board_state WHERE id = 1').get();
    if (board?.channel_url && board.channel_url !== channelUrl) throw new Error('Канал хранилища не совпадает с MAX_CHANNEL_URL; используйте другой DATA_DIR');

    return board?.board_url as string | undefined;
  } finally { database.close(); }
}
