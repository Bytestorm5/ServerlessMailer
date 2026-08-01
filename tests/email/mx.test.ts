import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hasMxRecord,
  resetMxResolver,
  setMxResolver,
  type MxResolver,
} from '@/lib/email/mx';

afterEach(() => {
  resetMxResolver();
  vi.unstubAllEnvs();
});

/** Records every domain the resolver was asked about. */
function recordingResolver(
  result: { exchange: string; priority: number }[] | Error,
): { resolver: MxResolver; calls: string[] } {
  const calls: string[] = [];
  const resolver: MxResolver = async (domain) => {
    calls.push(domain);
    if (result instanceof Error) throw result;
    return result;
  };
  return { resolver, calls };
}

const oneRecord = [{ exchange: 'mx1.example.com', priority: 10 }];

describe('hasMxRecord', () => {
  it('returns true when the domain has at least one MX record', async () => {
    setMxResolver(async () => oneRecord);
    await expect(hasMxRecord('example.com')).resolves.toBe(true);
  });

  it('returns true when the domain has several MX records', async () => {
    setMxResolver(async () => [
      { exchange: 'alt1.aspmx.example.com', priority: 20 },
      { exchange: 'aspmx.example.com', priority: 10 },
    ]);
    await expect(hasMxRecord('example.com')).resolves.toBe(true);
  });

  it('returns false for an empty MX list — fail closed at signup', async () => {
    setMxResolver(async () => []);
    await expect(hasMxRecord('example.com')).resolves.toBe(false);
  });

  it('returns false when the resolver rejects, without an unhandled rejection', async () => {
    const { resolver, calls } = recordingResolver(
      Object.assign(new Error('queryMx ENOTFOUND'), { code: 'ENOTFOUND' }),
    );
    setMxResolver(resolver);
    await expect(hasMxRecord('nope.example')).resolves.toBe(false);
    expect(calls).toEqual(['nope.example']);
  });

  it('returns false on a DNS timeout', async () => {
    setMxResolver(async () => {
      throw Object.assign(new Error('queryMx ETIMEOUT'), { code: 'ETIMEOUT' });
    });
    await expect(hasMxRecord('slow.example.com')).resolves.toBe(false);
  });

  it('returns false when the resolver throws synchronously', async () => {
    const resolver = (() => {
      throw new Error('boom');
    }) as unknown as MxResolver;
    setMxResolver(resolver);
    await expect(hasMxRecord('example.com')).resolves.toBe(false);
  });

  it('returns false when the resolver rejects with a non-Error value', async () => {
    setMxResolver(async () => {
      throw 'string failure';
    });
    await expect(hasMxRecord('example.com')).resolves.toBe(false);
  });

  it('treats an RFC 7505 null MX ("." exchange) as no MX', async () => {
    setMxResolver(async () => [{ exchange: '.', priority: 0 }]);
    await expect(hasMxRecord('no-mail.example.com')).resolves.toBe(false);
  });

  it('treats a blank exchange as no MX', async () => {
    setMxResolver(async () => [
      { exchange: '', priority: 10 },
      { exchange: '   ', priority: 20 },
    ]);
    await expect(hasMxRecord('example.com')).resolves.toBe(false);
  });

  it('accepts a usable record alongside a null MX', async () => {
    setMxResolver(async () => [
      { exchange: '.', priority: 0 },
      { exchange: 'mx.example.com', priority: 10 },
    ]);
    await expect(hasMxRecord('example.com')).resolves.toBe(true);
  });

  it('returns false when the resolver returns a non-array', async () => {
    setMxResolver((async () => null) as unknown as MxResolver);
    await expect(hasMxRecord('example.com')).resolves.toBe(false);
    setMxResolver((async () => ({ exchange: 'mx.example.com' })) as unknown as MxResolver);
    await expect(hasMxRecord('example.com')).resolves.toBe(false);
  });

  it('returns false when records are malformed objects', async () => {
    setMxResolver((async () => [null, undefined, 42]) as unknown as MxResolver);
    await expect(hasMxRecord('example.com')).resolves.toBe(false);
  });

  it('returns false when a record has no usable exchange field', async () => {
    setMxResolver((async () => [{ priority: 10 }]) as unknown as MxResolver);
    await expect(hasMxRecord('example.com')).resolves.toBe(false);
    setMxResolver((async () => [{ exchange: 42, priority: 10 }]) as unknown as MxResolver);
    await expect(hasMxRecord('example.com')).resolves.toBe(false);
    setMxResolver(
      (async () => [{ exchange: null, priority: 10 }]) as unknown as MxResolver,
    );
    await expect(hasMxRecord('example.com')).resolves.toBe(false);
  });

  it('lowercases and trims the domain before querying', async () => {
    const { resolver, calls } = recordingResolver(oneRecord);
    setMxResolver(resolver);
    await expect(hasMxRecord('  Example.COM  ')).resolves.toBe(true);
    expect(calls).toEqual(['example.com']);
  });

  it('strips a trailing root dot', async () => {
    const { resolver, calls } = recordingResolver(oneRecord);
    setMxResolver(resolver);
    await expect(hasMxRecord('example.com.')).resolves.toBe(true);
    expect(calls).toEqual(['example.com']);
  });

  describe('rejects malformed domains without querying DNS', () => {
    const bad: [string, string][] = [
      ['', 'empty'],
      ['   ', 'blank'],
      ['.', 'root only'],
      ['localhost', 'no TLD'],
      ['example', 'no TLD'],
      ['example..com', 'consecutive dots'],
      ['.example.com', 'leading dot'],
      ['-example.com', 'leading hyphen'],
      ['example-.com', 'trailing hyphen'],
      ['exa mple.com', 'space'],
      ['example.com\nevil.com', 'newline injection'],
      ['user@example.com', 'an address, not a domain'],
      ['exámple.com', 'non-ASCII'],
      ['example.c', 'single-character TLD'],
      ['[192.168.0.1]', 'IP literal'],
      [`${'a'.repeat(64)}.com`, 'label longer than 63'],
      [`${'a.'.repeat(130)}com`, 'domain longer than 253'],
    ];

    for (const [domain, why] of bad) {
      it(`rejects ${JSON.stringify(domain)} (${why})`, async () => {
        const { resolver, calls } = recordingResolver(oneRecord);
        setMxResolver(resolver);
        await expect(hasMxRecord(domain)).resolves.toBe(false);
        expect(calls).toEqual([]);
      });
    }
  });

  it('tolerates non-string input from untyped callers', async () => {
    const { resolver, calls } = recordingResolver(oneRecord);
    setMxResolver(resolver);
    await expect(hasMxRecord(undefined as unknown as string)).resolves.toBe(false);
    await expect(hasMxRecord(null as unknown as string)).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it('never logs an email address when handed one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    setMxResolver(async () => {
      throw new Error('lookup failed for victim@example.com');
    });
    await expect(hasMxRecord('example.com')).resolves.toBe(false);
    const written = [...warn.mock.calls, ...log.mock.calls].flat().join(' ');
    expect(written).not.toContain('victim@example.com');
  });
});

describe('skipMxCheck', () => {
  it('returns true unconditionally without querying DNS', async () => {
    vi.stubEnv('SKIP_MX_CHECK', 'true');
    const { resolver, calls } = recordingResolver([]);
    setMxResolver(resolver);
    await expect(hasMxRecord('example.com')).resolves.toBe(true);
    expect(calls).toEqual([]);
  });

  it('returns true even for a domain that would fail validation', async () => {
    vi.stubEnv('SKIP_MX_CHECK', 'true');
    setMxResolver(async () => {
      throw new Error('should not be called');
    });
    await expect(hasMxRecord('')).resolves.toBe(true);
    await expect(hasMxRecord('localhost')).resolves.toBe(true);
  });

  it('is read at call time, not at module load', async () => {
    setMxResolver(async () => []);
    await expect(hasMxRecord('example.com')).resolves.toBe(false);
    vi.stubEnv('SKIP_MX_CHECK', 'true');
    await expect(hasMxRecord('example.com')).resolves.toBe(true);
    vi.stubEnv('SKIP_MX_CHECK', 'false');
    await expect(hasMxRecord('example.com')).resolves.toBe(false);
  });

  it('only skips for the exact string "true"', async () => {
    vi.stubEnv('SKIP_MX_CHECK', '1');
    setMxResolver(async () => []);
    await expect(hasMxRecord('example.com')).resolves.toBe(false);
  });
});

describe('the resolver seam', () => {
  it('setMxResolver(undefined) restores the default resolver', async () => {
    setMxResolver(async () => oneRecord);
    await expect(hasMxRecord('this-domain-does-not-exist.invalid')).resolves.toBe(true);
    setMxResolver(undefined);
    await expect(hasMxRecord('this-domain-does-not-exist.invalid')).resolves.toBe(false);
  });

  it('resetMxResolver restores the default resolver', async () => {
    setMxResolver(async () => oneRecord);
    await expect(hasMxRecord('this-domain-does-not-exist.invalid')).resolves.toBe(true);
    resetMxResolver();
    await expect(hasMxRecord('this-domain-does-not-exist.invalid')).resolves.toBe(false);
  });

  it('uses node:dns by default and fails closed on a lookup failure', async () => {
    // `.invalid` is reserved by RFC 2606 and can never resolve, so this
    // exercises the real node:dns path without depending on the network.
    await expect(hasMxRecord('nothing-here.invalid')).resolves.toBe(false);
  });

  it('is swappable more than once', async () => {
    setMxResolver(async () => oneRecord);
    await expect(hasMxRecord('example.com')).resolves.toBe(true);
    setMxResolver(async () => []);
    await expect(hasMxRecord('example.com')).resolves.toBe(false);
    setMxResolver(async () => oneRecord);
    await expect(hasMxRecord('example.com')).resolves.toBe(true);
  });
});
