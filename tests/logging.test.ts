import { describe, expect, it, vi } from 'vitest';
import { logger, redactEmail, scrub } from '@/lib/logging';

/**
 * Spec §12, "PII in logs": *email addresses are never written to application
 * logs*. That is an absolute, so these tests attack it from every direction an
 * address can actually arrive: interpolated into a message, nested in a context
 * object, inside an array, buried in an SES diagnostic string, and inside an
 * `Error` the caller passed along without ever reading.
 *
 * The retained domain is deliberate — `[redacted]@example.com` still lets an
 * operator correlate two lines about one recipient and reason about a
 * domain-level deliverability problem — so every case asserts the *local part*
 * is gone rather than that the whole thing vanished.
 */

/** Spies on all three console sinks and exposes everything that was written. */
function captureConsole() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  return {
    log,
    warn,
    error,
    /** Everything written to any sink, joined — what actually reaches stdout. */
    all(): string {
      return [log, warn, error]
        .flatMap((spy) => spy.mock.calls.map((args) => args.map(String).join(' ')))
        .join('\n');
    },
  };
}

const LOGGER_METHODS = [
  { level: 'info', sink: 'log' },
  { level: 'warn', sink: 'warn' },
  { level: 'error', sink: 'error' },
] as const;

describe('redactEmail', () => {
  it('replaces the local part and keeps the domain for correlation', () => {
    expect(redactEmail('bob@example.com')).toBe('[redacted]@example.com');
  });

  it('keeps a multi-label domain intact', () => {
    expect(redactEmail('bob@news.example.co.uk')).toBe('[redacted]@news.example.co.uk');
  });

  it('drops everything when there is no @ to split on', () => {
    expect(redactEmail('not-an-address')).toBe('[redacted]');
  });

  it('drops everything when the address begins with @', () => {
    expect(redactEmail('@example.com')).toBe('[redacted]');
  });

  it('drops everything for an empty string', () => {
    expect(redactEmail('')).toBe('[redacted]');
  });

  it('splits on the first @ so a doubled address cannot smuggle a local part', () => {
    const result = redactEmail('alice@evil@example.com');
    expect(result).not.toContain('alice');
    expect(result.startsWith('[redacted]@')).toBe(true);
  });

  it('removes the local part regardless of case', () => {
    const result = redactEmail('BoB.Smith@Example.COM');
    expect(result).not.toContain('BoB');
    expect(result).not.toContain('Smith');
    expect(result).toBe('[redacted]@Example.COM');
  });
});

describe('scrub — addresses embedded in strings', () => {
  it('redacts an address mid-sentence', () => {
    expect(scrub('failed to deliver to bob@example.com after 3 attempts')).toBe(
      'failed to deliver to [redacted]@example.com after 3 attempts',
    );
  });

  it('redacts every address in a string, keeping each domain', () => {
    expect(scrub('bob@a-domain.com and carol@b-domain.org both bounced')).toBe(
      '[redacted]@a-domain.com and [redacted]@b-domain.org both bounced',
    );
  });

  it('redacts an uppercase address', () => {
    const result = scrub('bounce for BOB@EXAMPLE.COM') as string;
    expect(result).not.toContain('BOB@');
    expect(result).toBe('bounce for [redacted]@EXAMPLE.COM');
  });

  it('redacts a plus-tagged address, tag included', () => {
    const result = scrub('signup from bob+newsletter@example.com') as string;
    expect(result).not.toContain('bob');
    expect(result).not.toContain('newsletter@');
    expect(result).toBe('signup from [redacted]@example.com');
  });

  it('redacts an address embedded in a rate-limit key', () => {
    // src/lib/ratelimit.ts logs its raw key, and the per-address signup limiter
    // builds that key as `subscribe:email:<address>`.
    const result = scrub('subscribe:email:bob@example.com') as string;
    expect(result).toBe('subscribe:email:[redacted]@example.com');
  });

  it('redacts an address inside a URL query string', () => {
    const result = scrub(
      'GET https://mail.example.com/api/confirm?addr=bob@example.com&t=1',
    ) as string;
    expect(result).not.toContain('bob@');
    expect(result).toContain('[redacted]@example.com');
  });

  it('redacts an address inside an SES SMTP diagnostic', () => {
    const result = scrub(
      'smtp; 550 5.1.1 <bob@example.com>: Recipient address rejected: User unknown',
    ) as string;
    expect(result).not.toContain('bob@');
    expect(result).toContain('<[redacted]@example.com>');
    // The diagnostic itself must survive — it is the reason the address bounced.
    expect(result).toContain('550 5.1.1');
    expect(result).toContain('User unknown');
  });

  it('leaves a string with no address untouched', () => {
    expect(scrub('batch 4 of 12 completed in 812ms')).toBe(
      'batch 4 of 12 completed in 812ms',
    );
  });

  it('leaves an empty string untouched', () => {
    expect(scrub('')).toBe('');
  });
});

describe('scrub — nested structures', () => {
  it('redacts an address nested several objects deep', () => {
    expect(
      scrub({
        campaign: { id: 'abc', last: { note: 'rejected for bob@example.com' } },
      }),
    ).toEqual({
      campaign: { id: 'abc', last: { note: 'rejected for [redacted]@example.com' } },
    });
  });

  it('redacts addresses inside an array of strings and keeps it an array', () => {
    const result = scrub(['bob@example.com', 'carol@example.org', 'no address here']);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([
      '[redacted]@example.com',
      '[redacted]@example.org',
      'no address here',
    ]);
  });

  it('redacts addresses inside an array of objects', () => {
    expect(
      scrub({ failures: [{ reason: 'bounce for bob@example.com', code: 550 }] }),
    ).toEqual({ failures: [{ reason: 'bounce for [redacted]@example.com', code: 550 }] });
  });

  it('redacts through arrays nested inside objects nested inside arrays', () => {
    const result = JSON.stringify(
      scrub([{ batch: [{ recipients: [{ note: 'sent to bob@example.com' }] }] }]),
    );
    expect(result).not.toContain('bob@');
    expect(result).toContain('[redacted]@example.com');
  });

  it('passes primitives through unchanged', () => {
    expect(scrub(42)).toBe(42);
    expect(scrub(0)).toBe(0);
    expect(scrub(true)).toBe(true);
    expect(scrub(false)).toBe(false);
    expect(scrub(null)).toBeNull();
    expect(scrub(undefined)).toBeUndefined();
  });

  it('does not mutate the caller’s object', () => {
    // Logging is an observation, not a transformation: a caller that logs a
    // subscriber document must still hold the real address afterwards.
    const context = { email: 'bob@example.com', nested: { note: 'to bob@example.com' } };
    scrub(context);
    expect(context.email).toBe('bob@example.com');
    expect(context.nested.note).toBe('to bob@example.com');
  });
});

describe('scrub — Error values', () => {
  it('reduces an Error to name and message, scrubbing the message', () => {
    expect(scrub(new Error('delivery failed for bob@example.com'))).toEqual({
      name: 'Error',
      message: 'delivery failed for [redacted]@example.com',
    });
  });

  it('drops the stack, which can carry addresses in frame arguments', () => {
    const scrubbed = scrub(new Error('boom')) as Record<string, unknown>;
    expect(Object.keys(scrubbed).sort()).toEqual(['message', 'name']);
    expect(scrubbed).not.toHaveProperty('stack');
  });

  it('preserves the name of an Error subclass', () => {
    class SesThrottled extends Error {
      constructor() {
        super('rate exceeded for bob@example.com');
        this.name = 'SesThrottlingError';
      }
    }
    expect(scrub(new SesThrottled())).toEqual({
      name: 'SesThrottlingError',
      message: 'rate exceeded for [redacted]@example.com',
    });
  });

  it('scrubs an Error nested inside a context object', () => {
    const result = JSON.stringify(
      scrub({ stage: 'sendBulk', error: new Error('MessageRejected: bob@example.com') }),
    );
    expect(result).not.toContain('bob@');
    expect(result).toContain('[redacted]@example.com');
    expect(result).toContain('MessageRejected');
  });

  it('scrubs Errors held in an array', () => {
    const result = JSON.stringify(
      scrub([new Error('bob@example.com failed'), new Error('carol@example.org failed')]),
    );
    expect(result).not.toContain('bob@');
    expect(result).not.toContain('carol@');
    expect(result).toContain('[redacted]@example.com');
    expect(result).toContain('[redacted]@example.org');
  });
});

describe('scrub — address-bearing keys', () => {
  it.each(['email', 'emailAddress', 'to', 'recipient'])(
    'redacts the value under a "%s" key',
    (key) => {
      expect(scrub({ [key]: 'bob@example.com' })).toEqual({
        [key]: '[redacted]@example.com',
      });
    },
  );

  it.each(['Email', 'EMAIL', 'EmailAddress', 'To', 'TO', 'Recipient'])(
    'matches the "%s" key case-insensitively',
    (key) => {
      expect(scrub({ [key]: 'bob@example.com' })).toEqual({
        [key]: '[redacted]@example.com',
      });
    },
  );

  it('redacts an address-keyed value that does not look like an address', () => {
    // Belt and braces: if the pattern would have missed it, the key still wins.
    expect(scrub({ email: 'bob(at)example.com' })).toEqual({ email: '[redacted]' });
    expect(scrub({ recipient: 'unknown' })).toEqual({ recipient: '[redacted]' });
  });

  it('redacts an address-keyed empty string rather than leaving it bare', () => {
    expect(scrub({ email: '' })).toEqual({ email: '[redacted]' });
  });

  it('still redacts real addresses under keys that are not on the list', () => {
    expect(scrub({ replyTo: 'hello@domain-a.com', fromEmail: 'news@domain-a.com' })).toEqual({
      replyTo: '[redacted]@domain-a.com',
      fromEmail: '[redacted]@domain-a.com',
    });
  });

  it('redacts addresses in an array held under a "to" key', () => {
    expect(scrub({ to: ['bob@example.com', 'carol@example.org'] })).toEqual({
      to: ['[redacted]@example.com', '[redacted]@example.org'],
    });
  });

  it('leaves a non-address value under a non-matching key alone', () => {
    expect(scrub({ status: 'confirmed', count: 19_000 })).toEqual({
      status: 'confirmed',
      count: 19_000,
    });
  });
});

describe('logger — routing and line shape', () => {
  it.each(LOGGER_METHODS)('$level writes exactly one line to console.$sink', ({ level, sink }) => {
    const spies = captureConsole();
    logger[level]('hello');

    expect(spies[sink]).toHaveBeenCalledTimes(1);
    expect(spies[sink].mock.calls[0]).toHaveLength(1);
    for (const other of LOGGER_METHODS) {
      if (other.sink !== sink) expect(spies[other.sink]).not.toHaveBeenCalled();
    }
  });

  it.each(LOGGER_METHODS)('$level emits parseable JSON tagged with its level', ({ level, sink }) => {
    const spies = captureConsole();
    logger[level]('campaign frozen');

    const line = JSON.parse(spies[sink].mock.calls[0][0] as string);
    expect(line).toEqual({ level, msg: 'campaign frozen' });
  });

  it('omits ctx entirely when no context is supplied', () => {
    const spies = captureConsole();
    logger.info('no context here');

    const line = JSON.parse(spies.log.mock.calls[0][0] as string);
    expect(line).not.toHaveProperty('ctx');
  });

  it('carries the context through under ctx', () => {
    const spies = captureConsole();
    logger.info('campaign frozen', { campaignId: 'abc123', recipients: 19_000 });

    const line = JSON.parse(spies.log.mock.calls[0][0] as string);
    expect(line.ctx).toEqual({ campaignId: 'abc123', recipients: 19_000 });
  });
});

describe('logger — §12: an address never reaches the log', () => {
  /** One address in every shape a caller might realistically hand the logger. */
  function everyShape() {
    return {
      key: 'subscribe:email:alice.smith+news@example.com',
      subscriber: { nested: { note: 'confirmed alice.smith+news@example.com' } },
      failures: ['MessageRejected for alice.smith+news@example.com'],
      email: 'alice.smith+news@example.com',
      error: new Error('SES rejected alice.smith+news@example.com'),
      url: 'https://mail.example.com/api/confirm?a=alice.smith+news@example.com',
    };
  }

  it.each(LOGGER_METHODS)(
    '$level scrubs an address out of the message itself',
    ({ level, sink }) => {
      const spies = captureConsole();
      logger[level]('bounce recorded for alice.smith@example.com');

      const line = spies[sink].mock.calls[0][0] as string;
      expect(line).not.toContain('alice.smith');
      expect(line).toContain('[redacted]@example.com');
    },
  );

  it.each(LOGGER_METHODS)(
    '$level scrubs an address out of every context shape at once',
    ({ level, sink }) => {
      const spies = captureConsole();
      logger[level]('send failed', everyShape());

      const line = spies[sink].mock.calls[0][0] as string;
      expect(line).not.toContain('alice.smith');
      expect(line).not.toContain('alice');
      expect(line).not.toContain('+news@');
      // Every one of the six shapes must have produced its own marker.
      expect(line.match(/\[redacted\]@example\.com/g)).toHaveLength(6);
      // …and nothing at all escaped to another sink.
      expect(spies.all()).not.toContain('alice');
    },
  );

  it.each(LOGGER_METHODS)('$level keeps the domain so the line stays useful', ({ level, sink }) => {
    const spies = captureConsole();
    logger[level]('bounce', { email: 'alice@news.domain-a.com' });

    const line = JSON.parse(spies[sink].mock.calls[0][0] as string);
    expect(line.ctx.email).toBe('[redacted]@news.domain-a.com');
  });

  it('keeps distinct domains distinguishable across recipients', () => {
    const spies = captureConsole();
    logger.warn('two failures', {
      first: 'bob@gmail.com',
      second: 'carol@yahoo.co.uk',
    });

    const line = JSON.parse(spies.warn.mock.calls[0][0] as string);
    expect(line.ctx).toEqual({
      first: '[redacted]@gmail.com',
      second: '[redacted]@yahoo.co.uk',
    });
  });

  it('scrubs an address that arrives only inside an Error the caller never read', () => {
    const spies = captureConsole();
    // The realistic case: an SES error string is passed straight through.
    logger.error('batch send failed', {
      batchId: 'b1',
      error: new Error('Invalid destination: dave.jones@example.net'),
    });

    const line = spies.error.mock.calls[0][0] as string;
    expect(line).not.toContain('dave.jones');
    expect(line).toContain('[redacted]@example.net');
    expect(line).toContain('Invalid destination');
  });

  it('does not leave the caller’s context object scrubbed after logging', () => {
    const spies = captureConsole();
    const context = { email: 'bob@example.com' };
    logger.info('confirmed', context);

    expect(spies.log.mock.calls[0][0]).toContain('[redacted]@example.com');
    expect(context.email).toBe('bob@example.com');
  });
});
