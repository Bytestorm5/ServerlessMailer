import { randomUUID } from 'node:crypto';
import { sendPendingConfirmations } from '@/lib/confirmations';
import { campaignsCollection } from '@/lib/db/collections';
import { config } from '@/lib/config';
import { logger } from '@/lib/logging';
import { claimBatch } from '@/lib/pipeline/claim';
import { evaluateAllSendingCampaigns } from '@/lib/pipeline/circuit';
import { freezeCampaign } from '@/lib/pipeline/freeze';
import { processBatch } from '@/lib/pipeline/process';
import { reconcileCompletedCampaigns } from '@/lib/pipeline/reconcile';

export interface CronRunSummary {
  invocationId: string;
  batchesProcessed: number;
  sent: number;
  failed: number;
  skipped: number;
  throttled: boolean;
  scheduledStarted: string[];
  completedCampaigns: string[];
  pausedCampaigns: string[];
  confirmationsSent: number;
  durationMs: number;
}

/**
 * One cron invocation (spec §7.2).
 *
 * Vercel does not retry failed cron invocations and does not prevent
 * overlapping runs. Neither matters: overlapping runs claim disjoint batches,
 * and a run that dies leaves its batches leased until the lease expires, at
 * which point the next tick reclaims them. Cron plus lease expiry *is* the
 * retry queue.
 *
 * The 45-second budget leaves headroom before the next tick, and
 * MAX_BATCHES_PER_RUN is sized to the SES quota rather than to the clock.
 */
export async function runSendCycle(
  opts: { now?: Date; deadlineMs?: number; maxBatches?: number } = {},
): Promise<CronRunSummary> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const invocationId = randomUUID();
  const budgetMs = opts.deadlineMs ?? config.cronBudgetMs();
  const maxBatches = opts.maxBatches ?? config.maxBatchesPerRun();
  const deadline = started + budgetMs;

  const summary: CronRunSummary = {
    invocationId,
    batchesProcessed: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    throttled: false,
    scheduledStarted: [],
    completedCampaigns: [],
    pausedCampaigns: [],
    confirmationsSent: 0,
    durationMs: 0,
  };

  // Subscribers imported without a prior-consent attestation land as `pending`
  // and must receive a confirmation email (§4.3). Import cannot send those
  // inline, so they drain here, bounded per tick.
  try {
    const confirmations = await sendPendingConfirmations({ limit: 50, now });
    summary.confirmationsSent = confirmations.sent;
  } catch (err) {
    // Never let this stop the campaign send, which is the cron's main job.
    logger.error('pending confirmations failed', { error: (err as Error).message });
  }

  // Promote any scheduled campaign whose time has come. Freeze is what moves it
  // into `sending`; until then its batches do not exist and nothing is claimable.
  const due = await (await campaignsCollection())
    .find(
      { status: 'scheduled', scheduledFor: { $lte: now } },
      { projection: { _id: 1 } },
    )
    .toArray();

  for (const campaign of due) {
    try {
      const frozen = await freezeCampaign(campaign._id, now);
      if (frozen.ok) {
        summary.scheduledStarted.push(campaign._id.toHexString());
      } else {
        logger.warn('scheduled campaign did not start', {
          campaignId: campaign._id.toHexString(),
          reason: frozen.reason,
        });
      }
    } catch (err) {
      logger.error('scheduled freeze threw', {
        campaignId: campaign._id.toHexString(),
        error: (err as Error).message,
      });
    }
  }

  // The send loop.
  while (Date.now() < deadline && summary.batchesProcessed < maxBatches) {
    const batch = await claimBatch(invocationId, new Date());
    if (!batch) break;

    const outcome = await processBatch(batch, new Date());
    summary.batchesProcessed += 1;
    summary.sent += outcome.sent;
    summary.failed += outcome.failed;
    summary.skipped += outcome.skipped;

    if (outcome.throttled) {
      // Exit the run early rather than hammering SES.
      summary.throttled = true;
      break;
    }
  }

  // The circuit breaker runs every tick so it can pause a campaign within a
  // minute of the complaints arriving via SNS (§7.8).
  const paused = await evaluateAllSendingCampaigns(new Date());
  summary.pausedCampaigns = paused.map((id) => id.toHexString());

  const completed = await reconcileCompletedCampaigns(new Date());
  summary.completedCampaigns = completed.map((id) => id.toHexString());

  summary.durationMs = Date.now() - started;
  logger.info('send cycle complete', { ...summary });
  return summary;
}
