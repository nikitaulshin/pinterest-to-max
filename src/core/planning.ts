import { readyJobs, type QueueState } from './queue.ts';

const moscowOffsetMs = 3 * 60 * 60 * 1000;

/** Рассчитывает будущие ежедневные слоты современного московского календаря. */
export class PublicationSchedule {
  #minutes: number[];
  #horizonDays: number;

  constructor(slots: string[], horizonDays = 14) {
    if (slots.length === 0 || slots.some((slot) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot))
      || new Set(slots).size !== slots.length) {
      throw new Error('PUBLICATION_SLOTS: нужен непустой список уникальных времён HH:mm');
    }
    if (!Number.isSafeInteger(horizonDays) || horizonDays <= 0) {
      throw new Error('PLANNING_HORIZON_DAYS должен быть положительным целым числом');
    }

    this.#minutes = slots.map((slot) => Number(slot.slice(0, 2)) * 60 + Number(slot.slice(3))).sort((a, b) => a - b);
    this.#horizonDays = horizonDays;
  }

  /** Возвращает UTC-даты до включительной границы горизонта; запас задаётся в миллисекундах. */
  *futureSlots(now: Date, minimumLeadMs = 0): IterableIterator<Date> {
    const nowTime = now.getTime();
    if (!Number.isFinite(nowTime)) throw new Error('Момент расчёта должен быть допустимой датой');
    if (!Number.isSafeInteger(minimumLeadMs) || minimumLeadMs < 0) {
      throw new Error('Минимальный запас времени должен быть неотрицательным целым числом миллисекунд');
    }

    // shortcut: современная Москва использует UTC+3; при изменении зоны пересмотреть календарь.
    const day = new Date(nowTime + moscowOffsetMs);
    const horizon = new Date(day);
    horizon.setUTCDate(horizon.getUTCDate() + this.#horizonDays);
    if (!Number.isFinite(horizon.getTime())) throw new Error('PLANNING_HORIZON_DAYS выходит за диапазон дат');

    const end = horizon.getTime() - moscowOffsetMs;
    const earliest = nowTime + minimumLeadMs;
    day.setUTCHours(0, 0, 0, 0);
    while (day.getTime() - moscowOffsetMs <= end) {
      for (const minutes of this.#minutes) {
        const time = day.getTime() + minutes * 60 * 1000 - moscowOffsetMs;
        if (time > nowTime && time >= earliest && time <= end) yield new Date(time);
      }

      day.setUTCDate(day.getUTCDate() + 1);
    }
  }
}

/** Сопоставляет FIFO со свободными минутами полного снимка MAX, ничего не сохраняя. */
export class PublicationPlanner {
  #schedule: PublicationSchedule;
  #effectiveLimit: number;

  /** Подтверждённый лимит MAX — 100; новое более строгое ограничение передаётся явно. */
  constructor(schedule: PublicationSchedule, configuredLimit: number, platformLimit: number | null = 100) {
    if (!Number.isSafeInteger(configuredLimit) || configuredLimit <= 0) {
      throw new Error('MAX_SCHEDULED_LIMIT должен быть положительным целым числом');
    }
    if (platformLimit === null || !Number.isSafeInteger(platformLimit) || platformLimit <= 0) {
      throw new Error('MAX: обязательный лимит отложки не подтверждён');
    }

    this.#schedule = schedule;
    this.#effectiveLimit = Math.min(configuredLimit, platformLimit, 100);
  }

  /** Принимает только полный актуальный снимок проверенного канала; неизвестные отправки считает отдельно. */
  plan(options: {
    queue: (QueueState & { scheduled_at: string | null })[];
    snapshot: { channelUrl: string; posts: { scheduledAt: string }[] };
    channelUrl: string;
    now: Date;
    minimumLeadMs?: number;
  }) {
    const { queue, snapshot, channelUrl, now } = options;
    if (!channelUrl || snapshot.channelUrl !== channelUrl) throw new Error('MAX: снимок отложки относится к другому каналу');
    const slots = this.#schedule.futureSlots(now, options.minimumLeadMs);
    // Запускаем проверку часов/горизонта даже при пустой очереди или исчерпанной ёмкости.
    let slot = slots.next();
    const ready = readyJobs(queue, now);
    const reservations = queue.filter((job) => ['preparing', 'submitting', 'uncertain'].includes(job.status));
    const minute = (value: string | null) => {
      const time = value === null ? NaN : Date.parse(value);
      if (!Number.isFinite(time)) throw new Error('MAX: время занятого места не подтверждено');

      return Math.floor(time / 60_000);
    };
    const occupiedMinutes = new Set([
      ...snapshot.posts.map((post) => minute(post.scheduledAt)),
      ...reservations.map((job) => minute(job.scheduled_at)),
    ]);
    // shortcut: без сверки изображения возможное совпадение считается дважды; уточнять после надёжной сверки.
    const availableCapacity = Math.max(0, this.#effectiveLimit - snapshot.posts.length - reservations.length);
    const assignments: { jobId: number; scheduledAt: string }[] = [];

    while (!slot.done && assignments.length < ready.length && assignments.length < availableCapacity) {
      const scheduledAt = slot.value.toISOString();
      if (!occupiedMinutes.has(minute(scheduledAt))) assignments.push({ jobId: ready[assignments.length]!.id, scheduledAt });

      slot = slots.next();
    }

    return {
      assignments,
      occupiedSlots: [...occupiedMinutes].sort((a, b) => a - b).map((value) => new Date(value * 60_000).toISOString()),
      effectiveLimit: this.#effectiveLimit,
      scheduledCount: snapshot.posts.length, reservationCount: reservations.length,
      availableCapacity, remainingCapacity: availableCapacity - assignments.length,
      readyCount: ready.length, remainingReadyCount: ready.length - assignments.length,
      horizonExhausted: slot.done === true,
    };
  }
}
