import { describe, expect, it, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { badRequest, notFound, readJson, toObjectId, withAdmin } from '@/lib/api/guard';
import { ADMIN_COOKIE_NAME, createSessionToken } from '@/lib/auth';

import { GET as subscriberDetailGet } from '@/app/api/admin/subscribers/[id]/route';

/**
 * The admin guard (spec §12, CONTRACTS §29).
 *
 * Two properties matter here and neither is cosmetic: nothing runs before the
 * session is verified, and nothing internal escapes when a handler blows up.
 */

const URL_BASE = 'https://mail.example.com';
const AUTH_COOKIE = `${ADMIN_COOKIE_NAME}=${createSessionToken('admin')}`;

function authed(path = '/api/admin/thing', init: RequestInit = {}): Request {
  return new Request(`${URL_BASE}${path}`, {
    ...init,
    headers: { cookie: AUTH_COOKIE, ...(init.headers as Record<string, string> | undefined) },
  });
}

function anonymous(path = '/api/admin/thing', init: RequestInit = {}): Request {
  return new Request(`${URL_BASE}${path}`, init);
}

function jsonRequest(body: string): Request {
  return new Request(`${URL_BASE}/api/admin/thing`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

describe('withAdmin — the session is checked before anything else', () => {
  it('answers 401 and never invokes the handler without a session', async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const response = await withAdmin(handler)(anonymous(), undefined);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: 'unauthorized' });
    // The point of the guard: the body of the route never ran, so an
    // unauthenticated request cannot reach a write path (§12).
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers 401 for a session token that has aged past its seven days', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const handler = vi.fn(async () => Response.json({ ok: true }));

    const response = await withAdmin(handler)(
      new Request(`${URL_BASE}/api/admin/thing`, {
        headers: { cookie: `${ADMIN_COOKIE_NAME}=${createSessionToken('admin', eightDaysAgo)}` },
      }),
      undefined,
    );

    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers 401 for a cookie whose name merely looks like the session cookie', async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const token = createSessionToken('admin');

    for (const cookie of [
      `x${ADMIN_COOKIE_NAME}=${token}`,
      `${ADMIN_COOKIE_NAME}_shadow=${token}`,
      `${ADMIN_COOKIE_NAME}=`,
    ]) {
      const response = await withAdmin(handler)(
        new Request(`${URL_BASE}/api/admin/thing`, { headers: { cookie } }),
        undefined,
      );
      expect(response.status).toBe(401);
    }

    expect(handler).not.toHaveBeenCalled();
  });

  it('takes the 401 branch even when the handler would have thrown', async () => {
    // Ordering matters: an unauthenticated caller must not be able to tell a
    // broken route from a working one, so auth wins over the 500.
    const handler = vi.fn(async () => {
      throw new Error('should never be reached');
    });

    const response = await withAdmin(handler)(anonymous(), undefined);

    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes the request and context through untouched and returns the handler response verbatim', async () => {
    const ctx = { params: Promise.resolve({ id: 'abc' }) };
    const request = authed();
    const handler = vi.fn(async (_request: Request, _ctx: typeof ctx) =>
      new Response(JSON.stringify({ ok: true, mine: true }), {
        status: 201,
        headers: { 'content-type': 'application/json', 'x-custom': 'kept' },
      }),
    );

    const response = await withAdmin<typeof ctx>(handler)(request, ctx);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toBe(request);
    expect(handler.mock.calls[0]?.[1]).toBe(ctx);
    expect(response.status).toBe(201);
    expect(response.headers.get('x-custom')).toBe('kept');
    expect(await response.json()).toEqual({ ok: true, mine: true });
  });
});

describe('withAdmin — a throwing handler becomes an opaque 500', () => {
  it('returns 500 with no stack, no message and no connection detail', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const secretish =
      'connection to mongodb://admin:hunter2@10.0.0.5/newsletter refused';
    const response = await withAdmin(async () => {
      throw new Error(secretish);
    })(authed('/api/admin/stats'), undefined);

    expect(response.status).toBe(500);

    const raw = await response.text();
    // Exact body, not "contains": an extra field is exactly how detail leaks.
    expect(JSON.parse(raw)).toEqual({ ok: false, error: 'internal error' });
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('mongodb://');
    expect(raw).not.toContain('10.0.0.5');
    expect(raw).not.toContain(secretish);
    expect(raw.toLowerCase()).not.toContain('stack');
    expect(raw).not.toMatch(/\bat .*guard/);
  });

  it('leaks nothing through response headers either', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await withAdmin(async () => {
      throw new Error('EACCES /var/secrets/ses.key');
    })(authed('/api/admin/import'), undefined);

    const headerDump = JSON.stringify([...response.headers.entries()]);
    expect(response.status).toBe(500);
    expect(headerDump).not.toContain('ses.key');
    expect(headerDump).not.toContain('EACCES');
  });

  it('contains an asynchronous rejection just as well as a synchronous throw', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await withAdmin(async () => {
      await Promise.resolve();
      return Promise.reject(new Error('the database went away mid-query'));
    })(authed(), undefined);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: 'internal error' });
  });

  it('survives a handler that throws something which is not an Error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await withAdmin(async () => {
      throw 'a bare string, thrown by a careless dependency';
    })(authed(), undefined);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: 'internal error' });
  });

  it('logs the failure, with the path, but never a recipient address (§12)', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await withAdmin(async () => {
      throw new Error('SES rejected victim@example.com while sending');
    })(authed('/api/admin/campaigns/abc/actions'), undefined);

    expect(response.status).toBe(500);
    expect(errorLog).toHaveBeenCalledTimes(1);

    const line = String(errorLog.mock.calls[0]?.[0]);
    // Operators still need to know something broke, and where.
    expect(line).toContain('admin route failed');
    expect(line).toContain('/api/admin/campaigns/abc/actions');
    // But an email address is never written to application logs.
    expect(line).not.toContain('victim@example.com');
    expect(line).toContain('[redacted]@example.com');
  });

  it('wraps the real admin routes, not just test doubles', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // A route whose own params resolution explodes still answers cleanly.
    const response = await subscriberDetailGet(
      authed('/api/admin/subscribers/abc'),
      { params: Promise.reject(new Error('route params unavailable: /var/run/next.sock')) },
    );

    expect(response.status).toBe(500);
    const raw = await response.text();
    expect(JSON.parse(raw)).toEqual({ ok: false, error: 'internal error' });
    expect(raw).not.toContain('next.sock');
  });
});

describe('badRequest and notFound', () => {
  it('shapes a 400 with the supplied message', async () => {
    const response = badRequest('a valid listId is required');

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({
      ok: false,
      error: 'a valid listId is required',
    });
  });

  it('shapes a 404, with a default message and an override', async () => {
    expect(notFound().status).toBe(404);
    expect(await notFound().json()).toEqual({ ok: false, error: 'not found' });
    expect(await notFound('subscriber not found').json()).toEqual({
      ok: false,
      error: 'subscriber not found',
    });
  });
});

describe('toObjectId', () => {
  it('round-trips a real id', () => {
    const id = new ObjectId();
    expect(toObjectId(id.toHexString())?.equals(id)).toBe(true);
  });

  it('accepts uppercase hex and normalises it', () => {
    const id = new ObjectId();
    const upper = id.toHexString().toUpperCase();
    expect(toObjectId(upper)?.equals(id)).toBe(true);
  });

  it('returns null for anything that is not an id, without throwing', () => {
    const id = new ObjectId().toHexString();
    for (const value of [
      undefined,
      '',
      '   ',
      'not-an-object-id',
      id.slice(0, 23),
      `${id}1`,
      ` ${id} `,
      '../../etc/passwd',
      'zzzzzzzzzzzzzzzzzzzzzzzz',
    ]) {
      expect(toObjectId(value)).toBeNull();
    }
  });

  it('never hands a Mongo operator object back to a query (§12)', () => {
    // Path params are attacker-controlled; the only two possible outcomes are
    // an ObjectId or null, so an operator document can never reach a filter.
    for (const value of ['{"$ne":null}', '$ne', '{"$gt":""}', '[object Object]']) {
      const result = toObjectId(value);
      expect(result).toBeNull();
    }
  });
});

describe('readJson', () => {
  it('returns the parsed object for a JSON object body', async () => {
    const body = await readJson(jsonRequest(JSON.stringify({ listId: 'abc', nested: { a: 1 } })));
    expect(body).toEqual({ listId: 'abc', nested: { a: 1 } });
  });

  it('returns null for a JSON array, so a route can never index into one', async () => {
    expect(await readJson(jsonRequest('[]'))).toBeNull();
    expect(await readJson(jsonRequest('[{"listId":"abc"}]'))).toBeNull();
  });

  it('returns null for JSON that is not an object', async () => {
    for (const body of ['"a string"', '42', 'null', 'true']) {
      expect(await readJson(jsonRequest(body))).toBeNull();
    }
  });

  it('returns null rather than throwing for malformed or absent JSON', async () => {
    expect(await readJson(jsonRequest('{ not json at all'))).toBeNull();
    expect(await readJson(jsonRequest(''))).toBeNull();
    expect(
      await readJson(new Request(`${URL_BASE}/api/admin/thing`, { method: 'POST' })),
    ).toBeNull();
  });
});
