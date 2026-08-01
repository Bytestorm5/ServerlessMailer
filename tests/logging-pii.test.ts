import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { logger, redactEmail, scrub } from '@/lib/logging';
import { isValidEmailSyntax } from '@/lib/email/normalize';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every log line this call produced, joined. */
function capture(run: () => void): string {
  const lines: string[] = [];
  const record = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  vi.spyOn(console, 'log').mockImplementation(record);
  vi.spyOn(console, 'warn').mockImplementation(record);
  vi.spyOn(console, 'error').mockImplementation(record);
  run();
  return lines.join('\n');
}

/**
 * Local parts that are legal per RFC 5322 atext and that this application
 * genuinely accepts and stores. A redactor that does not cover the same
 * character set leaks the leading fragment of the address.
 */
const AWKWARD_LOCAL_PARTS = [
  "o'brien",
  'bob!smith',
  'a=b',
  'first/last',
  'x#y',
  'p$q',
  'r%s',
  'a&b',
  'star*man',
  'plus+tag',
  'q?r',
  'hat^man',
  'under_score',
  'back`tick',
  'brace{a}',
  'pipe|line',
  'tilde~end',
  'dash-ed',
  'dotted.name',
];

describe('scrub covers every local part the application accepts', () => {
  it.each(AWKWARD_LOCAL_PARTS)('redacts %s@example.com completely', (local) => {
    const address = `${local}@example.com`;
    // Guard the premise: if the validator rejects it, the case is moot.
    expect(isValidEmailSyntax(address)).toBe(true);

    const scrubbed = scrub(`rate limit hit for ${address}`) as string;

    expect(scrubbed).not.toContain(local);
    expect(scrubbed).toContain('[redacted]@example.com');
  });

  it('redacts an address embedded in a rate-limit key', () => {
    // src/lib/ratelimit.ts logs its raw key, and the signup route builds that
    // key as `subscribe:email:<address>`.
    const scrubbed = scrub("subscribe:email:o'brien@example.com") as string;

    expect(scrubbed).not.toContain("o'brien");
    expect(scrubbed).toBe('subscribe:email:[redacted]@example.com');
  });

  it('redacts through every logger channel', () => {
    for (const level of ['info', 'warn', 'error'] as const) {
      const output = capture(() =>
        logger[level]("failed for o'brien@example.com", { detail: 'a=b@example.com' }),
      );
      expect(output).not.toContain("o'brien");
      expect(output).not.toContain('a=b@');
    }
  });
});

describe('scrub handles keys and non-plain objects', () => {
  it('scrubs object keys, not only values', () => {
    const scrubbed = scrub({ 'bob@example.com': 3 }) as Record<string, unknown>;
    expect(Object.keys(scrubbed)).toEqual(['[redacted]@example.com']);
  });

  it('renders a Date rather than destroying it', () => {
    // `{}` in a log line is worse than no log line: it looks like data.
    const at = new Date('2026-08-01T09:30:00.000Z');
    expect(scrub({ scheduledFor: at })).toEqual({
      scheduledFor: '2026-08-01T09:30:00.000Z',
    });
  });

  it('renders an ObjectId as its hex string', () => {
    const id = new ObjectId();
    expect(scrub({ campaignId: id })).toEqual({ campaignId: id.toHexString() });
  });

  it('renders Maps and Sets, scrubbing what is inside them', () => {
    expect(scrub(new Map([['to', 'reader@example.com']]))).toEqual({
      to: '[redacted]@example.com',
    });
    expect(scrub(new Set(['reader@example.com']))).toEqual(['[redacted]@example.com']);
  });

  it('still redacts an address inside a nested error', () => {
    const scrubbed = scrub({
      cause: new Error('550 no mailbox for reader@example.com'),
    }) as { cause: { message: string } };

    expect(scrubbed.cause.message).not.toContain('reader@example.com');
    expect(scrubbed.cause.message).toContain('[redacted]@example.com');
  });
});

describe('redactEmail', () => {
  it('keeps the domain, which is the part worth analysing', () => {
    expect(redactEmail("o'brien@example.com")).toBe('[redacted]@example.com');
  });

  it('gives up safely on something that is not an address', () => {
    expect(redactEmail('not-an-address')).toBe('[redacted]');
  });
});
