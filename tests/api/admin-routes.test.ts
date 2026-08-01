import { beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { ADMIN_COOKIE_NAME, createSessionToken } from '@/lib/auth';
import {
  campaignsCollection,
  eventsCollection,
  importAttestationsCollection,
  listsCollection,
  rateLimitsCollection,
  sentLogCollection,
  subscribersCollection,
  suppressionsCollection,
} from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import { unsubscribeSubscriber } from '@/lib/subscribers';
import {
  createCampaign,
  createList,
  createSubscriber,
  createSuppression,
  emptyCounts,
} from '@tests/helpers/factories';
import type { EventDoc, ListDoc, SentLogDoc } from '@/lib/types';

import { GET as statsGet } from '@/app/api/admin/stats/route';
import { GET as subscriberGet } from '@/app/api/admin/subscribers/[id]/route';
import { DELETE as sessionDelete } from '@/app/api/admin/session/route';
import { POST as importPost } from '@/app/api/admin/import/route';

/**
 * Admin surfaces not covered by `admin.test.ts`: the dashboard, the individual
 * subscriber record (spec §4.5/§5.3), sign-out, and CSV import validation
 * (§4.3).
 */

const AUTH = { cookie: `${ADMIN_COOKIE_NAME}=${createSessionToken('admin')}` };
const url = (path: string) => `https://mail.example.com${path}`;

function req(path: string, init: RequestInit = {}, authed = true): Request {
  return new Request(url(path), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(authed ? AUTH : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const post = (path: string, body: unknown, authed = true) =>
  req(path, { method: 'POST', body: JSON.stringify(body) }, authed);

let list: ListDoc;

beforeEach(async () => {
  await ensureIndexes();
  await Promise.all([
    (await listsCollection()).deleteMany({}),
    (await campaignsCollection()).deleteMany({}),
    (await subscribersCollection()).deleteMany({}),
    (await suppressionsCollection()).deleteMany({}),
    (await sentLogCollection()).deleteMany({}),
    (await eventsCollection()).deleteMany({}),
    (await importAttestationsCollection()).deleteMany({}),
    (await rateLimitsCollection()).deleteMany({}),
  ]);
  list = await createList();
});

/* ------------------------------------------------------------------ stats */

describe('GET /api/admin/stats', () => {
  it('requires a session', async () => {
    const response = await statsGet(req('/api/admin/stats', {}, false), undefined);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('leads with the account reputation, computed from real campaign counts', async () => {
    const now = Date.now();
    await createCampaign(list._id, {
      status: 'sent',
      startedAt: new Date(now - 2 * 60 * 60 * 1000),
      completedAt: new Date(now - 60 * 60 * 1000),
      counts: { ...emptyCounts(), sent: 1000, delivered: 940, bounced: 60, complained: 6 },
    });
    // Outside the 30-day window: a catastrophe from two months ago must not be
    // presented as today's reputation.
    await createCampaign(list._id, {
      status: 'sent',
      startedAt: new Date(now - 60 * 24 * 60 * 60 * 1000),
      completedAt: new Date(now - 60 * 24 * 60 * 60 * 1000),
      counts: { ...emptyCounts(), sent: 1000, delivered: 0, bounced: 1000 },
    });

    const response = await statsGet(req('/api/admin/stats'), undefined);
    const body = await response.json();

    expect(response.status).toBe(200);
    // §8.3: reputation is surfaced prominently, not buried in a metrics tab.
    expect(Object.keys(body).slice(0, 2)).toEqual(['ok', 'reputation']);

    expect(body.reputation.campaigns).toBe(1);
    expect(body.reputation.sent).toBe(1000);
    expect(body.reputation.bounced).toBe(60);
    expect(body.reputation.bounceRate).toBeCloseTo(0.06, 10);
    expect(body.reputation.complaintRate).toBeCloseTo(0.006, 10);
    // 6% bounces is over the 5% review threshold; 0.6% complaints is over the
    // 0.5% suspension threshold.
    expect(body.reputation.bounceStatus).toBe('at_risk');
    expect(body.reputation.complaintStatus).toBe('critical');
  });

  it('reports per-list subscriber counts without leaking across lists', async () => {
    const other = await createList({ name: 'Domain B Weekly', sendingDomain: 'news.domain-b.com' });

    await createSubscriber(list._id, { email: 'a1@example.com' });
    await createSubscriber(list._id, { email: 'a2@example.com' });
    await createSubscriber(list._id, { email: 'a3@example.com', status: 'pending' });
    await createSubscriber(list._id, { email: 'a4@example.com', status: 'unsubscribed' });
    await createSubscriber(other._id, { email: 'b1@example.com' });
    await createSubscriber(other._id, { email: 'b2@example.com', status: 'pending' });
    await createSubscriber(other._id, { email: 'b3@example.com', status: 'pending' });

    const body = await (await statsGet(req('/api/admin/stats'), undefined)).json();
    const byId = new Map<string, Record<string, number>>(
      body.lists.map((entry: { id: string }) => [entry.id, entry as unknown as Record<string, number>]),
    );

    expect(body.lists).toHaveLength(2);
    expect(byId.get(list._id.toHexString())).toMatchObject({
      name: 'Domain A Weekly',
      sendingDomain: 'news.domain-a.com',
      confirmed: 2,
      pending: 1,
      unsubscribed: 1,
    });
    expect(byId.get(other._id.toHexString())).toMatchObject({
      name: 'Domain B Weekly',
      sendingDomain: 'news.domain-b.com',
      confirmed: 1,
      pending: 2,
      unsubscribed: 0,
    });
  });

  it('scopes each list’s reputation to that list', async () => {
    const other = await createList({ name: 'Domain B Weekly', sendingDomain: 'news.domain-b.com' });
    const startedAt = new Date(Date.now() - 60 * 60 * 1000);

    await createCampaign(list._id, {
      status: 'sent',
      startedAt,
      completedAt: startedAt,
      counts: { ...emptyCounts(), sent: 1000, delivered: 900, bounced: 100 },
    });
    await createCampaign(other._id, {
      status: 'sent',
      startedAt,
      completedAt: startedAt,
      counts: { ...emptyCounts(), sent: 1000, delivered: 1000, bounced: 0 },
    });

    const body = await (await statsGet(req('/api/admin/stats'), undefined)).json();
    const byId = new Map(body.lists.map((entry: { id: string }) => [entry.id, entry]));
    const bad = byId.get(list._id.toHexString()) as { reputation: Record<string, unknown> };
    const good = byId.get(other._id.toHexString()) as { reputation: Record<string, unknown> };

    expect(bad.reputation.bounced).toBe(100);
    expect(bad.reputation.bounceRate).toBeCloseTo(0.1, 10);
    expect(bad.reputation.bounceStatus).toBe('critical');

    // The healthy list must not inherit the other domain's numbers.
    expect(good.reputation.bounced).toBe(0);
    expect(good.reputation.bounceRate).toBe(0);
    expect(good.reputation.bounceStatus).toBe('ok');

    // The account-level figure, which is what SES actually suspends on, spans
    // both lists.
    expect(body.reputation.sent).toBe(2000);
    expect(body.reputation.bounced).toBe(100);
    expect(body.reputation.bounceRate).toBeCloseTo(0.05, 10);
  });

  it('counts the global suppression list', async () => {
    await createSuppression({ email: 'one@example.com' });
    await createSuppression({ email: 'two@example.com', reason: 'complaint' });
    await createSuppression({ email: 'three@example.com', reason: 'manual' });

    const body = await (await statsGet(req('/api/admin/stats'), undefined)).json();
    expect(body.suppressions).toBe(3);
  });

  it('returns the ten most recent campaigns, newest first', async () => {
    const base = Date.now();
    for (let i = 0; i < 12; i += 1) {
      await createCampaign(list._id, {
        subject: `Campaign ${i}`,
        createdAt: new Date(base - i * 60_000),
      });
    }

    const body = await (await statsGet(req('/api/admin/stats'), undefined)).json();

    expect(body.recentCampaigns).toHaveLength(10);
    expect(body.recentCampaigns.map((c: { subject: string }) => c.subject)).toEqual(
      Array.from({ length: 10 }, (_, i) => `Campaign ${i}`),
    );
  });

  it('summarises each recent campaign with its status, counts and completion', async () => {
    const completedAt = new Date(Date.now() - 30 * 60 * 1000);
    const campaign = await createCampaign(list._id, {
      subject: 'Finished',
      status: 'sent',
      startedAt: completedAt,
      completedAt,
      counts: { ...emptyCounts(), recipients: 5, sent: 5, delivered: 5 },
    });
    await createCampaign(list._id, {
      subject: 'Still a draft',
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const body = await (await statsGet(req('/api/admin/stats'), undefined)).json();
    const sent = body.recentCampaigns.find((c: { subject: string }) => c.subject === 'Finished');
    const draft = body.recentCampaigns.find(
      (c: { subject: string }) => c.subject === 'Still a draft',
    );

    expect(sent.id).toBe(campaign._id.toHexString());
    expect(sent.status).toBe('sent');
    expect(sent.counts.sent).toBe(5);
    expect(new Date(sent.completedAt).getTime()).toBe(completedAt.getTime());
    // A campaign that has not completed reports null rather than dropping the key.
    expect(draft.status).toBe('draft');
    expect(draft.completedAt).toBeNull();
  });

  it('answers with empty structures rather than failing on a fresh install', async () => {
    await (await listsCollection()).deleteMany({});

    const response = await statsGet(req('/api/admin/stats'), undefined);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.lists).toEqual([]);
    expect(body.recentCampaigns).toEqual([]);
    expect(body.suppressions).toBe(0);
    expect(body.reputation.bounceRate).toBe(0);
    expect(body.reputation.complaintRate).toBe(0);
    expect(body.reputation.bounceStatus).toBe('ok');
  });
});

/* ------------------------------------------------- subscriber detail (§5.3) */

describe('GET /api/admin/subscribers/[id]', () => {
  it('requires a session', async () => {
    const subscriber = await createSubscriber(list._id, { email: 'private@example.com' });

    const response = await subscriberGet(
      req(`/api/admin/subscribers/${subscriber._id}`, {}, false),
      params(subscriber._id.toHexString()),
    );

    expect(response.status).toBe(401);
    // The consent record is PII; an unauthenticated caller sees none of it.
    expect(await response.text()).not.toContain('private@example.com');
  });

  it('answers 400 for a malformed id', async () => {
    const response = await subscriberGet(
      req('/api/admin/subscribers/nonsense'),
      params('nonsense'),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: 'invalid subscriber id' });
  });

  it('answers 404 for a well-formed id that does not exist', async () => {
    const unknown = new ObjectId().toHexString();
    const response = await subscriberGet(
      req(`/api/admin/subscribers/${unknown}`),
      params(unknown),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: 'subscriber not found' });
  });

  it('returns the full consent evidence — the record produced if a complaint is escalated', async () => {
    const confirmedAt = new Date('2026-03-04T10:11:12.000Z');
    const subscriber = await createSubscriber(list._id, {
      email: 'ada@example.com',
      attributes: { first_name: 'Ada' },
      source: 'web_form',
      confirmedAt,
      confirmIp: '198.51.100.24',
      confirmUserAgent: 'Mozilla/5.0 (Macintosh) Safari/605.1.15',
    });

    const response = await subscriberGet(
      req(`/api/admin/subscribers/${subscriber._id}`),
      params(subscriber._id.toHexString()),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.subscriber).toMatchObject({
      id: subscriber._id.toHexString(),
      listId: list._id.toHexString(),
      email: 'ada@example.com',
      status: 'confirmed',
      source: 'web_form',
      attributes: { first_name: 'Ada' },
      suppressed: false,
    });
    // All three fields together are the proof of opt-in (§5.3).
    expect(new Date(body.subscriber.consent.confirmedAt).toISOString()).toBe(
      confirmedAt.toISOString(),
    );
    expect(body.subscriber.consent.confirmIp).toBe('198.51.100.24');
    expect(body.subscriber.consent.confirmUserAgent).toBe(
      'Mozilla/5.0 (Macintosh) Safari/605.1.15',
    );
  });

  it('still returns the consent evidence after the subscriber unsubscribes', async () => {
    const confirmedAt = new Date('2026-01-02T03:04:05.000Z');
    const subscriber = await createSubscriber(list._id, {
      email: 'gone@example.com',
      confirmedAt,
      confirmIp: '203.0.113.9',
      confirmUserAgent: 'Thunderbird/128.0',
    });

    const unsubscribedAt = new Date('2026-06-07T08:09:10.000Z');
    await unsubscribeSubscriber({
      subscriberId: subscriber._id,
      source: 'one_click',
      now: unsubscribedAt,
    });

    const body = await (
      await subscriberGet(
        req(`/api/admin/subscribers/${subscriber._id}`),
        params(subscriber._id.toHexString()),
      )
    ).json();

    // §5.3: never modified, never deleted — including after unsubscribe.
    expect(new Date(body.subscriber.consent.confirmedAt).toISOString()).toBe(
      confirmedAt.toISOString(),
    );
    expect(body.subscriber.consent.confirmIp).toBe('203.0.113.9');
    expect(body.subscriber.consent.confirmUserAgent).toBe('Thunderbird/128.0');

    expect(body.subscriber.status).toBe('unsubscribed');
    expect(new Date(body.subscriber.unsubscribedAt).toISOString()).toBe(
      unsubscribedAt.toISOString(),
    );
    expect(body.subscriber.unsubscribeSource).toBe('one_click');

    // The status history is the audit trail of how they got there (§4.5).
    expect(body.subscriber.history).toHaveLength(1);
    expect(body.subscriber.history[0]).toMatchObject({
      from: 'confirmed',
      to: 'unsubscribed',
      reason: 'unsubscribe:one_click',
    });
  });

  it('reports explicit nulls, not missing keys, for someone who never confirmed', async () => {
    const subscriber = await createSubscriber(list._id, {
      email: 'pending@example.com',
      status: 'pending',
    });

    const body = await (
      await subscriberGet(
        req(`/api/admin/subscribers/${subscriber._id}`),
        params(subscriber._id.toHexString()),
      )
    ).json();

    expect(body.subscriber.consent).toEqual({
      confirmedAt: null,
      confirmIp: null,
      confirmUserAgent: null,
    });
    expect(body.subscriber.unsubscribedAt).toBeNull();
    expect(body.subscriber.unsubscribeSource).toBeNull();
    expect(body.campaignsSent).toEqual([]);
    expect(body.events).toEqual([]);
  });

  it('lists the campaigns actually sent to this subscriber, newest first', async () => {
    const subscriber = await createSubscriber(list._id, { email: 'reader@example.com' });
    const older = await createCampaign(list._id, { subject: 'March issue' });
    const newer = await createCampaign(list._id, { subject: 'April issue' });
    const deleted = new ObjectId();

    await (await sentLogCollection()).insertMany([
      {
        _id: new ObjectId(),
        campaignId: older._id,
        subscriberId: subscriber._id,
        sentAt: new Date('2026-03-01T09:00:00.000Z'),
      },
      {
        _id: new ObjectId(),
        campaignId: newer._id,
        subscriberId: subscriber._id,
        sentAt: new Date('2026-04-01T09:00:00.000Z'),
      },
      {
        _id: new ObjectId(),
        campaignId: deleted,
        subscriberId: subscriber._id,
        sentAt: new Date('2026-02-01T09:00:00.000Z'),
      },
    ]);

    const body = await (
      await subscriberGet(
        req(`/api/admin/subscribers/${subscriber._id}`),
        params(subscriber._id.toHexString()),
      )
    ).json();

    expect(body.campaignsSent.map((c: { subject: string }) => c.subject)).toEqual([
      'April issue',
      'March issue',
      '(deleted)',
    ]);
    expect(body.campaignsSent[0].campaignId).toBe(newer._id.toHexString());
    expect(new Date(body.campaignsSent[0].sentAt).toISOString()).toBe(
      '2026-04-01T09:00:00.000Z',
    );
  });

  it('returns the events received, newest first, with click urls and diagnostics', async () => {
    const subscriber = await createSubscriber(list._id, { email: 'engaged@example.com' });
    const campaign = await createCampaign(list._id);

    await (await eventsCollection()).insertMany([
      {
        _id: new ObjectId(),
        campaignId: campaign._id,
        subscriberId: subscriber._id,
        type: 'delivered',
        ts: new Date('2026-05-01T10:00:00.000Z'),
      },
      {
        _id: new ObjectId(),
        campaignId: campaign._id,
        subscriberId: subscriber._id,
        type: 'click',
        ts: new Date('2026-05-01T12:00:00.000Z'),
        url: 'https://example.com/post',
      },
      {
        _id: new ObjectId(),
        campaignId: campaign._id,
        subscriberId: subscriber._id,
        type: 'bounce',
        ts: new Date('2026-05-01T11:00:00.000Z'),
        detail: 'smtp; 550 5.1.1 user unknown',
      },
    ]);

    const body = await (
      await subscriberGet(
        req(`/api/admin/subscribers/${subscriber._id}`),
        params(subscriber._id.toHexString()),
      )
    ).json();

    expect(body.events.map((e: { type: string }) => e.type)).toEqual([
      'click',
      'bounce',
      'delivered',
    ]);
    expect(body.events[0].url).toBe('https://example.com/post');
    expect(body.events[1].detail).toBe('smtp; 550 5.1.1 user unknown');
    // Non-click events report null rather than an absent key.
    expect(body.events[2].url).toBeNull();
    expect(body.events[0].detail).toBeNull();
  });

  it('never mixes in another subscriber’s sends or events', async () => {
    const subject = await createSubscriber(list._id, { email: 'subject@example.com' });
    const other = await createSubscriber(list._id, { email: 'other@example.com' });
    const campaign = await createCampaign(list._id, { subject: 'Not for you' });

    await (await sentLogCollection()).insertOne({
      _id: new ObjectId(),
      campaignId: campaign._id,
      subscriberId: other._id,
      sentAt: new Date(),
    });
    await (await eventsCollection()).insertOne({
      _id: new ObjectId(),
      campaignId: campaign._id,
      subscriberId: other._id,
      type: 'complaint',
      ts: new Date(),
    });

    const body = await (
      await subscriberGet(
        req(`/api/admin/subscribers/${subject._id}`),
        params(subject._id.toHexString()),
      )
    ).json();

    expect(body.subscriber.email).toBe('subject@example.com');
    expect(body.campaignsSent).toEqual([]);
    expect(body.events).toEqual([]);
  });

  it('flags an address that is on the global suppression list', async () => {
    const bounced = await createSubscriber(list._id, {
      email: 'bounced@example.com',
      status: 'bounced',
    });
    const clean = await createSubscriber(list._id, { email: 'clean@example.com' });
    await createSuppression({ email: 'bounced@example.com', reason: 'hard_bounce' });

    const suppressed = await (
      await subscriberGet(
        req(`/api/admin/subscribers/${bounced._id}`),
        params(bounced._id.toHexString()),
      )
    ).json();
    const ok = await (
      await subscriberGet(
        req(`/api/admin/subscribers/${clean._id}`),
        params(clean._id.toHexString()),
      )
    ).json();

    expect(suppressed.subscriber.suppressed).toBe(true);
    expect(ok.subscriber.suppressed).toBe(false);
  });

  it('caps the send and event history it returns', async () => {
    const subscriber = await createSubscriber(list._id, { email: 'veteran@example.com' });
    const base = new Date('2026-01-01T00:00:00.000Z').getTime();

    const sends: SentLogDoc[] = Array.from({ length: 105 }, (_, i) => ({
      _id: new ObjectId(),
      campaignId: new ObjectId(),
      subscriberId: subscriber._id,
      sentAt: new Date(base + i * 60_000),
    }));
    const events: EventDoc[] = Array.from({ length: 205 }, (_, i) => ({
      _id: new ObjectId(),
      subscriberId: subscriber._id,
      type: 'open' as const,
      ts: new Date(base + i * 60_000),
    }));
    await (await sentLogCollection()).insertMany(sends);
    await (await eventsCollection()).insertMany(events);

    const body = await (
      await subscriberGet(
        req(`/api/admin/subscribers/${subscriber._id}`),
        params(subscriber._id.toHexString()),
      )
    ).json();

    expect(body.campaignsSent).toHaveLength(100);
    expect(body.events).toHaveLength(200);
    // The cap keeps the newest, not an arbitrary page.
    expect(new Date(body.campaignsSent[0].sentAt).getTime()).toBe(base + 104 * 60_000);
    expect(new Date(body.events[0].ts).getTime()).toBe(base + 204 * 60_000);
  });
});

/* ---------------------------------------------------------------- sign-out */

describe('DELETE /api/admin/session', () => {
  it('clears the session cookie', async () => {
    const response = await sessionDelete();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${ADMIN_COOKIE_NAME}=;`);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    // The cleared cookie must not carry a token that would still verify.
    expect(cookie).not.toContain(createSessionToken('admin'));
  });

  it('leaves the browser with a cookie that no longer authenticates', async () => {
    const cleared = (await sessionDelete()).headers.get('set-cookie') ?? '';
    const pair = cleared.split(';')[0] as string;

    const response = await statsGet(
      new Request(url('/api/admin/stats'), { headers: { cookie: pair } }),
      undefined,
    );

    expect(response.status).toBe(401);
  });
});

/* ------------------------------------------------------------ CSV import  */

describe('POST /api/admin/import', () => {
  const CSV = 'email,first_name\nada@example.com,Ada\ngrace@example.com,Grace\n';
  const MAPPING = { email: 'email', attributes: { first_name: 'first_name' } };
  const ATTESTATION_TEXT =
    'I confirm every address in this file gave prior opt-in consent on domain-a.com, and I hold the records.';

  async function counts() {
    return {
      subscribers: await (await subscribersCollection()).countDocuments(),
      attestations: await (await importAttestationsCollection()).countDocuments(),
    };
  }

  it('requires a session and writes nothing without one', async () => {
    const response = await importPost(
      post(
        '/api/admin/import',
        {
          listId: list._id.toHexString(),
          csv: CSV,
          mapping: MAPPING,
          markConfirmed: true,
          attestation: { text: ATTESTATION_TEXT, by: 'ops@domain-a.com' },
        },
        false,
      ),
      undefined,
    );

    expect(response.status).toBe(401);
    expect(await counts()).toEqual({ subscribers: 0, attestations: 0 });
  });

  it('rejects a missing or malformed listId', async () => {
    for (const body of [
      { csv: CSV, mapping: MAPPING },
      { listId: '', csv: CSV, mapping: MAPPING },
      { listId: 'not-an-object-id', csv: CSV, mapping: MAPPING },
      { listId: 42, csv: CSV, mapping: MAPPING },
      { listId: { $ne: null }, csv: CSV, mapping: MAPPING },
    ]) {
      const response = await importPost(post('/api/admin/import', body), undefined);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('a valid listId is required');
    }

    expect(await counts()).toEqual({ subscribers: 0, attestations: 0 });
  });

  it('rejects an empty csv', async () => {
    for (const csv of ['', '   ', '\n\n  \n']) {
      const response = await importPost(
        post('/api/admin/import', { listId: list._id.toHexString(), csv, mapping: MAPPING }),
        undefined,
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('csv content is required');
    }

    expect(await counts()).toEqual({ subscribers: 0, attestations: 0 });
  });

  it('rejects a missing mapping.email', async () => {
    for (const mapping of [undefined, {}, { attributes: { a: 'b' } }, { email: 7 }, 'email']) {
      const response = await importPost(
        post('/api/admin/import', { listId: list._id.toHexString(), csv: CSV, mapping }),
        undefined,
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain('mapping.email');
    }

    expect(await counts()).toEqual({ subscribers: 0, attestations: 0 });
  });

  it('rejects a mapping that names a column the file does not have', async () => {
    const response = await importPost(
      post('/api/admin/import', {
        listId: list._id.toHexString(),
        csv: CSV,
        mapping: { email: 'E-Mail Address' },
      }),
      undefined,
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('E-Mail Address');
    expect(await counts()).toEqual({ subscribers: 0, attestations: 0 });
  });

  it('rejects a request body that is not a JSON object', async () => {
    for (const raw of ['[]', '[{"listId":"x"}]', '"listId"', 'not json at all', '']) {
      const response = await importPost(
        req('/api/admin/import', { method: 'POST', body: raw }),
        undefined,
      );
      expect(response.status).toBe(400);
    }

    expect(await counts()).toEqual({ subscribers: 0, attestations: 0 });
  });

  it('refuses markConfirmed without an attestation, and writes nothing at all (§4.3)', async () => {
    // Importing 33,000 addresses as `confirmed` on an operator's say-so is the
    // one action here with no undo, so the attestation is mandatory.
    for (const attestation of [
      undefined,
      { text: ATTESTATION_TEXT },
      { by: 'ops@domain-a.com' },
      { text: ATTESTATION_TEXT, by: 42 },
      'yes I promise',
    ]) {
      const response = await importPost(
        post('/api/admin/import', {
          listId: list._id.toHexString(),
          csv: CSV,
          mapping: MAPPING,
          markConfirmed: true,
          ...(attestation === undefined ? {} : { attestation }),
        }),
        undefined,
      );

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain('attestation');
      // Nothing is written on rejection: no subscribers, and no attestation
      // record that could later be mistaken for consent evidence.
      expect(await counts()).toEqual({ subscribers: 0, attestations: 0 });
    }
  });

  it('imports as confirmed when the operator attests, logging the wording verbatim', async () => {
    const response = await importPost(
      post('/api/admin/import', {
        listId: list._id.toHexString(),
        csv: CSV,
        mapping: MAPPING,
        markConfirmed: true,
        attestation: { text: ATTESTATION_TEXT, by: 'ops@domain-a.com' },
        filename: 'squarespace-export.csv',
      }),
      undefined,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, total: 2, imported: 2, skippedSuppressed: 0 });
    expect(typeof body.attestationId).toBe('string');

    const ada = await (await subscribersCollection()).findOne({ email: 'ada@example.com' });
    expect(ada?.status).toBe('confirmed');
    expect(ada?.confirmedAt).toBeInstanceOf(Date);
    expect(ada?.source).toBe('import');
    expect(ada?.attributes).toEqual({ first_name: 'Ada' });

    const attestation = await (await importAttestationsCollection()).findOne({
      _id: new ObjectId(body.attestationId),
    });
    expect(attestation?.attestationText).toBe(ATTESTATION_TEXT);
    expect(attestation?.attestedBy).toBe('ops@domain-a.com');
    expect(attestation?.filename).toBe('squarespace-export.csv');
    expect(attestation?.importedAsConfirmed).toBe(true);
    expect(attestation?.listId.toHexString()).toBe(list._id.toHexString());
  });

  it('lands addresses as pending when the operator does not attest', async () => {
    const response = await importPost(
      post('/api/admin/import', {
        listId: list._id.toHexString(),
        csv: CSV,
        mapping: MAPPING,
      }),
      undefined,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.imported).toBe(2);
    expect(body.attestationId).toBeNull();

    const docs = await (await subscribersCollection()).find({}).toArray();
    expect(docs.map((d) => d.status)).toEqual(['pending', 'pending']);
    expect(docs.every((d) => d.confirmedAt === undefined)).toBe(true);
    expect(await (await importAttestationsCollection()).countDocuments()).toBe(0);
  });

  it('never resurrects a suppressed address, even under an attestation', async () => {
    await createSuppression({ email: 'grace@example.com', reason: 'complaint' });

    const body = await (
      await importPost(
        post('/api/admin/import', {
          listId: list._id.toHexString(),
          csv: CSV,
          mapping: MAPPING,
          markConfirmed: true,
          attestation: { text: ATTESTATION_TEXT, by: 'ops@domain-a.com' },
        }),
        undefined,
      )
    ).json();

    expect(body.skippedSuppressed).toBe(1);
    expect(body.imported).toBe(1);
    const emails = (await (await subscribersCollection()).find({}).toArray()).map((d) => d.email);
    expect(emails).toEqual(['ada@example.com']);
  });

  it('reports malformed rows back with their row numbers instead of dropping them', async () => {
    const body = await (
      await importPost(
        post('/api/admin/import', {
          listId: list._id.toHexString(),
          csv: 'email,first_name\nada@example.com,Ada\nnot-an-email,Bob\n,Carol\n',
          mapping: MAPPING,
        }),
        undefined,
      )
    ).json();

    expect(body.total).toBe(3);
    expect(body.imported).toBe(1);
    expect(body.errors.map((e: { row: number }) => e.row)).toEqual([3, 4]);
    expect(body.errors[0].email).toBe('not-an-email');
    expect(await (await subscribersCollection()).countDocuments()).toBe(1);
  });
});
