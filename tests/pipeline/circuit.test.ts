import { beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { checkCircuitBreaker, evaluateAllSendingCampaigns } from '@/lib/pipeline/circuit';
import { campaignsCollection } from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import { createCampaign, createList, emptyCounts } from '@tests/helpers/factories';
import type { CampaignCounts, CampaignStatus, ListDoc } from '@/lib/types';

let list: ListDoc;

beforeEach(async () => {
  await ensureIndexes();
  await (await campaignsCollection()).deleteMany({});
  list = await createList();
});

function counts(overrides: Partial<CampaignCounts>): CampaignCounts {
  return { ...emptyCounts(), ...overrides };
}

async function seed(status: CampaignStatus, overrides: Partial<CampaignCounts>) {
  return createCampaign(list._id, { status, counts: counts(overrides) });
}

describe('checkCircuitBreaker', () => {
  it('does not trip below the threshold', async () => {
    // 1 complaint in 5,000 delivered = 0.02%, comfortably under 0.1%.
    const campaign = await seed('sending', { delivered: 5000, complained: 1 });

    const result = await checkCircuitBreaker(campaign._id);

    expect(result.tripped).toBe(false);
    expect(result.delivered).toBe(5000);
    expect(result.complaintRate).toBeCloseTo(0.0002, 6);
  });

  it('trips above the threshold', async () => {
    // 10 complaints in 5,000 delivered = 0.2%, double the 0.1% threshold. SES
    // suspends accounts at 0.5%, so this must stop the send.
    const campaign = await seed('sending', { delivered: 5000, complained: 10 });

    const result = await checkCircuitBreaker(campaign._id);

    expect(result.tripped).toBe(true);
    expect(result.complaintRate).toBeCloseTo(0.002, 6);
  });

  it('does not trip on a tiny sample even at a high rate', async () => {
    // 1 complaint in 10 delivered is 10%, but it is noise, not signal — pausing
    // the campaign on the strength of it would be a false alarm every time.
    const campaign = await seed('sending', { delivered: 10, complained: 1 });

    expect((await checkCircuitBreaker(campaign._id)).tripped).toBe(false);
  });

  it('treats zero delivered as a zero rate rather than dividing by zero', async () => {
    const campaign = await seed('sending', { delivered: 0, complained: 0 });

    const result = await checkCircuitBreaker(campaign._id);
    expect(result.tripped).toBe(false);
    expect(result.complaintRate).toBe(0);
    expect(Number.isNaN(result.complaintRate)).toBe(false);
  });

  it('reports not tripped for an unknown campaign', async () => {
    const result = await checkCircuitBreaker(new ObjectId());
    expect(result.tripped).toBe(false);
  });
});

describe('evaluateAllSendingCampaigns', () => {
  it('auto-pauses a campaign whose complaint rate is too high', async () => {
    const bad = await seed('sending', { delivered: 5000, complained: 25 });
    const now = new Date('2026-08-01T09:00:00.000Z');

    const paused = await evaluateAllSendingCampaigns(now);

    expect(paused.map(String)).toEqual([bad._id.toHexString()]);
    const doc = await (await campaignsCollection()).findOne({ _id: bad._id });
    expect(doc?.status).toBe('paused');
    expect(doc?.pausedAt).toEqual(now);
    expect(doc?.pausedReason).toMatch(/complaint/i);
  });

  it('leaves a healthy campaign sending', async () => {
    const good = await seed('sending', { delivered: 5000, complained: 1 });

    expect(await evaluateAllSendingCampaigns()).toEqual([]);
    const doc = await (await campaignsCollection()).findOne({ _id: good._id });
    expect(doc?.status).toBe('sending');
  });

  it('only considers campaigns that are actively sending', async () => {
    // A finished campaign with a bad rate is a post-mortem, not something to
    // pause; pausing it would misrepresent its state in the UI.
    await seed('sent', { delivered: 5000, complained: 50 });
    await seed('paused', { delivered: 5000, complained: 50 });
    await seed('draft', { delivered: 5000, complained: 50 });

    expect(await evaluateAllSendingCampaigns()).toEqual([]);
  });

  it('pauses each offending campaign independently', async () => {
    const badA = await seed('sending', { delivered: 2000, complained: 20 });
    const good = await seed('sending', { delivered: 2000, complained: 0 });
    const badB = await seed('sending', { delivered: 3000, complained: 30 });

    const paused = (await evaluateAllSendingCampaigns()).map(String).sort();
    expect(paused).toEqual([badA._id.toHexString(), badB._id.toHexString()].sort());

    const goodDoc = await (await campaignsCollection()).findOne({ _id: good._id });
    expect(goodDoc?.status).toBe('sending');
  });

  it('is idempotent — a second pass does not re-pause', async () => {
    await seed('sending', { delivered: 5000, complained: 25 });

    expect(await evaluateAllSendingCampaigns()).toHaveLength(1);
    expect(await evaluateAllSendingCampaigns()).toHaveLength(0);
  });
});
