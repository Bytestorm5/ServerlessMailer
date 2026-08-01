import { collections } from './db';
import { env } from './env';

/**
 * Reputation monitoring (§8.3).
 *
 * The SES account-level thresholds are the failure mode that matters:
 *
 *   bounce    > 5%   → account under review;  > 10%  → sending paused
 *   complaint > 0.1% → account under review;  > 0.5% → sending paused
 *
 * These numbers belong on the dashboard, not buried in a metrics tab, so this
 * module is deliberately cheap to call on every dashboard render.
 */

export interface ReputationWindow {
  label: string;
  since: Date;
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  bounceRate: number;
  complaintRate: number;
  bounceStatus: RiskLevel;
  complaintStatus: RiskLevel;
}

export type RiskLevel = 'ok' | 'warning' | 'critical';

export const SES_THRESHOLDS = {
  bounceReview: 0.05,
  bouncePaused: 0.1,
  complaintReview: 0.001,
  complaintPaused: 0.005,
} as const;

function bounceRisk(rate: number, sample: number): RiskLevel {
  if (sample < 100) return 'ok';
  if (rate >= SES_THRESHOLDS.bouncePaused) return 'critical';
  if (rate >= SES_THRESHOLDS.bounceReview) return 'warning';
  return 'ok';
}

function complaintRisk(rate: number, sample: number): RiskLevel {
  if (sample < 100) return 'ok';
  if (rate >= SES_THRESHOLDS.complaintPaused) return 'critical';
  if (rate >= SES_THRESHOLDS.complaintReview) return 'warning';
  return 'ok';
}

async function windowStats(label: string, since: Date): Promise<ReputationWindow> {
  const c = await collections();

  const [sent, delivered, bounced, complained] = await Promise.all([
    c.sentLog.countDocuments({ sentAt: { $gte: since } }),
    c.events.countDocuments({ type: 'delivered', ts: { $gte: since } }),
    c.events.countDocuments({ type: 'bounce', ts: { $gte: since } }),
    c.events.countDocuments({ type: 'complaint', ts: { $gte: since } }),
  ]);

  // Denominator is messages SES accepted. Using `delivered` would flatter the
  // bounce rate, because a bounced message is by definition not delivered.
  const denominator = sent || 0;
  const bounceRate = denominator > 0 ? bounced / denominator : 0;
  const complaintRate = denominator > 0 ? complained / denominator : 0;

  return {
    label,
    since,
    sent,
    delivered,
    bounced,
    complained,
    bounceRate,
    complaintRate,
    bounceStatus: bounceRisk(bounceRate, denominator),
    complaintStatus: complaintRisk(complaintRate, denominator),
  };
}

export async function rollingReputation(): Promise<ReputationWindow[]> {
  const now = Date.now();
  return Promise.all([
    windowStats('Last 24 hours', new Date(now - 24 * 60 * 60 * 1000)),
    windowStats('Last 7 days', new Date(now - 7 * 24 * 60 * 60 * 1000)),
    windowStats('Last 30 days', new Date(now - 30 * 24 * 60 * 60 * 1000)),
  ]);
}

export interface PipelineHealth {
  sendingCampaigns: number;
  pausedCampaigns: number;
  pendingBatches: number;
  claimedBatches: number;
  failedBatches: number;
  /** Batches whose lease expired and are waiting to be reclaimed. */
  staleBatches: number;
  sendRate: number;
  maxBatchesPerRun: number;
}

export async function pipelineHealth(): Promise<PipelineHealth> {
  const c = await collections();
  const now = new Date();

  const [sendingCampaigns, pausedCampaigns, pendingBatches, claimedBatches, failedBatches, staleBatches] =
    await Promise.all([
      c.campaigns.countDocuments({ status: 'sending' }),
      c.campaigns.countDocuments({ status: 'paused' }),
      c.campaignBatches.countDocuments({ status: 'pending' }),
      c.campaignBatches.countDocuments({ status: 'claimed' }),
      c.campaignBatches.countDocuments({ status: 'failed' }),
      c.campaignBatches.countDocuments({ status: 'claimed', leaseUntil: { $lt: now } }),
    ]);

  return {
    sendingCampaigns,
    pausedCampaigns,
    pendingBatches,
    claimedBatches,
    failedBatches,
    staleBatches,
    sendRate: env.sesMaxSendRate,
    maxBatchesPerRun: env.maxBatchesPerRun,
  };
}
