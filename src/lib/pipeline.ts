import { ObjectId } from 'mongodb';
import { env } from './env';
import { collections, isDuplicateKeyError } from './db';
import { errorMessage, log } from './logger';
import { getMailer, ThrottlingError, type BulkDestination } from './mailer';
import { resolveMergePlan } from './merge';
import { OPEN_PIXEL_VARIABLE, clickVariable, openPixelUrl, signClickToken, signOpenToken } from './tracking';
import { preferencesUrl, signUnsubscribeToken, unsubscribeMailto, unsubscribeUrl } from './unsubscribe';
import { pauseCampaign } from './campaigns';
import { sendAlert } from './alerts';
import type { CampaignBatchDoc, CampaignDoc, ListDoc, SubscriberDoc } from './types';

/**
 * The send pipeline (§7).
 *
 * Vercel does not retry failed cron invocations and does not prevent
 * overlapping runs. Neither matters here: a failed run leaves batches leased,
 * and the next tick reclaims them once the lease expires. Cron plus lease
 * expiry *is* the retry queue.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// §7.3 Claiming a batch
// ---------------------------------------------------------------------------

/**
 * A single atomic `findOneAndUpdate`. MongoDB guarantees atomicity on
 * single-document updates, which is what makes this safe without transactions:
 * two overlapping invocations cannot claim the same batch.
 *
 * The lease is the whole design. Without `leaseUntil`, a function that dies
 * mid-batch leaves 50 people permanently unsent with no error anywhere.
 */
export async function claimBatch(
  activeSendingCampaignIds: ObjectId[],
  invocationId: string,
): Promise<CampaignBatchDoc | null> {
  if (activeSendingCampaignIds.length === 0) return null;
  const c = await collections();
  const now = new Date();

  const claimed = await c.campaignBatches.findOneAndUpdate(
    {
      campaignId: { $in: activeSendingCampaignIds },
      $or: [
        { status: 'pending' },
        // Reclaim work whose owner died. This is the recovery path.
        { status: 'claimed', leaseUntil: { $lt: now } },
      ],
      attempts: { $lt: env.maxBatchAttempts },
    },
    {
      $set: {
        status: 'claimed',
        leaseUntil: new Date(now.getTime() + env.batchLeaseMs),
        claimedBy: invocationId,
      },
      $inc: { attempts: 1 },
    },
    { returnDocument: 'after', sort: { _id: 1 } },
  );

  return claimed ?? null;
}

/**
 * Campaigns eligible to have batches claimed. Excluding paused campaigns here
 * is exactly what makes the pause button effective within one minute (§7.7) —
 * there is no separate signal to propagate.
 */
export async function activeSendingCampaignIds(): Promise<ObjectId[]> {
  const c = await collections();
  const campaigns = await c.campaigns.find({ status: 'sending' }, { projection: { _id: 1 } }).toArray();
  return campaigns.map((campaign) => campaign._id);
}

/** Puts a batch back for the next tick without consuming an attempt. */
async function releaseBatch(batchId: ObjectId, reason: string): Promise<void> {
  const c = await collections();
  await c.campaignBatches.updateOne(
    { _id: batchId },
    {
      $set: { status: 'pending', leaseUntil: new Date(0), lastError: reason },
      // Back-pressure is not the batch's fault; it must not burn an attempt.
      $inc: { attempts: -1 },
    },
  );
}

// ---------------------------------------------------------------------------
// §7.4 Processing a batch
// ---------------------------------------------------------------------------

export interface ProcessBatchResult {
  sent: number;
  failed: number;
  skipped: number;
  duplicates: number;
}

export function buildDestination(
  subscriber: SubscriberDoc,
  campaign: CampaignDoc,
  list: ListDoc,
): BulkDestination {
  const unsubToken = signUnsubscribeToken(subscriber._id, campaign._id);
  const unsubUrl = unsubscribeUrl(unsubToken);
  const prefsUrl = preferencesUrl(unsubToken);

  const data: Record<string, string> = {
    ...resolveMergePlan(campaign.mergePlan ?? [], subscriber),
    unsubscribe_url: unsubUrl,
    preferences_url: prefsUrl,
    physical_address: list.physicalAddress,
    list_name: list.name,
    from_name: list.fromName,
    subject: campaign.subject,
  };

  if (campaign.trackOpens) {
    data[OPEN_PIXEL_VARIABLE] = openPixelUrl(signOpenToken(campaign._id, subscriber._id));
  }

  if (campaign.trackClicks) {
    const links = campaign.trackedLinks ?? [];
    for (let index = 0; index < links.length; index += 1) {
      const target = links[index] as string;
      data[clickVariable(index)] =
        `${env.appBaseUrl}/api/t/c/${signClickToken(campaign._id, subscriber._id, target)}`;
    }
  }

  return {
    to: subscriber.email,
    replacementData: data,
    headers: {
      // Both headers are mandatory under the Google and Yahoo bulk sender
      // requirements at this volume (§9.1).
      'List-Unsubscribe': `<mailto:${unsubscribeMailto(list.sendingDomain)}>, <${unsubUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    tags: {
      campaign_id: String(campaign._id),
      list_id: String(list._id),
      type: 'campaign',
    },
  };
}

export async function processBatch(batch: CampaignBatchDoc): Promise<ProcessBatchResult> {
  const c = await collections();
  const result: ProcessBatchResult = { sent: 0, failed: 0, skipped: 0, duplicates: 0 };

  const campaign = await c.campaigns.findOne({ _id: batch.campaignId });
  const list = campaign ? await c.lists.findOne({ _id: campaign.listId }) : null;

  if (!campaign || !list || !campaign.bodyHtml || !campaign.bodyText || !campaign.subjectTemplate) {
    await c.campaignBatches.updateOne(
      { _id: batch._id },
      { $set: { status: 'failed', lastError: 'Campaign or list missing, or body not frozen' } },
    );
    return result;
  }

  // 1. Load the subscriber documents.
  const subscribers = await c.subscribers.find({ _id: { $in: batch.subscriberIds } }).toArray();

  // 2. Re-check suppressions and status. The freeze may have happened an hour
  //    ago and someone may have unsubscribed since. This second check is not
  //    redundant, it is the point (§7.4).
  const emails = subscribers.map((s) => s.email);
  const suppressed = await suppressedNow(emails);

  const eligible = subscribers.filter(
    (subscriber) => subscriber.status === 'confirmed' && !suppressed.has(subscriber.email),
  );
  result.skipped = subscribers.length - eligible.length;

  // Anyone already in `sent_log` is skipped before the API call, so a retry of
  // a partially-delivered batch does not pay to re-send them.
  const alreadySent = new Set<string>();
  const sentCursor = c.sentLog.find(
    { campaignId: campaign._id, subscriberId: { $in: eligible.map((s) => s._id) } },
    { projection: { subscriberId: 1 } },
  );
  for await (const doc of sentCursor) alreadySent.add(String(doc.subscriberId));

  const recipients = eligible.filter((subscriber) => !alreadySent.has(String(subscriber._id)));
  result.skipped += eligible.length - recipients.length;

  if (recipients.length === 0) {
    await c.campaignBatches.updateOne(
      { _id: batch._id },
      { $set: { status: 'sent', sentAt: new Date(), lastError: null } },
    );
    return result;
  }

  // 3–4. One SES call for up to 50 destinations.
  const destinations = recipients.map((subscriber) => buildDestination(subscriber, campaign, list));

  const response = await getMailer().sendBulk({
    fromName: list.fromName,
    fromEmail: list.fromEmail,
    replyTo: list.replyTo,
    configurationSet: list.sesConfigurationSet || undefined,
    subjectTemplate: campaign.subjectTemplate,
    htmlTemplate: campaign.bodyHtml,
    textTemplate: campaign.bodyText,
    defaultData: {
      physical_address: list.physicalAddress,
      list_name: list.name,
      from_name: list.fromName,
      subject: campaign.subject,
    },
    destinations,
    tags: { campaign_id: String(campaign._id), list_id: String(list._id), type: 'campaign' },
  });

  // 5. Per-destination results. One bad address must not fail the batch.
  const errors: string[] = [];
  for (let index = 0; index < recipients.length; index += 1) {
    const subscriber = recipients[index] as SubscriberDoc;
    const outcome = response.outcomes[index];
    if (!outcome) {
      result.failed += 1;
      errors.push('missing outcome');
      continue;
    }
    if (outcome.ok) {
      try {
        await c.sentLog.insertOne({
          campaignId: campaign._id,
          subscriberId: subscriber._id,
          sesMessageId: outcome.messageId,
          sentAt: new Date(),
        } as never);
        result.sent += 1;
      } catch (error) {
        // A duplicate-key error means "already sent". Swallow it and continue:
        // the invariant did its job (§3.6).
        if (isDuplicateKeyError(error)) result.duplicates += 1;
        else throw error;
      }
    } else {
      result.failed += 1;
      if (errors.length < 5) errors.push(outcome.error);
    }
  }

  // 6. Mark the batch.
  await c.campaignBatches.updateOne(
    { _id: batch._id },
    {
      $set: {
        status: 'sent',
        sentAt: new Date(),
        lastError: errors.length > 0 ? errors.join(' | ') : null,
      },
    },
  );

  await c.campaigns.updateOne(
    { _id: campaign._id },
    { $inc: { 'counts.sent': result.sent, 'counts.failed': result.failed } },
  );

  return result;
}

async function suppressedNow(emails: string[]): Promise<Set<string>> {
  const c = await collections();
  const found = new Set<string>();
  if (emails.length === 0) return found;
  const cursor = c.suppressions.find({ email: { $in: emails } }, { projection: { email: 1 } });
  for await (const doc of cursor) found.add(doc.email);
  return found;
}

/** Records a permanent batch failure once attempts are exhausted (§7.6). */
async function failBatch(batch: CampaignBatchDoc, error: unknown): Promise<void> {
  const c = await collections();
  const message = errorMessage(error).slice(0, 500);
  const exhausted = batch.attempts >= env.maxBatchAttempts;

  await c.campaignBatches.updateOne(
    { _id: batch._id },
    {
      $set: {
        status: exhausted ? 'failed' : 'pending',
        leaseUntil: new Date(0),
        lastError: message,
      },
    },
  );

  log.error('batch processing failed', {
    batchId: String(batch._id),
    campaignId: String(batch.campaignId),
    attempts: batch.attempts,
    exhausted,
    error: message,
  });

  if (exhausted) {
    await sendAlert('Batch failed permanently', {
      batchId: String(batch._id),
      campaignId: String(batch.campaignId),
      attempts: batch.attempts,
      lastError: message,
    });
  }
}

// ---------------------------------------------------------------------------
// §7.8 Circuit breaker
// ---------------------------------------------------------------------------

export interface CircuitBreakerVerdict {
  tripped: boolean;
  reason?: string;
}

/**
 * Auto-pauses a campaign whose complaint or bounce rate crosses the configured
 * threshold mid-send. This is the difference between a bad campaign and a
 * suspended SES account (§7.8).
 *
 * A minimum sample size guards against the first three recipients including
 * one complainer and pausing a healthy send at 0.6% of 500.
 */
export async function checkCircuitBreaker(campaignId: ObjectId): Promise<CircuitBreakerVerdict> {
  const c = await collections();
  const campaign = await c.campaigns.findOne({ _id: campaignId });
  if (!campaign || campaign.status !== 'sending') return { tripped: false };

  const { delivered, complained, bounced, sent } = campaign.counts;
  // Before SNS delivery events arrive, `sent` is the only denominator available.
  const denominator = Math.max(delivered, 0) || sent;
  if (denominator === 0) return { tripped: false };

  const complaintRate = complained / denominator;
  if (denominator >= env.complaintMinDelivered && complaintRate > env.complaintRateThreshold) {
    const reason = `Complaint rate ${(complaintRate * 100).toFixed(3)}% exceeded ${(env.complaintRateThreshold * 100).toFixed(3)}% over ${denominator} messages`;
    await pauseCampaign(campaignId, reason);
    await sendAlert('Circuit breaker tripped: complaint rate', {
      campaignId: String(campaignId),
      complaintRate,
      denominator,
    });
    return { tripped: true, reason };
  }

  const bounceRate = bounced / denominator;
  if (denominator >= env.bounceMinDelivered && bounceRate > env.bounceRateThreshold) {
    const reason = `Bounce rate ${(bounceRate * 100).toFixed(2)}% exceeded ${(env.bounceRateThreshold * 100).toFixed(2)}% over ${denominator} messages`;
    await pauseCampaign(campaignId, reason);
    await sendAlert('Circuit breaker tripped: bounce rate', {
      campaignId: String(campaignId),
      bounceRate,
      denominator,
    });
    return { tripped: true, reason };
  }

  return { tripped: false };
}

// ---------------------------------------------------------------------------
// §7.6 Completion
// ---------------------------------------------------------------------------

/**
 * A campaign is `sent` when it has zero batches in `pending` or `claimed`.
 * Batches in `failed` are surfaced in the UI with their `lastError` rather
 * than holding the campaign open forever.
 */
export async function reconcileCompletedCampaigns(): Promise<number> {
  const c = await collections();
  const sending = await c.campaigns.find({ status: 'sending' }).toArray();
  let completed = 0;

  for (const campaign of sending) {
    const outstanding = await c.campaignBatches.countDocuments({
      campaignId: campaign._id,
      status: { $in: ['pending', 'claimed'] },
    });
    if (outstanding > 0) continue;

    const failedBatches = await c.campaignBatches.countDocuments({
      campaignId: campaign._id,
      status: 'failed',
    });

    await c.campaigns.updateOne(
      { _id: campaign._id, status: 'sending' },
      { $set: { status: 'sent', completedAt: new Date(), updatedAt: new Date() } },
    );
    completed += 1;
    log.info('campaign completed', {
      campaignId: String(campaign._id),
      sent: campaign.counts.sent,
      failed: campaign.counts.failed,
      failedBatches,
    });

    if (failedBatches > 0) {
      await sendAlert('Campaign completed with failed batches', {
        campaignId: String(campaign._id),
        failedBatches,
      });
    }
  }

  return completed;
}

// ---------------------------------------------------------------------------
// §7.2 The run loop
// ---------------------------------------------------------------------------

export interface SendCycleSummary {
  invocationId: string;
  batchesProcessed: number;
  sent: number;
  failed: number;
  skipped: number;
  duplicates: number;
  throttled: boolean;
  campaignsCompleted: number;
  durationMs: number;
}

export async function runSendCycle(invocationId: string, now = Date.now()): Promise<SendCycleSummary> {
  const deadline = now + env.cronRunBudgetMs;
  const summary: SendCycleSummary = {
    invocationId,
    batchesProcessed: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    duplicates: 0,
    throttled: false,
    campaignsCompleted: 0,
    durationMs: 0,
  };

  const started = Date.now();
  const touchedCampaigns = new Set<string>();

  while (Date.now() < deadline && summary.batchesProcessed < env.maxBatchesPerRun) {
    const campaignIds = await activeSendingCampaignIds();
    const batch = await claimBatch(campaignIds, invocationId);
    if (!batch) break;

    try {
      const result = await processBatch(batch);
      summary.batchesProcessed += 1;
      summary.sent += result.sent;
      summary.failed += result.failed;
      summary.skipped += result.skipped;
      summary.duplicates += result.duplicates;
      touchedCampaigns.add(String(batch.campaignId));

      const verdict = await checkCircuitBreaker(batch.campaignId);
      if (verdict.tripped) break;

      // §7.5: pace to stay under the account send rate. Function billing is on
      // active CPU, so waiting here costs almost nothing.
      const messages = result.sent + result.failed;
      if (messages > 0) {
        const pacingMs = Math.ceil((messages / env.sesMaxSendRate) * 1000);
        if (Date.now() + pacingMs < deadline) await sleep(pacingMs);
      }
    } catch (error) {
      if (error instanceof ThrottlingError) {
        // Release the batch and exit the run early. Do not hammer.
        await releaseBatch(batch._id, `Throttled: ${errorMessage(error)}`);
        summary.throttled = true;
        log.warn('ses throttled, releasing batch and ending run', {
          batchId: String(batch._id),
          invocationId,
        });
        break;
      }
      await failBatch(batch, error);
      summary.batchesProcessed += 1;
    }
  }

  summary.campaignsCompleted = await reconcileCompletedCampaigns();
  summary.durationMs = Date.now() - started;
  return summary;
}
