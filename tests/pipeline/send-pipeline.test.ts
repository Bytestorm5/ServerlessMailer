import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { freezeCampaign } from '@/lib/pipeline/freeze';
import { processBatch, resetSleeper, setSleeper } from '@/lib/pipeline/process';
import { claimBatch } from '@/lib/pipeline/claim';
import { runSendCycle } from '@/lib/pipeline/run';
import {
  campaignBatchesCollection,
  campaignsCollection,
  sentLogCollection,
  subscribersCollection,
  suppressionsCollection,
} from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import { resetSesAdapter, setSesAdapter } from '@/lib/ses/registry';
import { addSuppression } from '@/lib/suppressions';
import { unsubscribeSubscriber } from '@/lib/subscribers';
import { createCampaign, createList } from '@tests/helpers/factories';
import { FakeSes } from '@tests/helpers/fake-ses';
import type { CampaignDoc, ListDoc, SubscriberDoc } from '@/lib/types';

let list: ListDoc;
let ses: FakeSes;

beforeEach(async () => {
  await ensureIndexes();
  await Promise.all([
    (await campaignsCollection()).deleteMany({}),
    (await campaignBatchesCollection()).deleteMany({}),
    (await subscribersCollection()).deleteMany({}),
    (await suppressionsCollection()).deleteMany({}),
    (await sentLogCollection()).deleteMany({}),
  ]);
  list = await createList();
  ses = new FakeSes();
  ses.verifiedIdentities.add('news.domain-a.com');
  setSesAdapter(ses);
  // Pacing is asserted separately; elsewhere it would only slow the suite.
  setSleeper(async () => {});
});

afterEach(() => {
  resetSesAdapter();
  resetSleeper();
});

/** Bulk-inserts confirmed subscribers without the per-document factory cost. */
async function seedSubscribers(count: number, prefix = 'r'): Promise<ObjectId[]> {
  const docs: SubscriberDoc[] = Array.from({ length: count }, (_, i) => ({
    _id: new ObjectId(),
    listId: list._id,
    email: `${prefix}-${i}@example.com`,
    emailDomain: 'example.com',
    status: 'confirmed' as const,
    attributes: { first_name: `Reader${i}` },
    source: 'web_form' as const,
    createdAt: new Date(),
    confirmedAt: new Date(),
    confirmIp: '203.0.113.1',
    confirmUserAgent: 'test',
    history: [],
  }));
  await (await subscribersCollection()).insertMany(docs);
  return docs.map((d) => d._id);
}

async function draft(overrides: Partial<CampaignDoc> = {}) {
  return createCampaign(list._id, { status: 'draft', ...overrides });
}

async function sentCount(campaignId: ObjectId) {
  return (await sentLogCollection()).countDocuments({ campaignId });
}

describe('freeze', () => {
  it('materialises batches of at most 50 and moves the campaign to sending', async () => {
    await seedSubscribers(120);
    const campaign = await draft();

    const result = await freezeCampaign(campaign._id);

    expect(result).toEqual({ ok: true, recipients: 120, batches: 3 });
    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.status).toBe('sending');
    expect(doc?.frozenAt).toBeInstanceOf(Date);
    expect(doc?.counts.recipients).toBe(120);
    expect(doc?.bodyHtml).toContain('<html');
    expect(doc?.bodyText?.length).toBeGreaterThan(0);

    const batches = await (await campaignBatchesCollection()).find({}).toArray();
    expect(batches).toHaveLength(3);
    expect(batches.every((b) => b.subscriberIds.length <= 50)).toBe(true);
    expect(batches.flatMap((b) => b.subscriberIds)).toHaveLength(120);
  });

  it('excludes suppressed and non-confirmed subscribers from the recipient set', async () => {
    await seedSubscribers(10);
    await addSuppression({ email: 'r-3@example.com', reason: 'hard_bounce' });
    await (await subscribersCollection()).updateOne(
      { email: 'r-4@example.com' },
      { $set: { status: 'unsubscribed' } },
    );
    const campaign = await draft();

    const result = await freezeCampaign(campaign._id);

    expect(result).toMatchObject({ ok: true, recipients: 8 });
  });

  it('refuses to freeze twice, so batches are never duplicated', async () => {
    await seedSubscribers(10);
    const campaign = await draft();

    expect(await freezeCampaign(campaign._id)).toMatchObject({ ok: true });
    expect(await freezeCampaign(campaign._id)).toEqual({ ok: false, reason: 'wrong_status' });

    expect(await (await campaignBatchesCollection()).countDocuments()).toBe(1);
  });

  it('blocks on the pre-send gate without changing campaign state', async () => {
    await seedSubscribers(5);
    const campaign = await draft({ subject: '   ' });

    const result = await freezeCampaign(campaign._id);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('validation_failed');
    expect(result.checks?.find((c) => c.id === 'subject')?.passed).toBe(false);

    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.status).toBe('draft');
    expect(await (await campaignBatchesCollection()).countDocuments()).toBe(0);
  });

  it('blocks when the from-domain is not verified in SES', async () => {
    ses.verifiedIdentities.clear();
    await seedSubscribers(5);
    const campaign = await draft();

    const result = await freezeCampaign(campaign._id);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.checks?.find((c) => c.id === 'from_domain_verified')?.passed).toBe(false);
  });

  it('refuses a campaign whose segment matches nobody, leaving it in draft', async () => {
    // Two layers guard this. The pre-send gate catches it first, which is why
    // the reason is validation_failed rather than no_recipients; freeze's own
    // no_recipients path remains as the guard for the case where the segment
    // empties out between validation and resolution.
    const campaign = await draft();

    const result = await freezeCampaign(campaign._id);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('validation_failed');
    expect(result.checks?.find((c) => c.id === 'recipient_count')?.passed).toBe(false);

    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.status).toBe('draft');
    expect(await (await campaignBatchesCollection()).countDocuments()).toBe(0);
  });

  it('reports not_found for an unknown campaign', async () => {
    expect(await freezeCampaign(new ObjectId())).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('processBatch', () => {
  it('sends the batch and records every recipient in sent_log', async () => {
    await seedSubscribers(10);
    const campaign = await draft();
    await freezeCampaign(campaign._id);

    const batch = (await claimBatch('inv-1'))!;
    const result = await processBatch(batch);

    expect(result).toMatchObject({ sent: 10, failed: 0, skipped: 0, throttled: false });
    expect(await sentCount(campaign._id)).toBe(10);
    expect(ses.bulkSends).toHaveLength(1);
    expect(ses.bulkSends[0].params.destinations).toHaveLength(10);
  });

  it('sets both bulk-sender unsubscribe headers on every destination', async () => {
    await seedSubscribers(3);
    const campaign = await draft();
    await freezeCampaign(campaign._id);
    await processBatch((await claimBatch('inv-1'))!);

    for (const destination of ses.bulkSends[0].params.destinations) {
      expect(destination.headers['List-Unsubscribe']).toContain('/api/unsubscribe?t=');
      expect(destination.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    }
  });

  it('re-checks status at send time and skips someone who unsubscribed after freeze', async () => {
    // §7.4 step 2: the freeze happened up to an hour ago. This second check is
    // not redundant, it is the point.
    const ids = await seedSubscribers(5);
    const campaign = await draft();
    await freezeCampaign(campaign._id);

    await unsubscribeSubscriber({ subscriberId: ids[2], source: 'one_click' });

    const result = await processBatch((await claimBatch('inv-1'))!);

    expect(result.sent).toBe(4);
    expect(result.skipped).toBe(1);
    expect(ses.allSentAddresses()).not.toContain('r-2@example.com');
  });

  it('re-checks suppressions at send time', async () => {
    await seedSubscribers(5);
    const campaign = await draft();
    await freezeCampaign(campaign._id);

    await addSuppression({ email: 'r-1@example.com', reason: 'complaint' });

    const result = await processBatch((await claimBatch('inv-1'))!);

    expect(result.sent).toBe(4);
    expect(ses.allSentAddresses()).not.toContain('r-1@example.com');
  });

  it('does not fail the whole batch for one bad address', async () => {
    await seedSubscribers(5);
    ses.failAddresses.add('r-3@example.com');
    const campaign = await draft();
    await freezeCampaign(campaign._id);

    const result = await processBatch((await claimBatch('inv-1'))!);

    expect(result.sent).toBe(4);
    expect(result.failed).toBe(1);
    expect(await sentCount(campaign._id)).toBe(4);

    const batch = await (await campaignBatchesCollection()).findOne({});
    expect(batch?.status).toBe('sent');
  });

  it('releases the batch and reports throttling instead of hammering SES', async () => {
    await seedSubscribers(5);
    const campaign = await draft();
    await freezeCampaign(campaign._id);
    ses.throttleNextCalls = 1;

    const batch = (await claimBatch('inv-1'))!;
    const result = await processBatch(batch);

    expect(result.throttled).toBe(true);
    expect(result.sent).toBe(0);

    const reloaded = await (await campaignBatchesCollection()).findOne({ _id: batch._id });
    expect(reloaded?.status).toBe('pending');
    // Immediately reclaimable, rather than waiting out the full lease.
    expect(await claimBatch('inv-2')).not.toBeNull();
  });

  it('paces sends to stay under the configured SES rate', async () => {
    const waits: number[] = [];
    setSleeper(async (ms) => {
      waits.push(ms);
    });
    await seedSubscribers(14);
    const campaign = await draft();
    await freezeCampaign(campaign._id);

    await processBatch((await claimBatch('inv-1'))!);

    // 14 messages at 14/second is one second of pacing.
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(0);
    expect(waits[0]).toBeLessThanOrEqual(1000);
  });

  it('fails the batch permanently once attempts are exhausted', async () => {
    await seedSubscribers(3);
    const campaign = await draft();
    await freezeCampaign(campaign._id);

    const batch = (await claimBatch('inv-1'))!;
    batch.attempts = 99;
    ses.throwOnNextBulk = new Error('permanent content rejection');

    await processBatch(batch);

    const reloaded = await (await campaignBatchesCollection()).findOne({ _id: batch._id });
    expect(reloaded?.status).toBe('failed');
    expect(reloaded?.lastError).toContain('permanent content rejection');
  });
});

describe('the double-send guarantee', () => {
  it('cannot send twice, even when the same batch is processed again', async () => {
    await seedSubscribers(10);
    const campaign = await draft();
    await freezeCampaign(campaign._id);

    const batch = (await claimBatch('inv-1'))!;
    const first = await processBatch(batch);
    expect(first.sent).toBe(10);

    // Force a replay of the identical batch, as a buggy claim would.
    const replay = await processBatch(batch);

    expect(replay.sent).toBe(0);
    expect(replay.skipped).toBe(10);
    expect(await sentCount(campaign._id)).toBe(10);
  });

  it('holds even if the duplicate is only caught by the unique index', async () => {
    // Simulates the sent_log pre-check being bypassed entirely: the index is a
    // database-level invariant that survives bugs in the claim logic (§3.6).
    const ids = await seedSubscribers(3);
    const campaign = await draft();
    const sentLog = await sentLogCollection();

    await expect(
      sentLog.insertMany([
        { _id: new ObjectId(), campaignId: campaign._id, subscriberId: ids[0], sentAt: new Date() },
        { _id: new ObjectId(), campaignId: campaign._id, subscriberId: ids[0], sentAt: new Date() },
      ]),
    ).rejects.toMatchObject({ code: 11000 });

    expect(await sentCount(campaign._id)).toBe(1);
  });

  it('survives a forced mid-send crash without losing or duplicating anyone', async () => {
    // Phase 2 exit criterion: survives a forced mid-send crash, and cannot
    // double-send.
    await seedSubscribers(120);
    const campaign = await draft();
    await freezeCampaign(campaign._id);

    // First batch goes out, then the "function" dies mid-flight.
    await processBatch((await claimBatch('doomed'))!);
    const crashed = (await claimBatch('doomed'))!;
    expect(crashed.status).toBe('claimed');

    // The lease expires and the next tick reclaims the abandoned batch.
    const afterLeaseExpiry = new Date(Date.now() + 10 * 60 * 1000);
    let batch = await claimBatch('recovered', afterLeaseExpiry);
    while (batch) {
      await processBatch(batch, afterLeaseExpiry);
      batch = await claimBatch('recovered', afterLeaseExpiry);
    }

    expect(await sentCount(campaign._id)).toBe(120);
    const addresses = ses.allSentAddresses();
    expect(new Set(addresses).size).toBe(addresses.length);
  });
});

describe('runSendCycle', () => {
  it('drains a campaign across ticks and completes it with correct counts', async () => {
    await seedSubscribers(120);
    const campaign = await draft();
    await freezeCampaign(campaign._id);

    let guard = 0;
    let summary = await runSendCycle({ maxBatches: 2 });
    while (summary.completedCampaigns.length === 0 && guard++ < 20) {
      summary = await runSendCycle({ maxBatches: 2 });
    }

    expect(summary.completedCampaigns).toContain(campaign._id.toHexString());
    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.status).toBe('sent');
    expect(doc?.counts.sent).toBe(120);
    expect(doc?.counts.recipients).toBe(120);
    expect(doc?.completedAt).toBeInstanceOf(Date);
    expect(await sentCount(campaign._id)).toBe(120);
  });

  it('respects MAX_BATCHES_PER_RUN', async () => {
    await seedSubscribers(200);
    const campaign = await draft();
    await freezeCampaign(campaign._id);

    const summary = await runSendCycle({ maxBatches: 2 });

    expect(summary.batchesProcessed).toBe(2);
    expect(summary.sent).toBe(100);
  });

  it('stops within one tick when the campaign is paused', async () => {
    // §7.7: pausing removes the campaign from the claim query, so sending stops
    // within one minute with no in-flight work lost.
    await seedSubscribers(200);
    const campaign = await draft();
    await freezeCampaign(campaign._id);

    await runSendCycle({ maxBatches: 1 });
    expect(await sentCount(campaign._id)).toBe(50);

    await (await campaignsCollection()).updateOne(
      { _id: campaign._id },
      { $set: { status: 'paused' } },
    );

    const summary = await runSendCycle({ maxBatches: 10 });
    expect(summary.batchesProcessed).toBe(0);
    expect(await sentCount(campaign._id)).toBe(50);
  });

  it('resumes exactly where it left off, sending nobody twice', async () => {
    await seedSubscribers(150);
    const campaign = await draft();
    await freezeCampaign(campaign._id);

    await runSendCycle({ maxBatches: 1 });
    await (await campaignsCollection()).updateOne(
      { _id: campaign._id },
      { $set: { status: 'paused' } },
    );
    await runSendCycle({ maxBatches: 10 });
    await (await campaignsCollection()).updateOne(
      { _id: campaign._id },
      { $set: { status: 'sending' } },
    );
    await runSendCycle({ maxBatches: 10 });

    expect(await sentCount(campaign._id)).toBe(150);
    const addresses = ses.allSentAddresses();
    expect(new Set(addresses).size).toBe(150);
  });

  it('starts a scheduled campaign once its time has passed', async () => {
    await seedSubscribers(10);
    const campaign = await draft({
      status: 'scheduled',
      scheduledFor: new Date('2026-08-01T09:00:00.000Z'),
    });

    const summary = await runSendCycle({ now: new Date('2026-08-01T09:00:30.000Z') });

    expect(summary.scheduledStarted).toContain(campaign._id.toHexString());
    expect(await sentCount(campaign._id)).toBe(10);
  });

  it('leaves a scheduled campaign alone before its time', async () => {
    await seedSubscribers(10);
    const campaign = await draft({
      status: 'scheduled',
      scheduledFor: new Date('2026-08-01T09:00:00.000Z'),
    });

    const summary = await runSendCycle({ now: new Date('2026-08-01T08:59:00.000Z') });

    expect(summary.scheduledStarted).toHaveLength(0);
    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.status).toBe('scheduled');
  });

  it('auto-pauses a campaign whose complaint rate crosses the threshold', async () => {
    await seedSubscribers(200);
    const campaign = await draft();
    await freezeCampaign(campaign._id);
    await runSendCycle({ maxBatches: 1 });

    // Complaints arrive via SNS during the send.
    await (await campaignsCollection()).updateOne(
      { _id: campaign._id },
      { $set: { 'counts.delivered': 5000, 'counts.complained': 30 } },
    );

    const summary = await runSendCycle({ maxBatches: 10 });

    expect(summary.pausedCampaigns).toContain(campaign._id.toHexString());
    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.status).toBe('paused');
    expect(doc?.pausedReason).toMatch(/complaint/i);
  });

  it('returns quickly when there is nothing to do', async () => {
    const summary = await runSendCycle();
    expect(summary.batchesProcessed).toBe(0);
    expect(summary.durationMs).toBeLessThan(5000);
  });
});

describe('a five thousand recipient send', () => {
  it('completes with correct counts and no duplicates', async () => {
    // Phase 2 exit criterion: a 5,000-recipient send completes with correct
    // counts and cannot double-send.
    await seedSubscribers(5000, 'bulk');
    const campaign = await draft();

    const frozen = await freezeCampaign(campaign._id);
    expect(frozen).toEqual({ ok: true, recipients: 5000, batches: 100 });

    let guard = 0;
    let summary = await runSendCycle({ maxBatches: 25 });
    while (summary.completedCampaigns.length === 0 && guard++ < 40) {
      summary = await runSendCycle({ maxBatches: 25 });
    }

    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.status).toBe('sent');
    expect(doc?.counts.sent).toBe(5000);
    expect(await sentCount(campaign._id)).toBe(5000);

    const addresses = ses.allSentAddresses();
    expect(addresses).toHaveLength(5000);
    expect(new Set(addresses).size).toBe(5000);
  }, 120_000);
});
