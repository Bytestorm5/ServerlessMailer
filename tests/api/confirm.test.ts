import { beforeEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/confirm/route';
import { generateConfirmToken } from '@/lib/crypto/tokens';
import { subscribersCollection } from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import { setConfirmToken, upsertPendingSubscriber } from '@/lib/subscribers';
import { createList } from '@tests/helpers/factories';
import type { ListDoc, SubscriberDoc } from '@/lib/types';

let list: ListDoc;

beforeEach(async () => {
  await ensureIndexes();
  await (await subscribersCollection()).deleteMany({});
  list = await createList();
});

async function seedPending(email = 'reader@example.com', expiresAt?: Date) {
  const { subscriber } = await upsertPendingSubscriber({
    listId: list._id,
    email,
    source: 'web_form',
  });
  const generated = generateConfirmToken();
  await setConfirmToken(subscriber._id, generated.tokenHash, expiresAt ?? generated.expiresAt);
  return { subscriber, token: generated.token };
}

function confirmRequest(token: string, headers: Record<string, string> = {}) {
  return new Request(`https://mail.example.com/api/confirm?token=${encodeURIComponent(token)}`, {
    headers,
  });
}

async function reload(id: SubscriberDoc['_id']) {
  return (await subscribersCollection()).findOne({ _id: id });
}

describe('GET /api/confirm', () => {
  it('confirms the subscriber and redirects to the welcome page', async () => {
    const { subscriber, token } = await seedPending();

    const response = await GET(confirmRequest(token));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://domain-a.com/welcome');
    expect((await reload(subscriber._id))?.status).toBe('confirmed');
  });

  it('records the consent evidence from the request', async () => {
    // §5.3: confirmedAt, confirmIp and confirmUserAgent together constitute the
    // proof of opt-in — the record produced if a complaint is escalated.
    const { subscriber, token } = await seedPending();

    await GET(
      confirmRequest(token, {
        'x-forwarded-for': '203.0.113.42, 70.41.3.18',
        'user-agent': 'Mozilla/5.0 (Macintosh)',
      }),
    );

    const doc = await reload(subscriber._id);
    expect(doc?.confirmedAt).toBeInstanceOf(Date);
    // The client IP is the first entry; the rest are proxies.
    expect(doc?.confirmIp).toBe('203.0.113.42');
    expect(doc?.confirmUserAgent).toBe('Mozilla/5.0 (Macintosh)');
  });

  it('clears the token so the link cannot be replayed', async () => {
    const { subscriber, token } = await seedPending();
    await GET(confirmRequest(token));

    expect((await reload(subscriber._id))?.confirmTokenHash).toBeUndefined();

    const replay = await GET(confirmRequest(token));
    expect(replay.status).toBe(200);
    expect(await replay.text()).toMatch(/no longer valid|start over|again/i);
  });

  it('shows a friendly page for an expired token, not a raw error', async () => {
    const { token } = await seedPending('expired@example.com', new Date(Date.now() - 1000));

    const response = await GET(confirmRequest(token));

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toMatch(/expired/i);
    expect(body).toMatch(/again|start over/i);
    expect(body).not.toMatch(/stack|TypeError|Error:/);
  });

  it('shows a friendly page for an unknown token', async () => {
    const response = await GET(confirmRequest('completely-made-up-token'));

    expect(response.status).toBe(200);
    expect(await response.text()).not.toMatch(/stack|TypeError/);
  });

  it('handles a missing token parameter', async () => {
    const response = await GET(new Request('https://mail.example.com/api/confirm'));
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/link/i);
  });

  it('falls back to a built-in page when the list has no welcome URL', async () => {
    const bare = await createList({ name: 'No Welcome', welcomeUrl: undefined });
    const { subscriber } = await upsertPendingSubscriber({
      listId: bare._id,
      email: 'bare@example.com',
      source: 'web_form',
    });
    const generated = generateConfirmToken();
    await setConfirmToken(subscriber._id, generated.tokenHash, generated.expiresAt);

    const response = await GET(confirmRequest(generated.token));

    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/confirmed|subscribed/i);
    expect((await reload(subscriber._id))?.status).toBe('confirmed');
  });

  it('refuses to redirect to an attacker-supplied URL', async () => {
    // The redirect target comes from the list configuration only. A `next`
    // parameter would turn the confirmation endpoint into an open redirect.
    const { token } = await seedPending();
    const response = await GET(
      new Request(
        `https://mail.example.com/api/confirm?token=${encodeURIComponent(token)}&next=https://evil.example`,
      ),
    );

    expect(response.headers.get('location')).toBe('https://domain-a.com/welcome');
  });

  it('does not cache the response', async () => {
    const { token } = await seedPending();
    const response = await GET(confirmRequest(token));
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('takes the client IP from x-real-ip when no forwarded header is present', async () => {
    const { subscriber, token } = await seedPending('realip@example.com');
    await GET(confirmRequest(token, { 'x-real-ip': '198.51.100.9' }));

    expect((await reload(subscriber._id))?.confirmIp).toBe('198.51.100.9');
  });
});
