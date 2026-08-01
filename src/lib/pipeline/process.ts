import { ObjectId } from 'mongodb';
import {
  campaignsCollection,
  listsCollection,
  sentLogCollection,
  subscribersCollection,
  suppressionsCollection,
} from '@/lib/db/collections';
import { config } from '@/lib/config';
import { logger } from '@/lib/logging';
import { completeBatch, failBatch, releaseBatch } from '@/lib/pipeline/claim';
import { buildRecipientHeaders, buildReplacements } from '@/lib/render/campaign';
import { getSesAdapter } from '@/lib/ses/registry';
import { isThrottlingError } from '@/lib/ses/types';
import type { BulkDestination } from '@/lib/ses/types';
import type { CampaignBatchDoc, SubscriberDoc } from '@/lib/types';

const MONGO_DUPLICATE_KEY = 11000;

export interface ProcessBatchResult {
  sent: number;
  failed: number;
  skipped: number;
  throttled: boolean;
}

/** Pacing seam, so rate-limit behaviour is testable without real waiting. */
export type Sleeper = (ms: number) => Promise<void>;
let sleeper: Sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function setSleeper(next: Sleeper): void {
  sleeper = next;
}
export function resetSleeper(): void {
  sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Processing a batch (spec §7.4).
 *
 * The re-check in step 2 is the point of this function, not an optimisation:
 * the freeze may have happened an hour ago and somebody may have unsubscribed,
 * bounced, or complained since. Sending to them anyway is precisely the kind of
 * mistake that is not recoverable.
 *
 * The `sent_log` unique index is the hard guarantee. A duplicate-key error on
 * insert means "already sent" and is swallowed silently — it is a database-level
 * invariant that survives bugs in the claim logic, not an error condition.
 */
export async function processBatch(
  batch: CampaignBatchDoc,
  now: Date = new Date(),
): Promise<ProcessBatchResult> {
  const result: ProcessBatchResult = { sent: 0, failed: 0, skipped: 0, throttled: false };

  const campaign = await (await campaignsCollection()).findOne({ _id: batch.campaignId });
  if (!campaign) {
    await failBatch(batch._id, 'Campaign no longer exists', now);
    return result;
  }
  const list = await (await listsCollection()).findOne({ _id: campaign.listId });
  if (!list) {
    await failBatch(batch._id, 'Sending list no longer exists', now);
    return result;
  }
  if (!campaign.bodyHtml || !campaign.bodyText) {
    // Freeze stores these; their absence means the batch outran its freeze.
    await failBatch(batch._id, 'Campaign body was not frozen', now);
    return result;
  }

  // 1. Load the subscriber documents.
  const subscribers = await (await subscribersCollection())
    .find({ _id: { $in: batch.subscriberIds } })
    .toArray();

  // 2. Re-check suppression and status. Not redundant — this is the point.
  const suppressed = new Set(
    (
      await (await suppressionsCollection())
        .find(
          { email: { $in: subscribers.map((s) => s.email) } },
          { projection: { email: 1 } },
        )
        .toArray()
    ).map((doc) => doc.email),
  );

  const alreadySent = new Set(
    (
      await (await sentLogCollection())
        .find(
          { campaignId: batch.campaignId, subscriberId: { $in: batch.subscriberIds } },
          { projection: { subscriberId: 1 } },
        )
        .toArray()
    ).map((doc) => doc.subscriberId.toHexString()),
  );

  const eligible: SubscriberDoc[] = [];
  for (const subscriber of subscribers) {
    if (subscriber.status !== 'confirmed') continue;
    if (suppressed.has(subscriber.email)) continue;
    if (alreadySent.has(subscriber._id.toHexString())) continue;
    eligible.push(subscriber);
  }
  result.skipped = batch.subscriberIds.length - eligible.length;

  if (eligible.length === 0) {
    await completeBatch(batch._id, now);
    return result;
  }

  // 3. Per-recipient replacement data, including the signed unsubscribe token.
  const destinations: BulkDestination[] = eligible.map((subscriber) => ({
    email: subscriber.email,
    replacements: buildReplacements(campaign, list, subscriber),
    headers: buildRecipientHeaders(campaign, list, subscriber),
  }));

  const startedAt = Date.now();
  let results;
  try {
    // 4. One SendBulkEmail call for up to 50 destinations.
    const ses = await getSesAdapter();
    results = await ses.sendBulk({
      fromName: list.fromName,
      fromEmail: list.fromEmail,
      replyTo: list.replyTo,
      configurationSet: list.sesConfigurationSet,
      content: {
        subject: campaign.subject,
        html: campaign.bodyHtml,
        text: campaign.bodyText,
      },
      destinations,
    });
  } catch (err) {
    if (isThrottlingError(err)) {
      // §7.5: release the batch and exit the run early. Do not hammer.
      await releaseBatch(batch._id, 'SES throttling', now);
      result.throttled = true;
      logger.warn('SES throttled; released batch and backing off', {
        batchId: batch._id.toHexString(),
      });
      return result;
    }

    const message = err instanceof Error ? err.message : String(err);
    if (batch.attempts >= config.maxBatchAttempts()) {
      await failBatch(batch._id, message, now);
    } else {
      // Hand it back for the next tick rather than burning the whole lease.
      await releaseBatch(batch._id, message, now);
    }
    logger.error('batch send failed', {
      batchId: batch._id.toHexString(),
      attempts: batch.attempts,
      error: message,
    });
    return result;
  }

  // 5. Record each per-destination outcome. One bad address must never fail the
  //    whole batch.
  const sentLog = await sentLogCollection();
  const byEmail = new Map(eligible.map((s) => [s.email, s]));

  for (const entry of results) {
    const subscriber = byEmail.get(entry.email);
    if (!subscriber) continue;

    if (entry.status !== 'success') {
      result.failed += 1;
      logger.warn('per-recipient send failure', {
        campaignId: campaign._id.toHexString(),
        domain: subscriber.emailDomain,
        error: entry.error,
      });
      continue;
    }

    try {
      await sentLog.insertOne({
        _id: new ObjectId(),
        campaignId: batch.campaignId,
        subscriberId: subscriber._id,
        ...(entry.messageId ? { sesMessageId: entry.messageId } : {}),
        sentAt: now,
      });
      result.sent += 1;
    } catch (err) {
      if ((err as { code?: number }).code === MONGO_DUPLICATE_KEY) {
        // Already sent. This is the invariant doing its job; skip silently.
        result.skipped += 1;
        continue;
      }
      throw err;
    }
  }

  await (await campaignsCollection()).updateOne(
    { _id: batch.campaignId },
    { $inc: { 'counts.sent': result.sent, 'counts.failed': result.failed } },
  );

  // 6. Done with this batch.
  await completeBatch(batch._id, now);

  // §7.5: pace to stay under the configured SES send rate. Billing is on active
  // CPU, not I/O wait, so waiting here costs essentially nothing.
  const rate = config.sesMaxSendRate();
  if (rate > 0 && destinations.length > 0) {
    const minimumMs = (destinations.length / rate) * 1000;
    const remaining = minimumMs - (Date.now() - startedAt);
    if (remaining > 0) await sleeper(remaining);
  }

  return result;
}
