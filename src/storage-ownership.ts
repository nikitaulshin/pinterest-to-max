import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Удерживает отдельную эксклюзивную SQLite-транзакцию; ОС снимает захват при смерти процесса. */
export function acquireStorageOwnership(directory: string): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(join(directory, 'worker-lock.sqlite'));

  try {
    database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');
  } catch (error) {
    database.close();
    if (error instanceof Error && 'errcode' in error && error.errcode === 5) {
      throw new Error('Хранилище занято другим процессом. Остановите его перед изменением данных или авторизацией.', { cause: error });
    }

    throw error;
  }

  // Закрытие откатывает транзакцию; файл сохраняется, чтобы все процессы блокировали один inode.
  return () => { database.close(); };
}
