import { ObjectId } from 'mongodb';
import {
  campaignVersionsCollection,
  campaignsCollection,
  listsCollection,
  subscribersCollection,
} from '@/lib/db/collections';
import { config } from '@/lib/config';
import { logger } from '@/lib/logging';
import { renderCampaignPreview, unsubscribeUrlFor } from '@/lib/render/campaign';
import { validateEditorDoc } from '@/lib/render/doc';
import { MAX_TEMPLATE_LENGTH } from '@/lib/render/template';
import { getSesAdapter } from '@/lib/ses/registry';
import { getTemplateHtml } from '@/lib/templates';
import type {
  BodyMode,
  CampaignDoc,
  CampaignVersionDoc,
  EditorDoc,
  RecipientContext,
  SegmentQuery,
  SubscriberDoc,
} from '@/lib/types';

/**
 * Campaign authoring (spec §6).
 *
 * Only `draft` and `scheduled` campaigns are editable. Once a campaign is
 * frozen its body and recipient set are immutable (§7.1) — a template change
 * mid-send must not produce two different emails, so edits are refused rather
 * than merged.
 */

/** §6.1 asks for at least the last 20 saves; keeping more costs almost nothing. */
const VERSION_RETENTION = 50;

const EMPTY_DOC: EditorDoc = { type: 'doc', content: [{ type: 'paragraph' }] };

function emptyCounts() {
  return {
    recipients: 0,
    sent: 0,
    failed: 0,
    bounced: 0,
    complained: 0,
    unsubscribed: 0,
    delivered: 0,
    opened: 0,
    clicked: 0,
  };
}

export async function createCampaign(input: {
  listId: ObjectId;
  subject?: string;
  now?: Date;
}): Promise<CampaignDoc> {
  const now = input.now ?? new Date();
  const doc: CampaignDoc = {
    _id: new ObjectId(),
    listId: input.listId,
    subject: input.subject ?? '',
    preheader: '',
    bodySource: EMPTY_DOC,
    bodyMode: 'rich',
    status: 'draft',
    segmentQuery: {},
    trackOpens: false,
    trackClicks: false,
    counts: emptyCounts(),
    createdAt: now,
    updatedAt: now,
  };
  await (await campaignsCollection()).insertOne(doc);
  return doc;
}

export async function updateCampaignDraft(input: {
  campaignId: ObjectId;
  subject?: string;
  preheader?: string;
  bodySource?: EditorDoc;
  bodyMode?: BodyMode;
  bodyHtmlSource?: string;
  segmentQuery?: SegmentQuery;
  trackOpens?: boolean;
  trackClicks?: boolean;
  now?: Date;
}): Promise<
  | { ok: true; campaign: CampaignDoc }
  | { ok: false; reason: 'not_found' | 'immutable' | 'invalid_body'; errors?: string[] }
> {
  const now = input.now ?? new Date();
  const campaigns = await campaignsCollection();
  const existing = await campaigns.findOne({ _id: input.campaignId });
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.status !== 'draft' && existing.status !== 'scheduled') {
    return { ok: false, reason: 'immutable' };
  }

  if (input.bodySource) {
    // An unvalidated document is an HTML-injection vector and produces nodes the
    // email renderer has no template for.
    const validation = validateEditorDoc(input.bodySource);
    if (!validation.ok) return { ok: false, reason: 'invalid_body', errors: validation.errors };
  }

  if (input.bodyHtmlSource !== undefined && input.bodyHtmlSource.length > MAX_TEMPLATE_LENGTH) {
    // Pasted HTML is not held to the closed node set — the sanitizer is what
    // makes it safe, at render time — but it is held to a size, because this
    // document is re-rendered on every keystroke of the live preview.
    return {
      ok: false,
      reason: 'invalid_body',
      errors: [
        `body HTML must be ${MAX_TEMPLATE_LENGTH.toLocaleString('en-GB')} characters or fewer`,
      ],
    };
  }

  // Snapshot the *previous* state before overwriting it, so the history is a
  // list of states the writer can actually return to.
  if (
    input.bodySource ||
    input.bodyHtmlSource !== undefined ||
    input.bodyMode !== undefined ||
    input.subject !== undefined ||
    input.preheader !== undefined
  ) {
    const version: CampaignVersionDoc = {
      _id: new ObjectId(),
      campaignId: existing._id,
      subject: existing.subject,
      preheader: existing.preheader,
      bodySource: existing.bodySource,
      ...(existing.bodyMode ? { bodyMode: existing.bodyMode } : {}),
      ...(existing.bodyHtmlSource !== undefined
        ? { bodyHtmlSource: existing.bodyHtmlSource }
        : {}),
      createdAt: now,
    };
    const versions = await campaignVersionsCollection();
    await versions.insertOne(version);

    const stale = await versions
      .find({ campaignId: existing._id }, { projection: { _id: 1 }, sort: { createdAt: -1 } })
      .skip(VERSION_RETENTION)
      .toArray();
    if (stale.length > 0) {
      await versions.deleteMany({ _id: { $in: stale.map((doc) => doc._id) } });
    }
  }

  const update: Partial<CampaignDoc> = { updatedAt: now };
  if (input.subject !== undefined) update.subject = input.subject;
  if (input.preheader !== undefined) update.preheader = input.preheader;
  if (input.bodySource !== undefined) update.bodySource = input.bodySource;
  if (input.bodyMode !== undefined) update.bodyMode = input.bodyMode;
  if (input.bodyHtmlSource !== undefined) update.bodyHtmlSource = input.bodyHtmlSource;
  if (input.segmentQuery !== undefined) update.segmentQuery = input.segmentQuery;
  if (input.trackOpens !== undefined) update.trackOpens = input.trackOpens;
  if (input.trackClicks !== undefined) update.trackClicks = input.trackClicks;

  await campaigns.updateOne({ _id: input.campaignId }, { $set: update });
  const campaign = (await campaigns.findOne({ _id: input.campaignId }))!;
  return { ok: true, campaign };
}

export async function listCampaignVersions(
  campaignId: ObjectId,
  limit = 20,
): Promise<CampaignVersionDoc[]> {
  return (await campaignVersionsCollection())
    .find({ campaignId })
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, VERSION_RETENTION))
    .toArray();
}

export async function restoreCampaignVersion(
  campaignId: ObjectId,
  versionId: ObjectId,
  now: Date = new Date(),
): Promise<boolean> {
  const version = await (await campaignVersionsCollection()).findOne({
    _id: versionId,
    campaignId,
  });
  if (!version) return false;

  const restored = await updateCampaignDraft({
    campaignId,
    subject: version.subject,
    preheader: version.preheader,
    bodySource: version.bodySource,
    // A version written before HTML mode existed restores as `rich`, which is
    // what it was; restoring the mode is what makes the snapshot a state the
    // writer can actually return to.
    bodyMode: version.bodyMode ?? 'rich',
    bodyHtmlSource: version.bodyHtmlSource ?? '',
    now,
  });
  return restored.ok;
}

export async function scheduleCampaign(
  campaignId: ObjectId,
  when: Date,
  now: Date = new Date(),
): Promise<{ ok: boolean; reason?: string }> {
  if (Number.isNaN(when.getTime())) return { ok: false, reason: 'invalid_date' };
  if (when <= now) return { ok: false, reason: 'in_the_past' };

  const result = await (await campaignsCollection()).updateOne(
    { _id: campaignId, status: { $in: ['draft', 'scheduled'] } },
    { $set: { status: 'scheduled', scheduledFor: when, updatedAt: now } },
  );
  return result.matchedCount > 0 ? { ok: true } : { ok: false, reason: 'wrong_status' };
}

export async function unscheduleCampaign(
  campaignId: ObjectId,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await (await campaignsCollection()).updateOne(
    { _id: campaignId, status: 'scheduled' },
    { $set: { status: 'draft', updatedAt: now }, $unset: { scheduledFor: '' } },
  );
  return result.modifiedCount > 0;
}

/**
 * Pause (§7.7). Removing the campaign from the claim query is all it takes:
 * sending stops within one minute with no in-flight work lost.
 */
export async function pauseCampaign(
  campaignId: ObjectId,
  reason?: string,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await (await campaignsCollection()).updateOne(
    { _id: campaignId, status: 'sending' },
    {
      $set: {
        status: 'paused',
        pausedAt: now,
        pausedReason: reason ?? 'Paused by an operator',
        updatedAt: now,
      },
    },
  );
  if (result.modifiedCount > 0) {
    logger.warn('campaign paused', { campaignId: campaignId.toHexString(), reason });
  }
  return result.modifiedCount > 0;
}

/** Resuming is safe because `sent_log` means already-sent batches cannot repeat. */
export async function resumeCampaign(
  campaignId: ObjectId,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await (await campaignsCollection()).updateOne(
    { _id: campaignId, status: 'paused' },
    {
      $set: { status: 'sending', updatedAt: now },
      $unset: { pausedAt: '', pausedReason: '' },
    },
  );
  return result.modifiedCount > 0;
}

/**
 * Test sends (§6.5).
 *
 * These exercise the real render path — same code, same merge, same headers —
 * because a test that does not is not a test. They are tagged, and they never
 * touch campaign counts, `sent_log`, or batches.
 */
export async function sendTestEmail(input: {
  campaignId: ObjectId;
  to: string[];
  previewSubscriberId?: ObjectId;
  now?: Date;
}): Promise<{ ok: true; sent: number } | { ok: false; reason: string }> {
  if (input.to.length === 0) return { ok: false, reason: 'no_recipients' };
  if (input.to.length > 10) return { ok: false, reason: 'too_many_recipients' };

  const campaign = await (await campaignsCollection()).findOne({ _id: input.campaignId });
  if (!campaign) return { ok: false, reason: 'not_found' };
  const list = await (await listsCollection()).findOne({ _id: campaign.listId });
  if (!list) return { ok: false, reason: 'list_not_found' };

  const subscribers = await subscribersCollection();
  const sample: SubscriberDoc | null = input.previewSubscriberId
    ? await subscribers.findOne({ _id: input.previewSubscriberId })
    : await subscribers.findOne({ listId: campaign.listId, status: 'confirmed' });

  // A synthetic id keeps the unsubscribe token well-formed without pointing at
  // a real person, so clicking it in a test cannot unsubscribe a subscriber.
  const subscriberId = sample?._id ?? new ObjectId();
  const { url, token } = unsubscribeUrlFor(
    campaign._id.toHexString(),
    subscriberId.toHexString(),
  );

  const ses = await getSesAdapter();
  const templateHtml = await getTemplateHtml(campaign.listId);
  let sent = 0;

  for (const address of input.to) {
    const ctx: RecipientContext = {
      subscriberId: subscriberId.toHexString(),
      email: address,
      attributes: sample?.attributes ?? {},
      unsubscribeUrl: url,
      trackingToken: token,
      openPixelUrl: campaign.trackOpens
        ? `${config.appBaseUrl()}/api/t/o/${token}`
        : undefined,
    };

    const rendered = await renderCampaignPreview(campaign, list, ctx, templateHtml);

    try {
      await ses.sendSimple({
        fromName: list.fromName,
        fromEmail: list.fromEmail,
        replyTo: list.replyTo,
        to: address,
        configurationSet: list.sesConfigurationSet,
        content: { ...rendered, subject: `[TEST] ${rendered.subject}` },
        headers: {
          'X-SM-Test-Send': 'true',
          'List-Unsubscribe': `<${url}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });
      sent += 1;
    } catch (err) {
      logger.error('test send failed', {
        campaignId: campaign._id.toHexString(),
        error: (err as Error).message,
      });
    }
  }

  return sent > 0 ? { ok: true, sent } : { ok: false, reason: 'send_failed' };
}
