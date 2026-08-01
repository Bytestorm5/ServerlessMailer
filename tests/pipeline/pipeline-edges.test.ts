import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Collection, ObjectId } from 'mongodb';
import { claimBatch } from '@/lib/pipeline/claim';
import { processBatch, resetSleeper, setSleeper } from '@/lib/pipeline/process';
import { freezeCampaign } from '@/lib/pipeline/freeze';
import { runSendCycle } from '@/lib/pipeline/run';
import {
  campaignBatchesCollection,
  campaignsCollection,
  listsCollection,
  sentLogCollection,
  subscribersCollection,
  suppressionsCollection,
} from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import { resetSesAdapter, setSesAdapter } from '@/lib/ses/registry';
import { createCampaign, createList, createSubscriber, validCampaignDoc } from '@tests/helpers/factories';
import { FakeSes } from '@tests/helpers/fake-ses';
import type { CampaignBatchDoc, ListDoc } from '@/lib/types';

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
    (await listsCollection()).deleteMany({}),
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
  vi.restoreAllMocks();
});

async function frozenCampaign(recipients = 3) {
  for (let i = 0; i < recipients; i += 1) {
    await createSubscriber(list._id, { email: `edge-${i}@example.com` });
  }
  const campaign = await createCampaign(list._id, {
    status: 'draft',
    bodySource: validCampaignDoc(),
  });
  const result = await freezeCampaign(campaign._id);
  if (!result.ok) throw new Error(`freeze failed: ${result.reason}`);
  return campaign;
}

async function reloadBatch(id: ObjectId) {
  return (await campaignBatchesCollection()).findOne({ _id: id });
}

describe('processBatch — the campaign or list has gone', () => {
  it('fails the batch when its campaign no longer exists', async () => {
    const campaign = await frozenCampaign();
    const batch = (await claimBatch('inv'))!;
    await (await campaignsCollection()).deleteOne({ _id: campaign._id });

    const result = await processBatch(batch);

    expect(result.sent).toBe(0);
    expect((await reloadBatch(batch._id))?.status).toBe('failed');
    expect(ses.bulkSends).toHaveLength(0);
  });

  it('fails the batch when the sending list no longer exists', async () => {
    await frozenCampaign();
    const batch = (await claimBatch('inv'))!;
    await (await listsCollection()).deleteOne({ _id: list._id });

    await processBatch(batch);

    const reloaded = await reloadBatch(batch._id);
    expect(reloaded?.status).toBe('failed');
    expect(reloaded?.lastError).toMatch(/list/i);
  });

  it('fails the batch when the body was never frozen', async () => {
    // A batch cannot outrun its freeze, but if it somehow did, sending an
    // unrendered campaign would deliver an empty email to real people.
    const campaign = await frozenCampaign();
    const batch = (await claimBatch('inv'))!;
    await (await campaignsCollection()).updateOne(
      { _id: campaign._id },
      { $unset: { bodyHtml: '', bodyText: '' } },
    );

    await processBatch(batch);

    const reloaded = await reloadBatch(batch._id);
    expect(reloaded?.status).toBe('failed');
    expect(reloaded?.lastError).toMatch(/frozen/i);
    expect(ses.bulkSends).toHaveLength(0);
  });
});

describe('processBatch — nobody left to send to', () => {
  it('completes the batch without calling SES when everyone became ineligible', async () => {
    const campaign = await frozenCampaign(2);
    const batch = (await claimBatch('inv'))!;

    // Both unsubscribe between freeze and send.
    await (await subscribersCollection()).updateMany(
      { listId: list._id },
      { $set: { status: 'unsubscribed' } },
    );

    const result = await processBatch(batch);

    expect(result).toMatchObject({ sent: 0, failed: 0, skipped: 2 });
    expect(ses.bulkSends).toHaveLength(0);
    expect((await reloadBatch(batch._id))?.status).toBe('sent');
    expect(await (await sentLogCollection()).countDocuments({ campaignId: campaign._id })).toBe(0);
  });

  it('completes the batch when its subscriber documents have been deleted', async () => {
    await frozenCampaign(2);
    const batch = (await claimBatch('inv'))!;
    await (await subscribersCollection()).deleteMany({});

    const result = await processBatch(batch);

    expect(result.skipped).toBe(2);
    expect((await reloadBatch(batch._id))?.status).toBe('sent');
  });
});

describe('processBatch — transient failures', () => {
  it('releases the batch for the next tick when SES throws a non-throttling error', async () => {
    await frozenCampaign();
    const batch = (await claimBatch('inv'))!;
    ses.throwOnNextBulk = new Error('temporary network fault');

    const result = await processBatch(batch);

    expect(result.throttled).toBe(false);
    const reloaded = await reloadBatch(batch._id);
    // Handed straight back rather than burning the whole lease.
    expect(reloaded?.status).toBe('pending');
    expect(reloaded?.lastError).toContain('temporary network fault');
    expect(await claimBatch('next-tick')).not.toBeNull();
  });

  it('recognises a throttling error by its message, not only by its class', async () => {
    // The AWS SDK surfaces this in several shapes; missing it would mean
    // hammering SES exactly when it is asking us to slow down.
    await frozenCampaign();
    const batch = (await claimBatch('inv'))!;
    ses.throwOnNextBulk = Object.assign(new Error('Maximum sending rate exceeded'), {
      name: 'TooManyRequestsException',
    });

    const result = await processBatch(batch);

    expect(result.throttled).toBe(true);
    expect((await reloadBatch(batch._id))?.status).toBe('pending');
  });
});

describe('freeze — the recipient set empties between validation and resolution', () => {
  it('returns no_recipients and puts the campaign back to draft', async () => {
    const subscriber = await createSubscriber(list._id, { email: 'only@example.com' });
    const campaign = await createCampaign(list._id, {
      status: 'draft',
      bodySource: validCampaignDoc(),
    });

    // The pre-send gate counts by segment; resolution additionally excludes
    // anyone already in sent_log for this campaign. Seeding that entry makes
    // the two disagree, which is exactly the race this branch guards.
    await (await sentLogCollection()).insertOne({
      _id: new ObjectId(),
      campaignId: campaign._id,
      subscriberId: subscriber._id,
      sentAt: new Date(),
    });

    const result = await freezeCampaign(campaign._id);

    expect(result).toEqual({ ok: false, reason: 'no_recipients' });
    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.status).toBe('draft');
    expect(doc?.frozenAt).toBeUndefined();
    expect(await (await campaignBatchesCollection()).countDocuments()).toBe(0);
  });
});

describe('freeze — a failure part way through', () => {
  it('rolls the campaign back to draft and removes any batches it created', async () => {
    // Better to surface a campaign that did not send than one stuck half-sent.
    await createSubscriber(list._id, { email: 'r@example.com' });
    const campaign = await createCampaign(list._id, {
      status: 'draft',
      bodySource: validCampaignDoc(),
    });

    // The driver hands back a fresh Collection object per call, so the spy has
    // to sit on the prototype to reach the instance freeze() uses.
    const insertMany = vi
      .spyOn(Collection.prototype, 'insertMany')
      .mockRejectedValueOnce(new Error('disk full'));

    await expect(freezeCampaign(campaign._id)).rejects.toThrow('disk full');
    insertMany.mockRestore();

    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.status).toBe('draft');
    expect(doc?.frozenAt).toBeUndefined();
    expect(
      await (await campaignBatchesCollection()).countDocuments({ campaignId: campaign._id }),
    ).toBe(0);
  });
});

describe('runSendCycle — scheduled campaigns that cannot start', () => {
  it('leaves a scheduled campaign alone when it fails the pre-send gate', async () => {
    // No subscribers, so recipient_count fails.
    const campaign = await createCampaign(list._id, {
      status: 'scheduled',
      scheduledFor: new Date('2026-08-01T09:00:00.000Z'),
      bodySource: validCampaignDoc(),
    });

    const summary = await runSendCycle({ now: new Date('2026-08-01T09:05:00.000Z') });

    expect(summary.scheduledStarted).toHaveLength(0);
    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.status).toBe('scheduled');
  });

  it('carries on with other work when one scheduled freeze throws', async () => {
    const broken = await createCampaign(list._id, {
      status: 'scheduled',
      scheduledFor: new Date('2026-08-01T09:00:00.000Z'),
      bodySource: validCampaignDoc(),
      subject: 'Broken',
    });
    const healthy = await frozenCampaign(1);

    vi.spyOn(Collection.prototype, 'insertMany').mockRejectedValueOnce(
      new Error('storage blip'),
    );

    const summary = await runSendCycle({ now: new Date('2026-08-01T09:05:00.000Z') });

    // The throw is logged and swallowed; the already-frozen campaign still sends.
    expect(summary.scheduledStarted).not.toContain(broken._id.toHexString());
    expect(summary.sent).toBeGreaterThan(0);
    expect(
      await (await sentLogCollection()).countDocuments({ campaignId: healthy._id }),
    ).toBe(1);
  });

  it('stops the run early once throttled rather than claiming more batches', async () => {
    await frozenCampaign(120);
    ses.throttleNextCalls = 1;

    const summary = await runSendCycle({ maxBatches: 10 });

    expect(summary.throttled).toBe(true);
    expect(summary.batchesProcessed).toBe(1);
    expect(summary.sent).toBe(0);
  });

  it('honours an explicit deadline', async () => {
    await frozenCampaign(120);

    // A zero-millisecond budget means the loop must not start at all.
    const summary = await runSendCycle({ deadlineMs: 0 });

    expect(summary.batchesProcessed).toBe(0);
  });
});

describe('the sleeper seam', () => {
  it('paces by default and can be replaced for tests', async () => {
    const waits: number[] = [];
    setSleeper(async (ms) => {
      waits.push(ms);
    });
    await frozenCampaign(3);

    await processBatch((await claimBatch('inv'))! as CampaignBatchDoc);
    expect(waits).toHaveLength(1);

    resetSleeper();
    // Restoring the real sleeper must not throw; a tiny wait keeps it quick.
    await new Promise((resolve) => setTimeout(resolve, 1));
  });
});
