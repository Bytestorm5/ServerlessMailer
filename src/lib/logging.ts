/**
 * PII-safe logging.
 *
 * Spec §12: email addresses are never written to application logs. Every log
 * call funnels through here, and every string is scrubbed of anything that
 * looks like an address before it reaches stdout — including addresses that
 * arrive embedded in an SES error message the caller never inspected.
 */

/**
 * The local-part class here must be at least as wide as `LOCAL_ATOM` in
 * `email/normalize.ts`, or an address this application happily stores would be
 * only partly redacted: a narrower class starts matching *after* the character
 * it does not recognise, so `o'brien@example.com` would log as `o'…`. This is
 * RFC 5322 atext plus the `.` separator.
 */
const EMAIL_PATTERN =
  /[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

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
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    // Object.entries() is empty for Map, Set and similar, which would silently
    // serialize them as `{}`. Anything with a useful string form gets one.
    if (typeof (value as { toHexString?: unknown }).toHexString === 'function') {
      return (value as { toHexString: () => string }).toHexString();
    }
    if (value instanceof Map) return scrub(Object.fromEntries(value));
    if (value instanceof Set) return scrub([...value]);

    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      // Keys are scrubbed too: nothing currently keys a log context by address,
      // but "every string is scrubbed" should hold for keys as well as values.
      const safeKey = scrub(key) as string;
      // Belt and braces: a field literally named `email` is dropped to a
      // domain-only marker even if its value somehow dodges the pattern.
      if (/^(email|emailAddress|to|recipient)$/i.test(key) && typeof val === 'string') {
        out[safeKey] = redactEmail(val);
      } else {
        out[safeKey] = scrub(val);
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
