/** Ошибка интеграции с безопасной причиной; исходная ошибка остаётся только в cause. */
export class IntegrationFailure extends Error {
  readonly code: 'network' | 'auth-required' | 'captcha' | 'structure-changed' | 'unknown';
  readonly diagnostics: string | undefined;

  constructor(code: IntegrationFailure['code'], reason: string, diagnostics?: string, cause?: unknown) {
    const safeReason = /(?:password|пароль|cookie|token|authorization|код входа|code|код)\s*[:=]/i.test(reason)
      ? 'Причина содержит приватные данные; подробности доступны только в исходной ошибке.'
      : reason.replace(/https?:\/\/[^\s]+/g, '[адрес скрыт]');
    super(safeReason, { cause });
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

/** Распознаёт только доказанные сетевые отказы; таймаут DOM не доказывает сетевой сбой. */
export function integrationFailure(error: unknown): IntegrationFailure {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (current instanceof IntegrationFailure) return current;
    const code = /\b(?:net::ERR_(?:INTERNET_DISCONNECTED|CONNECTION_(?:RESET|REFUSED|CLOSED|TIMED_OUT)|NAME_NOT_RESOLVED|NETWORK_CHANGED)|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ETIMEDOUT)\b/.exec(current.message)?.[0];
    if (code) return new IntegrationFailure('network', `Временный сетевой отказ: ${code}`, undefined, error);
    current = current.cause;
  }

  if (error instanceof Error && /^(?:MAX|Pinterest):/.test(error.message)) return new IntegrationFailure('unknown', error.message.replace(/https?:\/\/[^\s]+/g, '[адрес скрыт]'), undefined, error);

  return new IntegrationFailure('unknown', 'Причина отказа не подтверждена; автоматические действия приостановлены.', undefined, error);
}
