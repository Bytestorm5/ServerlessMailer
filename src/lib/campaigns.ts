import { ObjectId } from 'mongodb';
import { BATCH_SIZE } from './env';
import { collections } from './db';
import { log } from './logger';
import { renderCampaign } from './render/render-campaign';
import { buildSegmentFilter } from './segments';
import { suppressedSubset } from './suppressions';
import type { CampaignBatchDoc, CampaignDoc, CampaignCounts, ListDoc, SubscriberDoc } from './types';

/**
 * Campaign freeze and lifecycle (§7.1, §7.6, §7.7).
 */

export const EMPTY_COUNTS: CampaignCounts = {
  recipients: 0,
  sent: 0,
  failed: 0,
  delivered: 0,
  bounced: 0,
  complained: 0,
  unsubscribed: 0,
  opened: 0,
  clicked: 0,
};

export type FreezeResult =
  | { ok: true; recipients: number; batches: number }
  | { ok: false; reason: 'not_found' | 'wrong_status' | 'already_freezing' | 'no_recipients' };

/**
 * Materializes the recipient set and freezes the body.
 *
 * Ordering matters and is not incidental: batches are created *before* the
 * campaign moves to `sending`. The claim query only considers campaigns that
 * are already `sending`, and the reconcile step only completes campaigns that
 * are `sending`, so a cron tick landing mid-freeze can neither send a partial
 * batch set nor declare an empty campaign finished.
 */
export async function freezeCampaign(campaignId: ObjectId): Promise<FreezeResult> {
  const c = await collections();
  const now = new Date();

  // Atomically take ownership of the freeze. A second caller — an operator
  // double-clicking Send, or the scheduler racing a manual send — gets
  // `already_freezing` and does nothing.
  const campaign = await c.campaigns.findOneAndUpdate(
    { _id: campaignId, status: { $in: ['draft', 'scheduled'] }, frozenAt: null },
    { $set: { frozenAt: now, updatedAt: now } },
    { returnDocument: 'after' },
  );

  if (!campaign) {
    const existing = await c.campaigns.findOne({ _id: campaignId });
    if (!existing) return { ok: false, reason: 'not_found' };
    if (existing.frozenAt && (existing.status === 'draft' || existing.status === 'scheduled')) {
      return { ok: false, reason: 'already_freezing' };
    }
    return { ok: false, reason: 'wrong_status' };
  }

  const list = await c.lists.findOne({ _id: campaign.listId });
  if (!list) {
    await c.campaigns.updateOne({ _id: campaignId }, { $set: { frozenAt: null } });
    return { ok: false, reason: 'not_found' };
  }

  try {
    // 1–3. Render once, freeze the output. A template change mid-send must not
    // produce two different emails (§6.2).
    const rendered = renderCampaign(campaign, list, {
      trackOpens: campaign.trackOpens,
      trackClicks: campaign.trackClicks,
    });

    // 1–2. Re-evaluate the segment and apply the exclusions.
    const { batches, recipients } = await materializeBatches(campaign, list);

    if (recipients === 0) {
      await c.campaignBatches.deleteMany({ campaignId });
      await c.campaigns.updateOne({ _id: campaignId }, { $set: { frozenAt: null, updatedAt: new Date() } });
      return { ok: false, reason: 'no_recipients' };
    }

    // 5. Only now does the campaign become claimable.
    await c.campaigns.updateOne(
      { _id: campaignId },
      {
        $set: {
          status: 'sending',
          bodyHtml: rendered.html,
          bodyText: rendered.text,
          subjectTemplate: rendered.subjectTemplate,
          mergePlan: rendered.mergePlan,
          trackedLinks: rendered.trackedLinks,
          startedAt: new Date(),
          completedAt: null,
          pausedAt: null,
          pauseReason: null,
          'counts.recipients': recipients,
          updatedAt: new Date(),
        },
      },
    );

    log.info('campaign frozen', { campaignId: String(campaignId), recipients, batches });
    return { ok: true, recipients, batches };
  } catch (error) {
    // Leave no half-frozen campaign behind.
    await c.campaignBatches.deleteMany({ campaignId });
    await c.campaigns.updateOne({ _id: campaignId }, { $set: { frozenAt: null, updatedAt: new Date() } });
    throw error;
  }
}

/**
 * Builds `campaign_batches` from the segment, excluding anyone not confirmed,
 * anyone suppressed, and anyone already in `sent_log` for this campaign.
 *
 * Streams rather than loading 19,000 documents at once: the working set here is
 * one buffer of ids, not the whole list.
 */
async function materializeBatches(
  campaign: CampaignDoc,
  _list: ListDoc,
): Promise<{ batches: number; recipients: number }> {
  const c = await collections();
  const filter = await buildSegmentFilter(campaign.listId, campaign.segmentQuery);

  const cursor = c.subscribers.find(filter, { projection: { _id: 1, email: 1 } }).sort({ _id: 1 });

  const BUFFER = 1000;
  let buffer: Pick<SubscriberDoc, '_id' | 'email'>[] = [];
  let pendingIds: ObjectId[] = [];
  let batchDocs: Omit<CampaignBatchDoc, '_id'>[] = [];
  let batchCount = 0;
  let recipientCount = 0;

  const flushBatchDocs = async (force: boolean) => {
    if (batchDocs.length >= 200 || (force && batchDocs.length > 0)) {
      await c.campaignBatches.insertMany(batchDocs as CampaignBatchDoc[], { ordered: false });
      batchDocs = [];
    }
  };

  const drainPending = async (force: boolean) => {
    while (pendingIds.length >= BATCH_SIZE || (force && pendingIds.length > 0)) {
      const slice = pendingIds.slice(0, BATCH_SIZE);
      pendingIds = pendingIds.slice(BATCH_SIZE);
      batchDocs.push({
        campaignId: campaign._id,
        listId: campaign.listId,
        subscriberIds: slice,
        status: 'pending',
        leaseUntil: new Date(0),
        claimedBy: null,
        attempts: 0,
        lastError: null,
        sentAt: null,
        createdAt: new Date(),
      });
      batchCount += 1;
      recipientCount += slice.length;
      await flushBatchDocs(false);
    }
  };

  const processBuffer = async () => {
    if (buffer.length === 0) return;

    const suppressed = await suppressedSubset(buffer.map((s) => s.email));
    const candidateIds = buffer.filter((s) => !suppressed.has(s.email)).map((s) => s._id);

    // Anyone already logged as sent for this campaign is excluded, so a
    // re-freeze after a partial failure never re-mails the people who did
    // receive it.
    const alreadySent = new Set<string>();
    if (candidateIds.length > 0) {
      const sentCursor = c.sentLog.find(
        { campaignId: campaign._id, subscriberId: { $in: candidateIds } },
        { projection: { subscriberId: 1 } },
      );
      for await (const doc of sentCursor) alreadySent.add(String(doc.subscriberId));
    }

    for (const id of candidateIds) {
      if (!alreadySent.has(String(id))) pendingIds.push(id);
    }

    buffer = [];
    await drainPending(false);
  };

  for await (const subscriber of cursor) {
    buffer.push(subscriber as Pick<SubscriberDoc, '_id' | 'email'>);
    if (buffer.length >= BUFFER) await processBuffer();
  }
  await processBuffer();
  await drainPending(true);
  await flushBatchDocs(true);

  return { batches: batchCount, recipients: recipientCount };
}

// ---------------------------------------------------------------------------
// Pause, resume, cancel (§7.7)
// ---------------------------------------------------------------------------

export async function pauseCampaign(campaignId: ObjectId, reason: string): Promise<boolean> {
  const c = await collections();
  const result = await c.campaigns.updateOne(
    { _id: campaignId, status: 'sending' },
    { $set: { status: 'paused', pausedAt: new Date(), pauseReason: reason, updatedAt: new Date() } },
  );
  if (result.modifiedCount === 1) {
    log.warn('campaign paused', { campaignId: String(campaignId), reason });
  }
  return result.modifiedCount === 1;
}

export async function resumeCampaign(campaignId: ObjectId): Promise<boolean> {
  const c = await collections();
  const result = await c.campaigns.updateOne(
    { _id: campaignId, status: 'paused' },
    { $set: { status: 'sending', pausedAt: null, pauseReason: null, updatedAt: new Date() } },
  );
  return result.modifiedCount === 1;
}

/**
 * Abandons the remainder of a send. Already-sent batches are untouched — the
 * `sent_log` entries stand, so a later resend of the same campaign skips them.
 */
export async function cancelCampaign(campaignId: ObjectId): Promise<boolean> {
  const c = await collections();
  const result = await c.campaigns.updateOne(
    { _id: campaignId, status: { $in: ['sending', 'paused', 'scheduled'] } },
    { $set: { status: 'failed', completedAt: new Date(), pauseReason: 'Cancelled by operator', updatedAt: new Date() } },
  );
  await c.campaignBatches.updateMany(
    { campaignId, status: { $in: ['pending', 'claimed'] } },
    { $set: { status: 'failed', lastError: 'Cancelled by operator' } },
  );
  return result.modifiedCount === 1;
}

export async function scheduleCampaign(campaignId: ObjectId, when: Date): Promise<boolean> {
  const c = await collections();
  const result = await c.campaigns.updateOne(
    { _id: campaignId, status: 'draft' },
    { $set: { status: 'scheduled', scheduledFor: when, updatedAt: new Date() } },
  );
  return result.modifiedCount === 1;
}

export async function unscheduleCampaign(campaignId: ObjectId): Promise<boolean> {
  const c = await collections();
  const result = await c.campaigns.updateOne(
    { _id: campaignId, status: 'scheduled' },
    { $set: { status: 'draft', scheduledFor: null, updatedAt: new Date() } },
  );
  return result.modifiedCount === 1;
}

/**
 * Clears a freeze that never finished — the process died between taking the
 * freeze lock and flipping the campaign to `sending`. Run from the daily job.
 */
export async function recoverStalledFreezes(olderThanMs = 15 * 60 * 1000): Promise<number> {
  const c = await collections();
  const cutoff = new Date(Date.now() - olderThanMs);
  const stalled = await c.campaigns
    .find({ status: { $in: ['draft', 'scheduled'] }, frozenAt: { $ne: null, $lt: cutoff } })
    .toArray();

  for (const campaign of stalled) {
    await c.campaignBatches.deleteMany({ campaignId: campaign._id });
    await c.campaigns.updateOne({ _id: campaign._id }, { $set: { frozenAt: null, updatedAt: new Date() } });
    log.warn('recovered stalled freeze', { campaignId: String(campaign._id) });
  }
  return stalled.length;
}

/** Scheduled campaigns whose time has come (§7.1). */
export async function dueScheduledCampaigns(now = new Date()): Promise<CampaignDoc[]> {
  const c = await collections();
  return c.campaigns.find({ status: 'scheduled', scheduledFor: { $lte: now }, frozenAt: null }).toArray();
}
