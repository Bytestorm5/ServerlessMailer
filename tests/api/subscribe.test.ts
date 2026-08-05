import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { POST } from '@/app/api/subscribe/route';
import {
  rateLimitsCollection,
  subscribersCollection,
  suppressionsCollection,
} from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import { setMxResolver, resetMxResolver } from '@/lib/email/mx';
import { hashConfirmToken } from '@/lib/crypto/tokens';
import { resetSesAdapter, setSesAdapter } from '@/lib/ses/registry';
import { setTurnstileVerifier, resetTurnstileVerifier } from '@/lib/turnstile';
import { addSuppression } from '@/lib/suppressions';
import { createList, createSubscriber } from '@tests/helpers/factories';
import { FakeSes } from '@tests/helpers/fake-ses';
import type { ListDoc } from '@/lib/types';

let list: ListDoc;
let ses: FakeSes;

beforeEach(async () => {
  await ensureIndexes();
  await Promise.all([
    (await subscribersCollection()).deleteMany({}),
    (await suppressionsCollection()).deleteMany({}),
    (await rateLimitsCollection()).deleteMany({}),
  ]);
  list = await createList();
  ses = new FakeSes();
  setSesAdapter(ses);
  setMxResolver(async () => [{ exchange: 'mx.example.com', priority: 10 }]);
});

afterEach(() => {
  resetSesAdapter();
  resetMxResolver();
  resetTurnstileVerifier();
});

function subscribe(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return POST(
    new Request('https://mail.example.com/api/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5', ...headers },
      body: JSON.stringify({ listId: list._id.toHexString(), ...body }),
    }),
  );
}

async function bodyOf(response: Response) {
  return { status: response.status, json: await response.json() };
}

describe('POST /api/subscribe — happy path', () => {
  it('creates a pending subscriber and sends the confirmation email immediately', async () => {
    const response = await subscribe({ email: 'New@Example.com ' });

    expect(response.status).toBe(200);
    const doc = await (await subscribersCollection()).findOne({});
    expect(doc?.email).toBe('new@example.com');
    expect(doc?.status).toBe('pending');
    expect(doc?.source).toBe('web_form');

    // §5.1 step 7: this is a transactional send and does NOT go through the
    // campaign cron.
    expect(ses.simpleSends).toHaveLength(1);
    expect(ses.simpleSends[0].to).toBe('new@example.com');
    expect(ses.bulkSends).toHaveLength(0);
  });

  it('stores first and last name first-party, in either spelling', async () => {
    await subscribe({ email: 'camel@example.com', firstName: 'Ada', lastName: 'Lovelace' });
    await subscribe(
      { email: 'snake@example.com', first_name: 'Grace', last_name: 'Hopper' },
      { 'x-forwarded-for': '203.0.113.6' },
    );

    const camel = await (await subscribersCollection()).findOne({ email: 'camel@example.com' });
    expect(camel?.firstName).toBe('Ada');
    expect(camel?.lastName).toBe('Lovelace');

    const snake = await (await subscribersCollection()).findOne({ email: 'snake@example.com' });
    expect(snake?.firstName).toBe('Grace');
    expect(snake?.lastName).toBe('Hopper');
  });

  it('routes name keys sent inside attributes to the first-party fields', async () => {
    await subscribe({
      email: 'nested@example.com',
      attributes: { first_name: 'Ada', city: 'London' },
    });

    const doc = await (await subscribersCollection()).findOne({ email: 'nested@example.com' });
    expect(doc?.firstName).toBe('Ada');
    expect(doc?.attributes).toEqual({ city: 'London' });
  });

  it('stores only the HMAC hash of the token, with a 7-day expiry', async () => {
    await subscribe({ email: 'hashed@example.com' });

    const doc = await (await subscribersCollection()).findOne({});
    expect(doc?.confirmTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(doc?.confirmTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 6 * 864e5);

    // The raw token is only ever in the email; it must match the stored hash.
    const link = ses.simpleSends[0].content.text.match(/token=([^\s]+)/)![1];
    expect(hashConfirmToken(decodeURIComponent(link))).toBe(doc?.confirmTokenHash);
  });

  it('captures declared attributes', async () => {
    await subscribe({ email: 'attrs@example.com', attributes: { city: 'London' } });

    const doc = await (await subscribersCollection()).findOne({});
    expect(doc?.attributes).toEqual({ city: 'London' });
  });
});

describe('POST /api/subscribe — enumeration resistance', () => {
  it('returns a byte-identical response for new, pending, confirmed and suppressed', async () => {
    // §5.1: any variation is an email enumeration oracle.
    await createSubscriber(list._id, { email: 'pending@example.com', status: 'pending' });
    await createSubscriber(list._id, { email: 'confirmed@example.com', status: 'confirmed' });
    await addSuppression({ email: 'suppressed@example.com', reason: 'complaint' });

    const responses = await Promise.all([
      subscribe({ email: 'brand-new@example.com' }),
      subscribe({ email: 'pending@example.com' }),
      subscribe({ email: 'confirmed@example.com' }),
      subscribe({ email: 'suppressed@example.com' }),
    ]);

    const shapes = await Promise.all(responses.map(bodyOf));
    for (const shape of shapes) {
      expect(shape.status).toBe(shapes[0].status);
      expect(shape.json).toEqual(shapes[0].json);
    }
  });

  it('does nothing at all for a suppressed address', async () => {
    // A suppressed address must never be resurrected, and must never be told
    // that it is suppressed.
    await addSuppression({ email: 'blocked@example.com', reason: 'hard_bounce' });

    const response = await subscribe({ email: 'blocked@example.com' });

    expect(response.status).toBe(200);
    expect(await (await subscribersCollection()).countDocuments()).toBe(0);
    expect(ses.simpleSends).toHaveLength(0);
  });

  it('does not re-send a confirmation to an already-confirmed address', async () => {
    await createSubscriber(list._id, { email: 'done@example.com', status: 'confirmed' });

    await subscribe({ email: 'done@example.com' });

    expect(ses.simpleSends).toHaveLength(0);
    const doc = await (await subscribersCollection()).findOne({ email: 'done@example.com' });
    expect(doc?.status).toBe('confirmed');
  });
});

describe('POST /api/subscribe — abuse controls', () => {
  it('silently accepts and ignores a submission with the honeypot filled', async () => {
    const response = await subscribe({ email: 'bot@example.com', website: 'http://spam' });

    expect(response.status).toBe(200);
    expect(await (await subscribersCollection()).countDocuments()).toBe(0);
    expect(ses.simpleSends).toHaveLength(0);
  });

  it('rate limits by IP address', async () => {
    for (let i = 0; i < 20; i += 1) {
      await subscribe({ email: `flood-${i}@example.com` });
    }
    const response = await subscribe({ email: 'flood-21@example.com' });

    expect(response.status).toBe(429);
  });

  it('rate limits confirmation resends to once per hour per address', async () => {
    await subscribe({ email: 'resend@example.com' });
    expect(ses.simpleSends).toHaveLength(1);

    // Same address, different IP — the per-address limit still applies.
    await subscribe({ email: 'resend@example.com' }, { 'x-forwarded-for': '198.51.100.1' });
    await subscribe({ email: 'resend@example.com' }, { 'x-forwarded-for': '198.51.100.2' });

    expect(ses.simpleSends).toHaveLength(1);
  });

  it('still returns the generic success response when the resend is throttled', async () => {
    await subscribe({ email: 'throttled@example.com' });
    const first = await bodyOf(await subscribe({ email: 'fresh@example.com' }));
    const second = await bodyOf(
      await subscribe({ email: 'throttled@example.com' }, { 'x-forwarded-for': '198.51.100.7' }),
    );

    expect(second).toEqual(first);
  });

  it('rejects the submission when Turnstile verification fails', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    setTurnstileVerifier(async () => false);
    try {
      const response = await subscribe({ email: 'turnstile@example.com', turnstileToken: 'bad' });
      expect(response.status).toBe(400);
      expect(await (await subscribersCollection()).countDocuments()).toBe(0);
    } finally {
      delete process.env.TURNSTILE_SECRET_KEY;
    }
  });

  it('skips Turnstile entirely when no secret is configured', async () => {
    const response = await subscribe({ email: 'noturnstile@example.com' });
    expect(response.status).toBe(200);
  });
});

describe('POST /api/subscribe — validation', () => {
  it('rejects a syntactically invalid address', async () => {
    const response = await subscribe({ email: 'not-an-email' });
    expect(response.status).toBe(400);
    expect(await (await subscribersCollection()).countDocuments()).toBe(0);
  });

  it('rejects an address whose domain has no MX record', async () => {
    // §5.1 step 3. Accepting these guarantees a hard bounce later, which is
    // exactly what damages the bounce rate.
    setMxResolver(async () => []);

    const response = await subscribe({ email: 'nomx@nowhere.example' });
    expect(response.status).toBe(400);
    expect(ses.simpleSends).toHaveLength(0);
  });

  it('rejects a missing or unknown list', async () => {
    expect((await subscribe({ email: 'a@example.com', listId: undefined })).status).toBe(400);
    expect(
      (await subscribe({ email: 'a@example.com', listId: new ObjectId().toHexString() })).status,
    ).toBe(400);
  });

  it('rejects an inactive list', async () => {
    const inactive = await createList({ name: 'Retired', active: false });
    const response = await POST(
      new Request('https://mail.example.com/api/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'a@example.com', listId: inactive._id.toHexString() }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it('accepts a form-encoded submission as well as JSON', async () => {
    const response = await POST(
      new Request('https://mail.example.com/api/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          email: 'form@example.com',
          listId: list._id.toHexString(),
        }).toString(),
      }),
    );

    expect(response.status).toBe(200);
    expect(await (await subscribersCollection()).countDocuments()).toBe(1);
  });

  it('handles a malformed body without throwing', async () => {
    const response = await POST(
      new Request('https://mail.example.com/api/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      }),
    );
    expect(response.status).toBe(400);
  });

  it('still succeeds for the reader when the confirmation send fails', async () => {
    // The subscriber record is written before SES is called. If SES is having a
    // bad day we keep the pending record so a resend can recover it, rather
    // than losing the signup entirely.
    ses.failAddresses.add('sesdown@example.com');

    const response = await subscribe({ email: 'sesdown@example.com' });

    expect(response.status).toBe(200);
    expect(await (await subscribersCollection()).countDocuments()).toBe(1);
  });
});
