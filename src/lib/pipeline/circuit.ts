import type { ObjectId } from 'mongodb';
import { campaignsCollection } from '@/lib/db/collections';
import { config } from '@/lib/config';
import { logger } from '@/lib/logging';

/**
 * Automatic circuit breaker (spec §7.8).
 *
 * If the complaint rate for a campaign exceeds the configured threshold during
 * an active send, the campaign is auto-paused. SES puts an account under review
 * at a 0.1% complaint rate and suspends sending at 0.5% (§8.3), so this is the
 * difference between a bad campaign and a suspended account.
 *
 * A minimum delivered count guards against a false alarm: one complaint out of
 * ten delivered is a 10% rate but it is noise, not signal.
 */
export async function checkCircuitBreaker(
  campaignId: ObjectId,
  _now: Date = new Date(),
): Promise<{ tripped: boolean; complaintRate: number; delivered: number }> {
  const campaigns = await campaignsCollection();
  const campaign = await campaigns.findOne(
    { _id: campaignId },
    { projection: { counts: 1 } },
  );

  if (!campaign) return { tripped: false, complaintRate: 0, delivered: 0 };

  const delivered = campaign.counts?.delivered ?? 0;
  const complained = campaign.counts?.complained ?? 0;
  const complaintRate = delivered > 0 ? complained / delivered : 0;

  const tripped =
    delivered >= config.complaintCircuitBreakerMinDelivered() &&
    complaintRate > config.complaintCircuitBreakerRate();

  return { tripped, complaintRate, delivered };
}

/**
 * Checks every actively-sending campaign and pauses the offenders. Called at
 * the end of each cron run, which is what makes the breaker effective within
 * one minute of the complaints arriving via SNS.
 */
export async function evaluateAllSendingCampaigns(
  now: Date = new Date(),
): Promise<ObjectId[]> {
  const campaigns = await campaignsCollection();
  const sending = await campaigns
    .find({ status: 'sending' }, { projection: { _id: 1 } })
    .toArray();

  const paused: ObjectId[] = [];

  for (const campaign of sending) {
    const result = await checkCircuitBreaker(campaign._id, now);
    if (!result.tripped) continue;

    const reason =
      `Auto-paused: complaint rate ${(result.complaintRate * 100).toFixed(3)}% of ` +
      `${result.delivered} delivered exceeds the ` +
      `${(config.complaintCircuitBreakerRate() * 100).toFixed(3)}% threshold.`;

    // Guarded on `sending` so this cannot resurrect-then-pause a campaign that
    // a human paused or that completed in the meantime.
    const updated = await campaigns.updateOne(
      { _id: campaign._id, status: 'sending' },
      { $set: { status: 'paused', pausedAt: now, pausedReason: reason } },
    );

    if (updated.modifiedCount > 0) {
      paused.push(campaign._id);
      // Loud on purpose: this is an alerting condition, not a routine event.
      logger.error('circuit breaker tripped, campaign auto-paused', {
        campaignId: campaign._id.toHexString(),
        complaintRate: result.complaintRate,
        delivered: result.delivered,
      });
    }
  }

  return paused;
}
