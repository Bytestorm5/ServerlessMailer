import type { ObjectId } from 'mongodb';
import { campaignsCollection } from '@/lib/db/collections';

/**
 * Reputation monitoring (spec §8.3).
 *
 * These are the SES *account-level* thresholds, and they are the failure mode
 * that matters: crossing them does not degrade delivery, it stops it. The
 * dashboard surfaces these prominently rather than burying them in a metrics
 * tab, which is why this lives outside the optional metrics tier.
 */
export const REPUTATION_THRESHOLDS = {
  /** Above 5% the account is under review; above 10% sending is paused. */
  bounce: { atRisk: 0.05, critical: 0.1 },
  /** Above 0.1% under review; above 0.5% sending is paused. */
  complaint: { atRisk: 0.001, critical: 0.005 },
} as const;

export type ReputationStatus = 'ok' | 'at_risk' | 'critical';

export interface ReputationSnapshot {
  windowDays: number;
  delivered: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
  sent: number;
  bounceRate: number;
  complaintRate: number;
  bounceStatus: ReputationStatus;
  complaintStatus: ReputationStatus;
  campaigns: number;
}

function classify(
  rate: number,
  thresholds: { atRisk: number; critical: number },
): ReputationStatus {
  if (rate >= thresholds.critical) return 'critical';
  if (rate >= thresholds.atRisk) return 'at_risk';
  return 'ok';
}

/**
 * Rolling bounce and complaint rates over the last `days`.
 *
 * Campaigns that are actively sending are included deliberately: a campaign
 * going out right now is exactly the one an operator needs to be watching, and
 * excluding it would hide the problem until after it finished.
 */
export async function reputationSnapshot(opts: {
  days?: number;
  now?: Date;
  listId?: ObjectId;
} = {}): Promise<ReputationSnapshot> {
  const windowDays = opts.days ?? 30;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const campaigns = await campaignsCollection();
  const docs = await campaigns
    .find({
      ...(opts.listId ? { listId: opts.listId } : {}),
      status: { $in: ['sending', 'paused', 'sent'] },
      $or: [{ completedAt: { $gte: since } }, { startedAt: { $gte: since } }],
    })
    .toArray();

  const totals = docs.reduce(
    (acc, campaign) => {
      acc.delivered += campaign.counts?.delivered ?? 0;
      acc.bounced += campaign.counts?.bounced ?? 0;
      acc.complained += campaign.counts?.complained ?? 0;
      acc.unsubscribed += campaign.counts?.unsubscribed ?? 0;
      acc.sent += campaign.counts?.sent ?? 0;
      return acc;
    },
    { delivered: 0, bounced: 0, complained: 0, unsubscribed: 0, sent: 0 },
  );

  // SES computes its account-level rates against messages *sent*, and so does
  // this. Using `delivered` instead would be actively dangerous: delivery
  // events are an optional SNS subscription (§8.2), so a deployment without
  // them would show a 0% bounce rate no matter how badly the account was
  // burning. `counts.sent` is incremented by the pipeline itself on every
  // message SES accepts, so it is always populated.
  const denominator = totals.sent > 0 ? totals.sent : totals.delivered + totals.bounced;
  const bounceRate = denominator > 0 ? totals.bounced / denominator : 0;
  const complaintRate = denominator > 0 ? totals.complained / denominator : 0;

  return {
    windowDays,
    ...totals,
    bounceRate,
    complaintRate,
    bounceStatus: classify(bounceRate, REPUTATION_THRESHOLDS.bounce),
    complaintStatus: classify(complaintRate, REPUTATION_THRESHOLDS.complaint),
    campaigns: docs.length,
  };
}
