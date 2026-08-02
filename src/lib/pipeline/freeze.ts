import { ObjectId } from 'mongodb';
import {
  campaignBatchesCollection,
  campaignsCollection,
  listsCollection,
} from '@/lib/db/collections';
import { config } from '@/lib/config';
import { logger } from '@/lib/logging';
import { validateCampaignForSend } from '@/lib/presend';
import { renderCampaignForSend } from '@/lib/render/campaign';
import { resolveSegmentRecipients } from '@/lib/segments';
import { getTemplateHtml } from '@/lib/templates';
import type { CampaignBatchDoc, PresendCheck } from '@/lib/types';

export type FreezeResult =
  | { ok: true; recipients: number; batches: number }
  | {
      ok: false;
      reason: 'not_found' | 'wrong_status' | 'validation_failed' | 'no_recipients';
      checks?: PresendCheck[];
    };

/**
 * Freeze (spec §7.1).
 *
 * Re-evaluates the segment, excludes everyone who must not receive this send,
 * renders and stores the body, and materialises the batches. After freeze the
 * recipient set and the body are immutable — a template change mid-send must
 * not produce two different emails.
 *
 * Ordering here is load-bearing:
 *
 *  1. Validate first, so a failing campaign never changes state at all.
 *  2. Claim the campaign with an atomic status transition, so two concurrent
 *     freezes (an operator clicking send as the scheduler fires) cannot both
 *     proceed.
 *  3. Materialise batches *after* the claim. `claimBatch` only looks at
 *     campaigns in `sending`, and `reconcileCompletedCampaigns` ignores a
 *     `sending` campaign with no batches, so the half-frozen window is inert:
 *     nothing is sent and nothing is prematurely marked complete.
 *
 * If step 3 fails the campaign is rolled back to `draft`, so the operator sees
 * a campaign that did not send rather than one that half-sent.
 */
export async function freezeCampaign(
  campaignId: ObjectId,
  now: Date = new Date(),
): Promise<FreezeResult> {
  const campaigns = await campaignsCollection();
  const existing = await campaigns.findOne({ _id: campaignId });
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.status !== 'draft' && existing.status !== 'scheduled') {
    return { ok: false, reason: 'wrong_status' };
  }

  // 1. Hard gate, no override (§6.6).
  const validation = await validateCampaignForSend(campaignId, now);
  if (!validation.passed) {
    return { ok: false, reason: 'validation_failed', checks: validation.checks };
  }

  const list = await (await listsCollection()).findOne({ _id: existing.listId });
  if (!list) return { ok: false, reason: 'not_found' };

  // 2. Claim. Only one caller can win this transition.
  const claimed = await campaigns.findOneAndUpdate(
    { _id: campaignId, status: { $in: ['draft', 'scheduled'] } },
    { $set: { status: 'sending', frozenAt: now, startedAt: now } },
    { returnDocument: 'after' },
  );
  if (!claimed) return { ok: false, reason: 'wrong_status' };

  try {
    // 3. Re-derive the recipient set. The count shown in the UI is never
    //    trusted (§4.2) — this is the number that matters.
    const recipientIds = await resolveSegmentRecipients({
      listId: claimed.listId,
      query: claimed.segmentQuery,
      campaignId,
    });

    if (recipientIds.length === 0) {
      await campaigns.updateOne(
        { _id: campaignId },
        {
          $set: { status: 'draft', 'counts.recipients': 0 },
          $unset: { frozenAt: '', startedAt: '' },
        },
      );
      return { ok: false, reason: 'no_recipients' };
    }

    // The template is frozen alongside the body for the same reason the body
    // is: it carries merge fields and their fallbacks, and editing it mid-send
    // would change what SES substitutes into an email already rendered.
    const templateHtml = await getTemplateHtml(claimed.listId, 'campaign');
    const rendered = await renderCampaignForSend(claimed, list, templateHtml);

    const batchSize = Math.max(1, Math.min(config.batchSize(), 50));
    const batches: CampaignBatchDoc[] = [];
    for (let i = 0; i < recipientIds.length; i += batchSize) {
      batches.push({
        _id: new ObjectId(),
        campaignId,
        subscriberIds: recipientIds.slice(i, i + batchSize),
        status: 'pending',
        attempts: 0,
        createdAt: now,
      });
    }

    await (await campaignBatchesCollection()).insertMany(batches);

    await campaigns.updateOne(
      { _id: campaignId },
      {
        $set: {
          bodyHtml: rendered.html,
          bodyText: rendered.text,
          subject: rendered.subject,
          ...(templateHtml ? { templateSource: templateHtml } : {}),
          'counts.recipients': recipientIds.length,
        },
        ...(templateHtml ? {} : { $unset: { templateSource: '' } }),
      },
    );

    logger.info('campaign frozen', {
      campaignId: campaignId.toHexString(),
      recipients: recipientIds.length,
      batches: batches.length,
    });

    return { ok: true, recipients: recipientIds.length, batches: batches.length };
  } catch (err) {
    // Roll back so the operator sees a campaign that did not send, rather than
    // one stuck half-sent.
    await campaigns.updateOne(
      { _id: campaignId, status: 'sending' },
      { $set: { status: 'draft' }, $unset: { frozenAt: '', startedAt: '' } },
    );
    await (await campaignBatchesCollection()).deleteMany({ campaignId });
    logger.error('freeze failed, campaign rolled back to draft', {
      campaignId: campaignId.toHexString(),
      error: (err as Error).message,
    });
    throw err;
  }
}
