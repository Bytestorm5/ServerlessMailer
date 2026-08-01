import { beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import {
  activeSendingCampaignIds,
  claimBatch,
  completeBatch,
  failBatch,
  releaseBatch,
} from '@/lib/pipeline/claim';
import { campaignBatchesCollection, campaignsCollection } from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import { createCampaign, createList } from '@tests/helpers/factories';
import { config } from '@/lib/config';
import type { CampaignBatchDoc, CampaignStatus, ListDoc } from '@/lib/types';

let list: ListDoc;

beforeEach(async () => {
  await ensureIndexes();
  await Promise.all([
    (await campaignsCollection()).deleteMany({}),
    (await campaignBatchesCollection()).deleteMany({}),
  ]);
  list = await createList();
});

async function seedBatch(
  campaignId: ObjectId,
  overrides: Partial<CampaignBatchDoc> = {},
): Promise<CampaignBatchDoc> {
  const doc: CampaignBatchDoc = {
    _id: new ObjectId(),
    campaignId,
    subscriberIds: [new ObjectId()],
    status: 'pending',
    attempts: 0,
    createdAt: new Date(),
    ...overrides,
  };
  await (await campaignBatchesCollection()).insertOne(doc);
  return doc;
}

async function seedCampaign(status: CampaignStatus) {
  return createCampaign(list._id, { status });
}

describe('activeSendingCampaignIds', () => {
  it('returns only campaigns in the sending state', async () => {
    const sending = await seedCampaign('sending');
    await seedCampaign('paused');
    await seedCampaign('draft');
    await seedCampaign('sent');
    await seedCampaign('scheduled');
    await seedCampaign('failed');

    const ids = await activeSendingCampaignIds();
    expect(ids.map(String)).toEqual([sending._id.toHexString()]);
  });
});

describe('claimBatch', () => {
  it('claims a pending batch, leases it, and records the invocation', async () => {
    const campaign = await seedCampaign('sending');
    const batch = await seedBatch(campaign._id);
    const now = new Date('2026-08-01T12:00:00.000Z');

    const claimed = await claimBatch('invocation-1', now);

    expect(claimed?._id.toHexString()).toBe(batch._id.toHexString());
    expect(claimed?.status).toBe('claimed');
    expect(claimed?.claimedBy).toBe('invocation-1');
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.leaseUntil).toEqual(new Date(now.getTime() + config.batchLeaseMs()));
  });

  it('returns null when there is nothing to claim', async () => {
    expect(await claimBatch('invocation-1')).toBeNull();
  });

  it('does not claim batches of a paused campaign', async () => {
    // §7.7: setting status=paused removes the campaign from the claim query,
    // so sending stops within one minute with no in-flight work lost.
    const paused = await seedCampaign('paused');
    await seedBatch(paused._id);

    expect(await claimBatch('invocation-1')).toBeNull();
  });

  it.each(['draft', 'scheduled', 'sent', 'failed'] as const)(
    'does not claim batches of a %s campaign',
    async (status) => {
      const campaign = await seedCampaign(status);
      await seedBatch(campaign._id);
      expect(await claimBatch('invocation-1')).toBeNull();
    },
  );

  it('reclaims a batch whose lease has expired', async () => {
    // This is the whole design: a function that dies mid-batch leaves 50 people
    // unsent with no error anywhere. Lease expiry is what recovers them.
    const campaign = await seedCampaign('sending');
    const now = new Date('2026-08-01T12:00:00.000Z');
    const batch = await seedBatch(campaign._id, {
      status: 'claimed',
      claimedBy: 'dead-invocation',
      leaseUntil: new Date(now.getTime() - 1),
      attempts: 1,
    });

    const claimed = await claimBatch('invocation-2', now);

    expect(claimed?._id.toHexString()).toBe(batch._id.toHexString());
    expect(claimed?.claimedBy).toBe('invocation-2');
    expect(claimed?.attempts).toBe(2);
  });

  it('does not steal a batch whose lease is still live', async () => {
    const campaign = await seedCampaign('sending');
    const now = new Date('2026-08-01T12:00:00.000Z');
    await seedBatch(campaign._id, {
      status: 'claimed',
      claimedBy: 'still-working',
      leaseUntil: new Date(now.getTime() + 60_000),
      attempts: 1,
    });

    expect(await claimBatch('invocation-2', now)).toBeNull();
  });

  it('skips batches that have exhausted their attempts', async () => {
    const campaign = await seedCampaign('sending');
    await seedBatch(campaign._id, { attempts: config.maxBatchAttempts() });

    expect(await claimBatch('invocation-1')).toBeNull();
  });

  it('never hands the same batch to two concurrent invocations', async () => {
    // Vercel does not prevent overlapping cron runs. Overlap is only safe
    // because claiming is a single atomic findOneAndUpdate (§7.3).
    const campaign = await seedCampaign('sending');
    for (let i = 0; i < 12; i += 1) await seedBatch(campaign._id);

    const claims = await Promise.all(
      Array.from({ length: 12 }, (_, i) => claimBatch(`invocation-${i}`)),
    );

    const ids = claims.filter(Boolean).map((b) => b!._id.toHexString());
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
  });

  it('does not claim already-sent or failed batches', async () => {
    const campaign = await seedCampaign('sending');
    await seedBatch(campaign._id, { status: 'sent' });
    await seedBatch(campaign._id, { status: 'failed' });

    expect(await claimBatch('invocation-1')).toBeNull();
  });
});

describe('releaseBatch', () => {
  it('returns the batch to pending and expires the lease immediately', async () => {
    // §7.5: on SES throttling, release the batch and exit the run early so the
    // next tick can pick it up without waiting out the full lease.
    const campaign = await seedCampaign('sending');
    const batch = await seedBatch(campaign._id);
    const now = new Date('2026-08-01T12:00:00.000Z');
    await claimBatch('invocation-1', now);

    await releaseBatch(batch._id, 'SES throttling', now);

    const reloaded = await (await campaignBatchesCollection()).findOne({ _id: batch._id });
    expect(reloaded?.status).toBe('pending');
    expect(reloaded?.leaseUntil).toEqual(now);
    expect(reloaded?.lastError).toBe('SES throttling');
  });

  it('makes the batch immediately claimable again', async () => {
    const campaign = await seedCampaign('sending');
    const batch = await seedBatch(campaign._id);
    const now = new Date('2026-08-01T12:00:00.000Z');
    await claimBatch('invocation-1', now);
    await releaseBatch(batch._id, undefined, now);

    const reclaimed = await claimBatch('invocation-2', now);
    expect(reclaimed?._id.toHexString()).toBe(batch._id.toHexString());
  });
});

describe('completeBatch', () => {
  it('marks the batch sent and clears the lease', async () => {
    const campaign = await seedCampaign('sending');
    const batch = await seedBatch(campaign._id);
    const now = new Date('2026-08-01T12:00:00.000Z');

    await completeBatch(batch._id, now);

    const reloaded = await (await campaignBatchesCollection()).findOne({ _id: batch._id });
    expect(reloaded?.status).toBe('sent');
    expect(reloaded?.sentAt).toEqual(now);
    expect(reloaded?.leaseUntil).toBeUndefined();
  });

  it('is not claimable afterwards', async () => {
    const campaign = await seedCampaign('sending');
    const batch = await seedBatch(campaign._id);
    await completeBatch(batch._id);
    expect(await claimBatch('invocation-9')).toBeNull();
  });
});

describe('failBatch', () => {
  it('marks the batch failed and records the error for manual review', async () => {
    const campaign = await seedCampaign('sending');
    const batch = await seedBatch(campaign._id);

    await failBatch(batch._id, 'Malformed content');

    const reloaded = await (await campaignBatchesCollection()).findOne({ _id: batch._id });
    expect(reloaded?.status).toBe('failed');
    expect(reloaded?.lastError).toBe('Malformed content');
  });
});
