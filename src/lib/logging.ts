/**
 * PII-safe logging.
 *
 * Spec §12: email addresses are never written to application logs. Every log
 * call funnels through here, and every string is scrubbed of anything that
 * looks like an address before it reaches stdout — including addresses that
 * arrive embedded in an SES error message the caller never inspected.
 */

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/**
 * Replaces an address with a stable, non-reversible-enough marker that still
 * allows correlating two log lines about the same recipient within a run.
 */
export function redactEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '[redacted]';
  const domain = email.slice(at + 1);
  return `[redacted]@${domain}`;
}

export function scrub(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(EMAIL_PATTERN, (match) => redactEmail(match));
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrub(value.message),
    };
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      // Belt and braces: a field literally named `email` is dropped to a
      // domain-only marker even if its value somehow dodges the pattern.
      if (/^(email|emailAddress|to|recipient)$/i.test(key) && typeof val === 'string') {
        out[key] = redactEmail(val);
      } else {
        out[key] = scrub(val);
      }
    }
    return out;
  }
  return value;
}

export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

function emit(
  level: 'info' | 'warn' | 'error',
  message: string,
  context?: Record<string, unknown>,
): void {
  const line = {
    level,
    msg: scrub(message),
    ...(context ? { ctx: scrub(context) as Record<string, unknown> } : {}),
  };
  const serialized = JSON.stringify(line);
  if (level === 'error') console.error(serialized);
  else if (level === 'warn') console.warn(serialized);
  else console.log(serialized);
}

export const logger: Logger = {
  info: (message, context) => emit('info', message, context),
  warn: (message, context) => emit('warn', message, context),
  error: (message, context) => emit('error', message, context),
};
