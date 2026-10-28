import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    base: { app: 'mimir' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: ['apiKey', '*.apiKey', 'headers.authorization'], censor: '[redacted]' },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } } } : {}),
  });
}

/** A logger that discards everything; used in tests. */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
