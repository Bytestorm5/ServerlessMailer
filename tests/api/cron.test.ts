import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET as cronSend } from '@/app/api/cron/send/route';
import { GET as cronPurge } from '@/app/api/cron/purge/route';
import { campaignBatchesCollection, campaignsCollection, sentLogCollection, subscribersCollection } from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import { freezeCampaign } from '@/lib/pipeline/freeze';
import { resetSleeper, setSleeper } from '@/lib/pipeline/process';
import { resetSesAdapter, setSesAdapter } from '@/lib/ses/registry';
import { createCampaign, createList, createSubscriber } from '@tests/helpers/factories';
import { FakeSes } from '@tests/helpers/fake-ses';
import type { ListDoc } from '@/lib/types';

let list: ListDoc;
let ses: FakeSes;

beforeEach(async () => {
  await ensureIndexes();
  await Promise.all([
    (await campaignsCollection()).deleteMany({}),
    (await campaignBatchesCollection()).deleteMany({}),
    (await subscribersCollection()).deleteMany({}),
    (await sentLogCollection()).deleteMany({}),
  ]);
  list = await createList();
  ses = new FakeSes();
  ses.verifiedIdentities.add('news.domain-a.com');
  setSesAdapter(ses);
  setSleeper(async () => {});
});

afterEach(() => {
  resetSesAdapter();
  resetSleeper();
});

function cronRequest(url: string, secret?: string) {
  return new Request(url, {
    // Vercel cron invocations arrive as GET with a bearer token (§2.2).
    method: 'GET',
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

describe('GET /api/cron/send', () => {
  it('rejects a request with no bearer token', async () => {
    const response = await cronSend(cronRequest('https://mail.example.com/api/cron/send'));
    expect(response.status).toBe(401);
  });

  it('rejects a request with the wrong secret', async () => {
    const response = await cronSend(
      cronRequest('https://mail.example.com/api/cron/send', 'not-the-secret'),
    );
    expect(response.status).toBe(401);
  });

  it('does no work at all when authorization fails', async () => {
    await createSubscriber(list._id, { email: 'a@example.com' });
    const campaign = await createCampaign(list._id, { status: 'draft' });
    await freezeCampaign(campaign._id);

    await cronSend(cronRequest('https://mail.example.com/api/cron/send', 'wrong'));

    expect(ses.bulkSends).toHaveLength(0);
    expect(await (await sentLogCollection()).countDocuments()).toBe(0);
  });

  it('runs the send cycle with a valid secret', async () => {
    for (let i = 0; i < 10; i += 1) {
      await createSubscriber(list._id, { email: `cron-${i}@example.com` });
    }
    const campaign = await createCampaign(list._id, { status: 'draft' });
    await freezeCampaign(campaign._id);

    const response = await cronSend(
      cronRequest('https://mail.example.com/api/cron/send', 'test-cron-secret'),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.sent).toBe(10);
    expect(body.completedCampaigns).toContain(campaign._id.toHexString());
  });

  it('returns a small summary rather than recipient data', async () => {
    await createSubscriber(list._id, { email: 'private@example.com' });
    const campaign = await createCampaign(list._id, { status: 'draft' });
    await freezeCampaign(campaign._id);

    const response = await cronSend(
      cronRequest('https://mail.example.com/api/cron/send', 'test-cron-secret'),
    );
    const text = await response.text();

    // Nothing identifying a subscriber belongs in a cron response body.
    expect(text).not.toContain('private@example.com');
  });

  it('succeeds with nothing to do', async () => {
    const response = await cronSend(
      cronRequest('https://mail.example.com/api/cron/send', 'test-cron-secret'),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).batchesProcessed).toBe(0);
  });
});

describe('GET /api/cron/purge', () => {
  it('requires the cron secret', async () => {
    expect(
      (await cronPurge(cronRequest('https://mail.example.com/api/cron/purge'))).status,
    ).toBe(401);
  });

  it('purges expired pending records and reports the count', async () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await createSubscriber(list._id, { email: 'stale@example.com', status: 'pending', createdAt: old });
    await createSubscriber(list._id, { email: 'fresh@example.com', status: 'pending' });
    await createSubscriber(list._id, { email: 'keeper@example.com', status: 'unsubscribed', createdAt: old });

    const response = await cronPurge(
      cronRequest('https://mail.example.com/api/cron/purge', 'test-cron-secret'),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).purged).toBe(1);

    const remaining = await (await subscribersCollection()).find({}).toArray();
    expect(remaining.map((d) => d.email).sort()).toEqual([
      'fresh@example.com',
      'keeper@example.com',
    ]);
  });
});
