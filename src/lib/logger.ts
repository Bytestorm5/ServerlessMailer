/**
 * Structured logging with mandatory PII redaction.
 *
 * §12: email addresses are never written to application logs. Anything that
 * looks like an address is reduced to a domain-plus-hash form that is still
 * useful for correlating a support request without storing the address itself.
 */

import { createHash } from 'node:crypto';

const EMAIL_RE = /\b[^\s<>@,;"]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export function redactEmail(email: string): string {
  const at = email.lastIndexOf('@');
  const domain = at >= 0 ? email.slice(at + 1) : 'unknown';
  const digest = createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 10);
  return `<${digest}@${domain}>`;
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (typeof value === 'string') return value.replace(EMAIL_RE, (m) => redactEmail(m));
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

type Fields = Record<string, unknown>;

function emit(level: 'info' | 'warn' | 'error', message: string, fields?: Fields): void {
  const line = {
    level,
    msg: typeof message === 'string' ? (redactValue(message) as string) : message,
    ...(fields ? (redactValue(fields) as Fields) : {}),
    ts: new Date().toISOString(),
  };
  const serialized = JSON.stringify(line);
  if (level === 'error') console.error(serialized);
  else if (level === 'warn') console.warn(serialized);
  else console.log(serialized);
}

export const log = {
  info: (message: string, fields?: Fields) => emit('info', message, fields),
  warn: (message: string, fields?: Fields) => emit('warn', message, fields),
  error: (message: string, fields?: Fields) => emit('error', message, fields),
};

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
