import { LoggerService } from '@nestjs/common';
import pino from 'pino';

export const log = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { app: 'mailer', pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
});

function toText(message: unknown): string {
  if (typeof message === 'string') return message;
  if (message instanceof Error) return message.message;
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

/** Nest 会把 context 作为最后一个字符串参数传入 */
function meta(rest: unknown[]): Record<string, unknown> {
  const last = rest[rest.length - 1];
  return typeof last === 'string' ? { ctx: last } : {};
}

export class PinoLoggerService implements LoggerService {
  log(message: unknown, ...rest: unknown[]) {
    log.info(meta(rest), toText(message));
  }

  error(message: unknown, ...rest: unknown[]) {
    const last = rest[rest.length - 1];
    const stack = typeof last === 'string' ? rest[rest.length - 2] : last;
    log.error({ ...meta(rest), stack: typeof stack === 'string' ? stack : undefined }, toText(message));
  }

  warn(message: unknown, ...rest: unknown[]) {
    log.warn(meta(rest), toText(message));
  }

  debug(message: unknown, ...rest: unknown[]) {
    log.debug(meta(rest), toText(message));
  }

  verbose(message: unknown, ...rest: unknown[]) {
    log.trace(meta(rest), toText(message));
  }
}
