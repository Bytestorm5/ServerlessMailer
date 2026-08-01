import { beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { GET, POST } from '@/app/api/unsubscribe/route';
import { buildRecipientToken } from '@/lib/crypto/tokens';
import { subscribersCollection, suppressionsCollection } from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import { isSuppressed } from '@/lib/suppressions';
import { createCampaign, createList, createSubscriber } from '@tests/helpers/factories';
import type { CampaignDoc, ListDoc, SubscriberDoc } from '@/lib/types';

let list: ListDoc;
let campaign: CampaignDoc;
let subscriber: SubscriberDoc;
let token: string;

beforeEach(async () => {
  await ensureIndexes();
  await Promise.all([
    (await subscribersCollection()).deleteMany({}),
    (await suppressionsCollection()).deleteMany({}),
  ]);
  list = await createList();
  campaign = await createCampaign(list._id);
  subscriber = await createSubscriber(list._id, { email: 'reader@example.com' });
  token = buildRecipientToken(subscriber._id.toHexString(), campaign._id.toHexString());
});

function url(t?: string) {
  return `https://mail.example.com/api/unsubscribe${t === undefined ? '' : `?t=${encodeURIComponent(t)}`}`;
}

async function status(id: ObjectId) {
  return (await (await subscribersCollection()).findOne({ _id: id }))?.status;
}

describe('POST /api/unsubscribe (one-click)', () => {
  it('unsubscribes immediately and returns 200 with no confirmation step', async () => {
    // §9.1: the POST endpoint must unsubscribe immediately with no confirmation
    // step and no landing page, and return 200 fast.
    const response = await POST(new Request(url(token), { method: 'POST' }));

    expect(response.status).toBe(200);
    expect(await status(subscriber._id)).toBe('unsubscribed');
  });

  it('records the source as one_click', async () => {
    await POST(new Request(url(token), { method: 'POST' }));

    const doc = await (await subscribersCollection()).findOne({ _id: subscriber._id });
    expect(doc?.unsubscribeSource).toBe('one_click');
    expect(doc?.unsubscribedAt).toBeInstanceOf(Date);
  });

  it('accepts the token from a form-encoded body as well as the query string', async () => {
    const response = await POST(
      new Request('https://mail.example.com/api/unsubscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ t: token, 'List-Unsubscribe': 'One-Click' }).toString(),
      }),
    );

    expect(response.status).toBe(200);
    expect(await status(subscriber._id)).toBe('unsubscribed');
  });

  it('is idempotent when a provider retries', async () => {
    await POST(new Request(url(token), { method: 'POST' }));
    const second = await POST(new Request(url(token), { method: 'POST' }));

    expect(second.status).toBe(200);
    expect(await status(subscriber._id)).toBe('unsubscribed');
  });

  it('still returns 200 for a missing or forged token', async () => {
    // A non-200 here is read by mailbox providers as a broken unsubscribe,
    // which is worse for reputation than silently ignoring a bad token.
    expect((await POST(new Request(url(), { method: 'POST' }))).status).toBe(200);
    expect((await POST(new Request(url('garbage'), { method: 'POST' }))).status).toBe(200);

    const forged = `${token.split('.')[0]}.AAAA`;
    expect((await POST(new Request(url(forged), { method: 'POST' }))).status).toBe(200);
    expect(await status(subscriber._id)).toBe('confirmed');
  });

  it('does not add the address to the global suppression list', async () => {
    await POST(new Request(url(token), { method: 'POST' }));
    expect(await isSuppressed('reader@example.com')).toBe(false);
  });

  it('does not leak whether the token matched', async () => {
    const good = await POST(new Request(url(token), { method: 'POST' }));
    const bad = await POST(new Request(url('nope'), { method: 'POST' }));

    expect(good.status).toBe(bad.status);
  });
});

describe('GET /api/unsubscribe (human page)', () => {
  it('unsubscribes and renders a confirmation page', async () => {
    const response = await GET(new Request(url(token)));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const body = await response.text();
    expect(body).toMatch(/unsubscribed/i);
    expect(await status(subscriber._id)).toBe('unsubscribed');
  });

  it('offers a resubscribe option', async () => {
    const response = await GET(new Request(url(token)));
    const body = await response.text();

    expect(body).toMatch(/resubscribe|subscribe again/i);
    expect(body).toContain(token);
  });

  it('names the list so the reader knows what they left', async () => {
    const response = await GET(new Request(url(token)));
    expect(await response.text()).toContain('Domain A Weekly');
  });

  it('shows a friendly page rather than an error for a bad token', async () => {
    const response = await GET(new Request(url('not-a-real-token')));

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toMatch(/stack|Error:/i);
    expect(body).toMatch(/link/i);
  });

  it('is not cacheable by an intermediary', async () => {
    // Caching a per-recipient page and serving it to somebody else would
    // unsubscribe the wrong person.
    const response = await GET(new Request(url(token)));
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('escapes the list name so it cannot inject markup', async () => {
    const evilList = await createList({ name: '<script>alert(1)</script>' });
    const evilCampaign = await createCampaign(evilList._id);
    const evilSub = await createSubscriber(evilList._id, { email: 'x@example.com' });
    const evilToken = buildRecipientToken(
      evilSub._id.toHexString(),
      evilCampaign._id.toHexString(),
    );

    const body = await (await GET(new Request(url(evilToken)))).text();
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;');
  });
});

describe('POST /api/unsubscribe?action=resubscribe', () => {
  it('restores a previously unsubscribed reader', async () => {
    await POST(new Request(url(token), { method: 'POST' }));
    expect(await status(subscriber._id)).toBe('unsubscribed');

    const response = await POST(
      new Request(`${url(token)}&action=resubscribe`, { method: 'POST' }),
    );

    expect(response.status).toBe(200);
    expect(await status(subscriber._id)).toBe('confirmed');
  });

  it('refuses to resubscribe a bounced address', async () => {
    await (await subscribersCollection()).updateOne(
      { _id: subscriber._id },
      { $set: { status: 'bounced' } },
    );

    await POST(new Request(`${url(token)}&action=resubscribe`, { method: 'POST' }));
    expect(await status(subscriber._id)).toBe('bounced');
  });
});
