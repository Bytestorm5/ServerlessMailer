import type { ObjectId } from 'mongodb';
import { campaignBatchesCollection, campaignsCollection } from '@/lib/db/collections';
import { logger } from '@/lib/logging';

/**
 * Completion (spec §7.6).
 *
 * A campaign is `sent` when it has zero batches in `pending` or `claimed`.
 * Batches left in `failed` do not hold the campaign open — they are surfaced in
 * the UI with their `lastError` for manual review.
 *
 * Paused campaigns are deliberately excluded: a paused campaign with no
 * claimable batches is waiting for a human, not finished, and marking it `sent`
 * would silently strand its remaining recipients.
 */
export async function reconcileCompletedCampaigns(
  now: Date = new Date(),
): Promise<ObjectId[]> {
  const campaigns = await campaignsCollection();
  const batches = await campaignBatchesCollection();

  const sending = await campaigns
    .find({ status: 'sending' }, { projection: { _id: 1 } })
    .toArray();
  if (sending.length === 0) return [];

  const completed: ObjectId[] = [];

  for (const campaign of sending) {
    const outstanding = await batches.countDocuments({
      campaignId: campaign._id,
      status: { $in: ['pending', 'claimed'] },
    });
    if (outstanding > 0) continue;

    // A `sending` campaign with no batches at all is mid-freeze: the status is
    // flipped before the batches are materialised, so that a partially-frozen
    // campaign is never claimable. Completing it here would silently drop every
    // recipient, so it is left alone until its batches appear.
    const total = await batches.countDocuments({ campaignId: campaign._id });
    if (total === 0) continue;

    // Guarded on status so a concurrent pause between the read above and this
    // write cannot be overwritten by a stale completion.
    const result = await campaigns.updateOne(
      { _id: campaign._id, status: 'sending' },
      { $set: { status: 'sent', completedAt: now } },
    );
    if (result.modifiedCount > 0) {
      completed.push(campaign._id);
      logger.info('campaign completed', { campaignId: campaign._id.toHexString() });
    }
  }

  return completed;
}
