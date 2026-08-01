import type { ObjectId } from 'mongodb';
import { campaignBatchesCollection, campaignsCollection } from '@/lib/db/collections';
import { config } from '@/lib/config';
import type { CampaignBatchDoc } from '@/lib/types';

/**
 * Batch claiming (spec §7.3).
 *
 * A single atomic `findOneAndUpdate`. MongoDB guarantees atomicity on
 * single-document updates, which is what makes this safe without transactions
 * and what makes overlapping cron invocations harmless — they claim disjoint
 * batches.
 *
 * **The lease is the whole design.** Without `leaseUntil`, a function that dies
 * mid-batch leaves 50 people permanently unsent with no error anywhere. With
 * it, the next tick picks the work back up. Cron plus lease expiry *is* the
 * retry queue.
 */

/**
 * Only campaigns actually in `sending` are eligible. Excluding paused campaigns
 * here is exactly what makes the pause button effective within one minute
 * (§7.7) — no other coordination is needed.
 */
export async function activeSendingCampaignIds(_now: Date = new Date()): Promise<ObjectId[]> {
  const campaigns = await campaignsCollection();
  const docs = await campaigns
    .find({ status: 'sending' }, { projection: { _id: 1 } })
    .toArray();
  return docs.map((doc) => doc._id);
}

export async function claimBatch(
  invocationId: string,
  now: Date = new Date(),
): Promise<CampaignBatchDoc | null> {
  const campaignIds = await activeSendingCampaignIds(now);
  if (campaignIds.length === 0) return null;

  const batches = await campaignBatchesCollection();
  const claimed = await batches.findOneAndUpdate(
    {
      campaignId: { $in: campaignIds },
      $or: [
        { status: 'pending' },
        // Reclaim work abandoned by an invocation that died mid-batch.
        { status: 'claimed', leaseUntil: { $lt: now } },
      ],
      attempts: { $lt: config.maxBatchAttempts() },
    },
    {
      $set: {
        status: 'claimed',
        leaseUntil: new Date(now.getTime() + config.batchLeaseMs()),
        claimedBy: invocationId,
      },
      $inc: { attempts: 1 },
    },
    { returnDocument: 'after' },
  );

  return claimed ?? null;
}

/**
 * Hands the batch straight back. Used on throttling, where the correct response
 * is to stop and let the next tick retry rather than hammer SES (§7.5).
 */
export async function releaseBatch(
  batchId: ObjectId,
  error?: string,
  now: Date = new Date(),
): Promise<void> {
  const batches = await campaignBatchesCollection();
  await batches.updateOne(
    { _id: batchId },
    {
      $set: {
        status: 'pending',
        // Expiring the lease immediately makes it claimable on the next tick.
        leaseUntil: now,
        ...(error ? { lastError: error } : {}),
      },
      $unset: { claimedBy: '' },
    },
  );
}

export async function completeBatch(
  batchId: ObjectId,
  now: Date = new Date(),
): Promise<void> {
  const batches = await campaignBatchesCollection();
  await batches.updateOne(
    { _id: batchId },
    {
      $set: { status: 'sent', sentAt: now },
      $unset: { leaseUntil: '', claimedBy: '' },
    },
  );
}

/**
 * Terminal failure. Surfaced in the UI with `lastError` for manual review
 * (§7.6) rather than retried forever.
 */
export async function failBatch(
  batchId: ObjectId,
  error: string,
  _now: Date = new Date(),
): Promise<void> {
  const batches = await campaignBatchesCollection();
  await batches.updateOne(
    { _id: batchId },
    {
      $set: { status: 'failed', lastError: error },
      $unset: { leaseUntil: '', claimedBy: '' },
    },
  );
}
