/** Состояние задания, необходимое для безопасного выбора и ручного перехода. */
export interface QueueState {
  id: number;
  added_at: string;
  status: string;
  next_attempt_at: string | null;
  max_post_url: string | null;
}

/** Не допускает ручной возврат заданий, которые могли создать внешний пост. */
export class QueueJob {
  #state: QueueState;

  constructor(state: QueueState) { this.#state = state; }

  /** Пропускает только свободное, достоверно не отправленное задание. */
  skip(): 'skipped' {
    if (!['ready', 'failed'].includes(this.#state.status) || this.#state.max_post_url) {
      throw new Error('Пропуск разрешён только для неотправленного ready/failed задания');
    }

    return 'skipped';
  }

  /** Возвращает определённый отказ к безопасной подготовке; сверка не подменяется повтором. */
  retry(): 'ready' {
    if (this.#state.status !== 'failed' || this.#state.max_post_url) {
      throw new Error('Повтор разрешён только для failed без созданного поста; uncertain требует сверки с MAX');
    }

    return 'ready';
  }
}

/** Возвращает FIFO безопасных ready с наступившим временем повтора, не меняя снимок. */
export function readyJobs<T extends QueueState>(states: T[], now: Date): T[] {
  const ready = states.filter((state) => state.status === 'ready' && !state.max_post_url
    && (state.next_attempt_at === null || Date.parse(state.next_attempt_at) <= now.getTime()));
  ready.sort((a, b) => a.added_at.localeCompare(b.added_at) || a.id - b.id);

  return ready;
}

/** Выбирает FIFO среди безопасных ready с наступившим временем повтора. */
export function nextReadyJob(states: QueueState[], now: Date): number | null {
  return readyJobs(states, now)[0]?.id ?? null;
}
