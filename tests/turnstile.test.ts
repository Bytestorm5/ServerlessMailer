import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resetTurnstileVerifier,
  setTurnstileVerifier,
  verifyTurnstile,
} from '@/lib/turnstile';

/**
 * Spec §5.1 step 2 and §12 ("Signup abuse"): Turnstile is *optional*. When it
 * is not configured the signup form must keep working; when it is configured it
 * must be a real gate, and an unreachable Cloudflare must fail closed rather
 * than degrade into an open door.
 *
 * Nothing here touches the network: the injected-verifier seam covers the
 * delegation contract and a stubbed `fetch` covers the default verifier.
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SECRET = 'cf-turnstile-secret-value';

/** Sets TURNSTILE_SECRET_KEY for the duration of `run`, always restoring it. */
async function withSecret<T>(
  secret: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env.TURNSTILE_SECRET_KEY;
  try {
    if (secret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = secret;
    return await run();
  } finally {
    if (previous === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = previous;
  }
}

interface StubResponse {
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
}

function jsonResponse(body: unknown, status = 200): StubResponse {
  return { status, ok: status < 400, json: async () => body };
}

function stubFetch(
  impl: (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<StubResponse>,
) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** Reads back the form-encoded body the default verifier posted. */
function postedForm(spy: ReturnType<typeof stubFetch>, call = 0): URLSearchParams {
  const init = spy.mock.calls[call][1];
  return new URLSearchParams(init.body ?? '');
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetTurnstileVerifier();
});

describe('verifyTurnstile — opt-in gate', () => {
  it('returns true when TURNSTILE_SECRET_KEY is unset, even with no token', async () => {
    await withSecret(undefined, async () => {
      const verifier = vi.fn(async () => false);
      setTurnstileVerifier(verifier);
      const fetchSpy = stubFetch(async () => jsonResponse({ success: false }));

      await expect(verifyTurnstile(undefined)).resolves.toBe(true);
      await expect(verifyTurnstile('')).resolves.toBe(true);
      await expect(verifyTurnstile('some-token', '203.0.113.9')).resolves.toBe(true);

      // Strictly opt-in: nothing is consulted at all when unconfigured.
      expect(verifier).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  it('treats an empty TURNSTILE_SECRET_KEY as unconfigured', async () => {
    await withSecret('', async () => {
      const verifier = vi.fn(async () => false);
      setTurnstileVerifier(verifier);

      await expect(verifyTurnstile(undefined)).resolves.toBe(true);
      expect(verifier).not.toHaveBeenCalled();
    });
  });

  it('returns false when configured but no token is supplied', async () => {
    await withSecret(SECRET, async () => {
      const verifier = vi.fn(async () => true);
      setTurnstileVerifier(verifier);

      await expect(verifyTurnstile(undefined)).resolves.toBe(false);
      // A missing token is rejected without a round trip; it can never pass.
      expect(verifier).not.toHaveBeenCalled();
    });
  });

  it('returns false when configured and the token is an empty string', async () => {
    await withSecret(SECRET, async () => {
      const verifier = vi.fn(async () => true);
      setTurnstileVerifier(verifier);

      await expect(verifyTurnstile('')).resolves.toBe(false);
      expect(verifier).not.toHaveBeenCalled();
    });
  });

  it('delegates to the configured verifier with the token and client ip', async () => {
    await withSecret(SECRET, async () => {
      const verifier = vi.fn(async () => true);
      setTurnstileVerifier(verifier);

      await expect(verifyTurnstile('tok-123', '198.51.100.4')).resolves.toBe(true);
      expect(verifier).toHaveBeenCalledTimes(1);
      expect(verifier).toHaveBeenCalledWith('tok-123', '198.51.100.4');
    });
  });

  it('passes an undefined ip through when the caller has none', async () => {
    await withSecret(SECRET, async () => {
      const verifier = vi.fn(async () => true);
      setTurnstileVerifier(verifier);

      await verifyTurnstile('tok-123');
      expect(verifier).toHaveBeenCalledWith('tok-123', undefined);
    });
  });

  it('returns false when the verifier rejects the token', async () => {
    await withSecret(SECRET, async () => {
      setTurnstileVerifier(async () => false);
      await expect(verifyTurnstile('bad-token', '198.51.100.4')).resolves.toBe(false);
    });
  });
});

describe('default verifier — Cloudflare siteverify contract', () => {
  it('posts form-encoded credentials to the Cloudflare siteverify endpoint', async () => {
    await withSecret(SECRET, async () => {
      const fetchSpy = stubFetch(async () => jsonResponse({ success: true }));

      await expect(verifyTurnstile('tok-abc', '203.0.113.7')).resolves.toBe(true);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(SITEVERIFY_URL);
      expect(init.method).toBe('POST');
      // Cloudflare only accepts form encoding on this endpoint; sending JSON
      // under this content-type would make every verification fail.
      expect(init.headers?.['content-type']).toBe('application/x-www-form-urlencoded');

      const form = postedForm(fetchSpy);
      expect(form.get('secret')).toBe(SECRET);
      expect(form.get('response')).toBe('tok-abc');
      expect(form.get('remoteip')).toBe('203.0.113.7');
    });
  });

  it('omits remoteip entirely when the caller supplies no ip', async () => {
    await withSecret(SECRET, async () => {
      const fetchSpy = stubFetch(async () => jsonResponse({ success: true }));

      await verifyTurnstile('tok-abc');

      const form = postedForm(fetchSpy);
      expect(form.has('remoteip')).toBe(false);
      expect(form.get('response')).toBe('tok-abc');
    });
  });

  it('sends the secret from the environment at call time, not a captured copy', async () => {
    await withSecret('first-secret', async () => {
      const fetchSpy = stubFetch(async () => jsonResponse({ success: true }));
      await verifyTurnstile('tok');
      expect(postedForm(fetchSpy, 0).get('secret')).toBe('first-secret');

      process.env.TURNSTILE_SECRET_KEY = 'rotated-secret';
      await verifyTurnstile('tok');
      expect(postedForm(fetchSpy, 1).get('secret')).toBe('rotated-secret');
    });
  });

  const bodies: Array<[string, unknown, boolean]> = [
    ['success: true', { success: true }, true],
    ['success: false', { success: false }, false],
    ['no success field', { 'error-codes': ['invalid-input-response'] }, false],
    ['success as the string "true"', { success: 'true' }, false],
    ['success as 1', { success: 1 }, false],
    ['a null body', null, false],
  ];

  it.each(bodies)('returns %s → %s only for a strict boolean success', async (_label, body, expected) => {
    await withSecret(SECRET, async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      stubFetch(async () => jsonResponse(body));
      await expect(verifyTurnstile('tok')).resolves.toBe(expected);
    });
  });

  it('fails closed when the Cloudflare request throws', async () => {
    await withSecret(SECRET, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stubFetch(async () => {
        throw new Error('ECONNREFUSED challenges.cloudflare.com');
      });

      await expect(verifyTurnstile('tok', '203.0.113.7')).resolves.toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  it('fails closed when the response body is not JSON', async () => {
    await withSecret(SECRET, async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      stubFetch(async () => ({
        status: 200,
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      }));

      await expect(verifyTurnstile('tok')).resolves.toBe(false);
    });
  });

  it('fails closed when Cloudflare returns an error status with an HTML page', async () => {
    await withSecret(SECRET, async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      stubFetch(async () => ({
        status: 502,
        ok: false,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      }));

      await expect(verifyTurnstile('tok')).resolves.toBe(false);
    });
  });

  it('never writes the Turnstile secret or the token into the failure log', async () => {
    await withSecret(SECRET, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stubFetch(async () => {
        throw new Error(`upstream rejected secret=${SECRET}`);
      });

      await expect(verifyTurnstile('tok-secret-value')).resolves.toBe(false);
      const line = warn.mock.calls.map((args) => String(args[0])).join('\n');
      expect(line).not.toContain('tok-secret-value');
    });
  });
});

describe('verifier seam', () => {
  it('resetTurnstileVerifier restores the network-backed default', async () => {
    await withSecret(SECRET, async () => {
      setTurnstileVerifier(async () => true);
      const fetchSpy = stubFetch(async () => jsonResponse({ success: false }));

      // Injected verifier still in force: no network, and it wins.
      await expect(verifyTurnstile('tok')).resolves.toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();

      resetTurnstileVerifier();

      await expect(verifyTurnstile('tok')).resolves.toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('setTurnstileVerifier replaces a previously injected verifier', async () => {
    await withSecret(SECRET, async () => {
      const first = vi.fn(async () => true);
      const second = vi.fn(async () => false);
      setTurnstileVerifier(first);
      setTurnstileVerifier(second);

      await expect(verifyTurnstile('tok')).resolves.toBe(false);
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    });
  });
});
