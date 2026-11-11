import { networkRetryDelay } from './core/retry.ts';
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
      this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      this.#transaction(() => {
        const version = this.#database.prepare('PRAGMA user_version').get()!.user_version;
        if (version !== 0 && version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5) throw new Error('Неподдерживаемая версия хранилища');
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
        if (Number(version) < 5) this.#database.exec(`
          CREATE TABLE max_attempts (
            id TEXT PRIMARY KEY, queue_id INTEGER NOT NULL REFERENCES queue(id),
            channel_url TEXT NOT NULL, image_sha256 TEXT NOT NULL, scheduled_at TEXT NOT NULL,
            started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, evidence TEXT, error TEXT
          );
          PRAGMA user_version = 5;
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

  /** Захватывает только безопасное ready и сохраняет предварительное назначение. */
  prepareMax(id: number, channelUrl: string, scheduledAt: string) {
    let image: { path: string; sha256: string; mime: string } | undefined;
    this.#transaction(() => {
      const board = this.#database.prepare('SELECT channel_url FROM board_state WHERE id = 1').get();
      if (board?.channel_url !== channelUrl) throw new Error('MAX: канал хранилища не подтверждён.');
      const job = this.#database.prepare(`SELECT queue.*, images.path, images.mime FROM queue
        JOIN images ON images.sha256 = queue.image_sha256 WHERE queue.id = ?`).get(id);
      if (!job || job.status !== 'ready' || job.max_post_url
        || this.#database.prepare('SELECT 1 FROM max_attempts WHERE queue_id = ?').get(id)
        || job.next_attempt_at && Date.parse(String(job.next_attempt_at)) > Date.now()) throw new Error('MAX: задание не готово к безопасной отправке.');

      this.#database.prepare(`INSERT INTO queue_events (queue_id, occurred_at, action, previous_state)
        VALUES (?, ?, 'prepare-max', ?)`).run(id, new Date().toISOString(), JSON.stringify(job));
      this.#database.prepare("UPDATE queue SET status = 'preparing', scheduled_at = ? WHERE id = ?").run(scheduledAt, id);
      image = { path: join(this.#directory, String(job.path)), sha256: String(job.image_sha256), mime: String(job.mime) };
    });

    return image!;
  }

  /** Надёжно сохраняет намерение вместе с submitting до единственного возможного создания. */
  beginMaxAttempt(id: number, channelUrl: string, sha256: string, scheduledAt: string): string {
    const attempt = randomUUID();
    this.#transaction(() => {
      const changed = this.#database.prepare(`UPDATE queue SET status = 'submitting'
        WHERE id = ? AND status = 'preparing' AND image_sha256 = ? AND scheduled_at = ?`).run(id, sha256, scheduledAt);
      if (changed.changes !== 1) throw new Error('MAX: намерение не соответствует подготовленному заданию.');

      this.#database.prepare(`INSERT INTO max_attempts
        (id, queue_id, channel_url, image_sha256, scheduled_at, started_at, status)
        VALUES (?, ?, ?, ?, ?, ?, 'submitting')`).run(attempt, id, channelUrl, sha256, scheduledAt, new Date().toISOString());
    });

    return attempt;
  }

  /** Читает только неопределённую попытку, связанную с текущим назначением и файлом задания. */
  maxReconciliation(id: number, channelUrl: string) {
    const rows = this.#database.prepare(`SELECT max_attempts.id AS attempt, queue.scheduled_at, queue.image_sha256, images.path, images.mime
      FROM queue JOIN images ON images.sha256 = queue.image_sha256
      JOIN max_attempts ON max_attempts.queue_id = queue.id AND max_attempts.status = 'uncertain'
        AND max_attempts.image_sha256 = queue.image_sha256 AND max_attempts.scheduled_at = queue.scheduled_at
      JOIN board_state ON board_state.id = 1 AND board_state.channel_url = max_attempts.channel_url
      WHERE queue.id = ? AND queue.status = 'uncertain' AND max_attempts.channel_url = ?`).all(id, channelUrl);
    if (rows.length !== 1) throw new Error('MAX: нет единственной связанной неопределённой попытки.');
    const row = rows[0]!;

    return { attempt: String(row.attempt), scheduledAt: String(row.scheduled_at), sha256: String(row.image_sha256), path: join(this.#directory, String(row.path)), mime: String(row.mime) };
  }

  /** Сохраняет исход и доказательства, не теряя файл и прежние попытки. */
  finishMax(id: number, status: 'ready' | 'failed' | 'uncertain' | 'scheduled', error: string | null, attempt?: string, evidence?: string) {
    this.#transaction(() => {
      const state = this.#database.prepare('SELECT * FROM queue WHERE id = ?').get(id);
      if (status === 'scheduled' && !evidence) throw new Error('MAX: подтверждение требует доказательств создания поста.');
      const reconciling = state?.status === 'uncertain' && status === 'scheduled' && !!attempt && !!evidence;
      if (!state || (attempt ? state.status !== 'submitting' && !reconciling : state.status !== 'preparing')) throw new Error('MAX: недопустимое завершение отправки.');
      if (attempt && !['scheduled', 'uncertain'].includes(status)) throw new Error('MAX: возможное создание требует сверки.');
      if (!attempt && ['scheduled', 'uncertain'].includes(status)) throw new Error('MAX: отсутствует намерение отправки.');

      this.#database.prepare(`INSERT INTO queue_events (queue_id, occurred_at, action, previous_state)
        VALUES (?, ?, ?, ?)`).run(id, new Date().toISOString(), `max-${status}`, JSON.stringify(state));
      if (attempt) {
        const changed = this.#database.prepare(`UPDATE max_attempts SET status = ?, finished_at = ?, error = ?, evidence = ?
          WHERE id = ? AND queue_id = ? AND status = ? AND image_sha256 = ? AND scheduled_at = ?
            AND channel_url = (SELECT channel_url FROM board_state WHERE id = 1)`).run(status, new Date().toISOString(), error, evidence ?? null, attempt, id, state.status!, state.image_sha256!, state.scheduled_at!);
        if (changed.changes !== 1) throw new Error('MAX: попытка отправки не найдена.');
      }
      this.#database.prepare('UPDATE queue SET status = ?, error = ?, next_attempt_at = NULL WHERE id = ?').run(status, error, id);
    });
  }

  /** Откладывает только доказанный сетевой отказ до намерения; история ограничивает число повторов. */
  deferMaxNetworkRetry(id: number, intervalMs: number): void {
    this.#transaction(() => {
      const state = this.#database.prepare(`SELECT * FROM queue WHERE id = ? AND status = 'failed'
        AND max_post_url IS NULL AND next_attempt_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM max_attempts WHERE queue_id = queue.id)`).get(id);
      if (!state) throw new Error('MAX: сетевой повтор допустим только до намерения отправки.');
      const count = this.#database.prepare("SELECT COUNT(*) AS count FROM queue_events WHERE queue_id = ? AND action = 'max-network-delay'").get(id)!;
      const delay = networkRetryDelay(intervalMs, Number(count.count) + 1);
      if (delay === null) return;

      this.#database.prepare(`INSERT INTO queue_events (queue_id, occurred_at, action, previous_state)
        VALUES (?, ?, 'max-network-delay', ?)`).run(id, new Date().toISOString(), JSON.stringify(state));
      this.#database.prepare('UPDATE queue SET next_attempt_at = ? WHERE id = ?').run(new Date(Date.now() + delay).toISOString(), id);
    });
  }

  /** Возвращает наступившие сетевые отказы в FIFO, сохраняя причину и защищая любые внешние попытки. */
  resumeMaxNetworkRetries(): void {
    this.#transaction(() => {
      const due = this.#database.prepare(`SELECT * FROM queue WHERE status = 'failed' AND max_post_url IS NULL
        AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
        AND EXISTS (SELECT 1 FROM queue_events WHERE queue_id = queue.id AND action = 'max-network-delay')
        AND NOT EXISTS (SELECT 1 FROM max_attempts WHERE queue_id = queue.id)`).all(new Date(Date.now()).toISOString());
      for (const state of due) {
        this.#database.prepare(`INSERT INTO queue_events (queue_id, occurred_at, action, previous_state)
          VALUES (?, ?, 'max-network-retry', ?)`).run(state.id!, new Date().toISOString(), JSON.stringify(state));
        this.#database.prepare("UPDATE queue SET status = 'ready', next_attempt_at = NULL WHERE id = ?").run(state.id!);
      }
    });
  }

  /** Атомарно снимает захваты погибшего владельца; любое намерение остаётся только для сверки. */
  recoverMaxInterrupted(): void {
    this.#transaction(() => {
      const interrupted = this.#database.prepare("SELECT * FROM queue WHERE status IN ('preparing', 'submitting')").all();
      for (const state of interrupted) {
        const attempts = this.#database.prepare('SELECT * FROM max_attempts WHERE queue_id = ?').all(state.id!);
        const status = state.status === 'preparing' && !state.max_post_url && attempts.length === 0 ? 'ready' : 'uncertain';
        const now = new Date().toISOString();
        this.#database.prepare(`INSERT INTO queue_events (queue_id, occurred_at, action, previous_state)
          VALUES (?, ?, 'max-recovery', ?)`).run(state.id!, now, JSON.stringify(state));
        this.#database.prepare(`UPDATE max_attempts SET status = 'uncertain', finished_at = ?
          WHERE queue_id = ? AND status = 'submitting'`).run(now, state.id!);
        this.#database.prepare(`UPDATE queue SET status = ?, scheduled_at = ?, next_attempt_at = NULL WHERE id = ?`)
          .run(status, status === 'ready' ? null : state.scheduled_at!, state.id!);
      }
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
    if (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5) {
      throw new Error('Хранилище очереди ещё не инициализировано или его версия не поддерживается');
    }
    database.exec('BEGIN');
    const items = database.prepare(`SELECT queue.*, pins.url AS source_url, pins.image_url,
      images.path, images.mime, images.bytes, images.width, images.height
      FROM queue JOIN pins ON pins.id = queue.pin_id JOIN images ON images.sha256 = queue.image_sha256
      ORDER BY queue.added_at, queue.id`).all();
    const nextReadyId = nextReadyJob(items as unknown as QueueState[], new Date());
    const queueEvents = version >= 4 ? database.prepare('SELECT * FROM queue_events ORDER BY id').all() : [];
    const maxAttempts = version >= 5 ? database.prepare('SELECT * FROM max_attempts ORDER BY started_at, id').all() : [];
    const sources = database.prepare('SELECT * FROM pins ORDER BY first_seen_at, id').all();
    const history = version >= 2 ? {
      board: database.prepare('SELECT * FROM board_state').get(),
      ...(version >= 3 ? { backfillRuns: database.prepare('SELECT * FROM backfill_runs ORDER BY started_at, id').all() } : {}),
      bootstrapRuns: database.prepare('SELECT * FROM bootstrap_runs ORDER BY started_at, id').all(),
    } : {};
    database.exec('COMMIT');

    return { event: 'queue-list', items, sources, nextReadyId, queueEvents, maxAttempts, ...history };
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
