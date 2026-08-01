import { beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { reconcileCompletedCampaigns } from '@/lib/pipeline/reconcile';
import { campaignBatchesCollection, campaignsCollection } from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import { createCampaign, createList } from '@tests/helpers/factories';
import type { BatchStatus, CampaignDoc, ListDoc } from '@/lib/types';

let list: ListDoc;

beforeEach(async () => {
  await ensureIndexes();
  await Promise.all([
    (await campaignsCollection()).deleteMany({}),
    (await campaignBatchesCollection()).deleteMany({}),
  ]);
  list = await createList();
});

async function seedBatches(campaign: CampaignDoc, statuses: BatchStatus[]) {
  const batches = await campaignBatchesCollection();
  await batches.insertMany(
    statuses.map((status) => ({
      _id: new ObjectId(),
      campaignId: campaign._id,
      subscriberIds: [new ObjectId()],
      status,
      attempts: 1,
      createdAt: new Date(),
    })),
  );
}

describe('reconcileCompletedCampaigns', () => {
  it('completes a campaign once no batches remain pending or claimed', async () => {
    const campaign = await createCampaign(list._id, { status: 'sending' });
    await seedBatches(campaign, ['sent', 'sent', 'sent']);
    const now = new Date('2026-08-01T12:34:56.000Z');

    const completed = await reconcileCompletedCampaigns(now);

    expect(completed.map(String)).toEqual([campaign._id.toHexString()]);
    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.status).toBe('sent');
    expect(doc?.completedAt).toEqual(now);
  });

  it('leaves a campaign sending while any batch is still pending', async () => {
    const campaign = await createCampaign(list._id, { status: 'sending' });
    await seedBatches(campaign, ['sent', 'pending']);

    expect(await reconcileCompletedCampaigns()).toEqual([]);
    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.status).toBe('sending');
  });

  it('leaves a campaign sending while a batch is still claimed', async () => {
    const campaign = await createCampaign(list._id, { status: 'sending' });
    await seedBatches(campaign, ['sent', 'claimed']);

    expect(await reconcileCompletedCampaigns()).toEqual([]);
  });

  it('still completes when the only remaining batches are failed', async () => {
    // §7.6: failed batches are surfaced in the UI with lastError for manual
    // review; they must not hold the campaign open forever.
    const campaign = await createCampaign(list._id, { status: 'sending' });
    await seedBatches(campaign, ['sent', 'failed']);

    const completed = await reconcileCompletedCampaigns();
    expect(completed).toHaveLength(1);
    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.status).toBe('sent');
  });

  it('ignores paused campaigns', async () => {
    // A paused campaign with no claimable batches is not finished — it is
    // waiting for a human. Completing it would lose the remaining recipients.
    const campaign = await createCampaign(list._id, { status: 'paused' });
    await seedBatches(campaign, ['pending', 'pending']);

    expect(await reconcileCompletedCampaigns()).toEqual([]);
    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.status).toBe('paused');
  });

  it('does not re-complete an already sent campaign', async () => {
    const original = new Date('2026-07-01T00:00:00.000Z');
    const campaign = await createCampaign(list._id, {
      status: 'sent',
      completedAt: original,
    });
    await seedBatches(campaign, ['sent']);

    expect(await reconcileCompletedCampaigns(new Date())).toEqual([]);
    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.completedAt).toEqual(original);
  });

  it('completes a sending campaign that has no batches at all', async () => {
    const campaign = await createCampaign(list._id, { status: 'sending' });
    const completed = await reconcileCompletedCampaigns();
    expect(completed.map(String)).toEqual([campaign._id.toHexString()]);
  });

  it('handles several campaigns in one pass', async () => {
    const done = await createCampaign(list._id, { status: 'sending', subject: 'done' });
    const running = await createCampaign(list._id, { status: 'sending', subject: 'running' });
    await seedBatches(done, ['sent']);
    await seedBatches(running, ['pending']);

    const completed = await reconcileCompletedCampaigns();
    expect(completed.map(String)).toEqual([done._id.toHexString()]);
  });
});
