/** Ограничивает сетевые повторы и таймер; успешный цикл начинает новую серию. */
export class RetryDelay {
  #failures = 0;
  #intervalMs: number;
  constructor(intervalMs: number) { this.#intervalMs = intervalMs; }

  /** Сбрасывает серию после безопасно завершённого цикла. */
  success(): void { this.#failures = 0; }

  /** Даёт следующую задержку либо требует ручного восстановления после пяти повторов. */
  next(): number | null {
    this.#failures++;
    return networkRetryDelay(this.#intervalMs, this.#failures);
  }
}

/** Рассчитывает ограниченную серию безопасных повторов без зависимости от часов. */
export function networkRetryDelay(intervalMs: number, failures: number): number | null {
  if (failures > 5) return null;

  const base = Math.max(intervalMs, 5_000);
  return Math.min(2_147_483_647, base * 2 ** Math.min(failures - 1, 4));
}
