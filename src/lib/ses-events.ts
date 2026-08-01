import { ObjectId } from 'mongodb';
import { collections } from './db';
import { log } from './logger';
import { normalizeEmail } from './email-address';
import { suppress } from './suppressions';
import { sendAlert } from './alerts';
import type { EventType } from './types';

/**
 * SES event handling (§8.2).
 *
 * SNS delivers at least once, so every handler here is idempotent. The
 * suppression writes in particular must be safe to replay — they are, because
 * `suppressions` is unique on email and re-suppressing keeps the original
 * record.
 */

interface SesMailObject {
  messageId?: string;
  destination?: string[];
  tags?: Record<string, string[]>;
  timestamp?: string;
}

export interface SesNotification {
  eventType?: string;
  notificationType?: string;
  mail?: SesMailObject;
  bounce?: {
    bounceType?: string;
    bounceSubType?: string;
    bouncedRecipients?: { emailAddress?: string; diagnosticCode?: string; status?: string }[];
    timestamp?: string;
  };
  complaint?: {
    complainedRecipients?: { emailAddress?: string }[];
    complaintFeedbackType?: string;
    timestamp?: string;
  };
  delivery?: { recipients?: string[]; timestamp?: string };
  reject?: { reason?: string };
  open?: { timestamp?: string };
  click?: { link?: string; timestamp?: string };
}

/** How many distinct campaigns must soft-bounce before an address is suppressed. */
export const TRANSIENT_BOUNCE_THRESHOLD = 3;

function firstTag(mail: SesMailObject | undefined, name: string): string | null {
  const values = mail?.tags?.[name];
  const value = values?.[0];
  return value && value !== 'none' ? value : null;
}

function objectIdOrNull(value: string | null): ObjectId | null {
  return value && ObjectId.isValid(value) ? new ObjectId(value) : null;
}

export interface HandleResult {
  type: string;
  handled: boolean;
  detail?: string;
}

export async function handleSesNotification(notification: SesNotification): Promise<HandleResult> {
  const type = notification.eventType ?? notification.notificationType ?? 'Unknown';
  const mail = notification.mail;
  const campaignId = objectIdOrNull(firstTag(mail, 'campaign_id'));
  const listId = objectIdOrNull(firstTag(mail, 'list_id'));
  const sendType = firstTag(mail, 'type');

  switch (type) {
    case 'Bounce':
      return handleBounce(notification, campaignId, listId, sendType);
    case 'Complaint':
      return handleComplaint(notification, campaignId, listId);
    case 'Delivery':
      return handleDelivery(notification, campaignId, listId);
    case 'Reject':
      await sendAlert('SES rejected a message', {
        reason: notification.reject?.reason ?? 'unknown',
        campaignId: campaignId ? String(campaignId) : null,
      });
      await recordEvent('reject', campaignId, listId, null, { detail: notification.reject?.reason ?? null });
      // A Reject indicates a configuration problem, not a recipient problem (§8.2).
      return { type, handled: true, detail: notification.reject?.reason };
    case 'Open':
      return handleEngagement('open', notification, campaignId, listId);
    case 'Click':
      return handleEngagement('click', notification, campaignId, listId, notification.click?.link ?? null);
    case 'Send':
    case 'Rendering Failure':
    case 'DeliveryDelay':
    case 'Subscription':
      return { type, handled: true, detail: 'no action' };
    default:
      log.warn('unhandled SES notification type', { type });
      return { type, handled: false };
  }
}

async function handleBounce(
  notification: SesNotification,
  campaignId: ObjectId | null,
  listId: ObjectId | null,
  sendType: string | null,
): Promise<HandleResult> {
  const c = await collections();
  const bounceType = notification.bounce?.bounceType ?? 'Undetermined';
  const recipients = notification.bounce?.bouncedRecipients ?? [];
  let suppressedCount = 0;

  for (const recipient of recipients) {
    if (!recipient.emailAddress) continue;
    const email = normalizeEmail(recipient.emailAddress);
    const diagnostic = recipient.diagnosticCode ?? recipient.status ?? null;

    if (bounceType === 'Permanent') {
      await suppress({ email, reason: 'hard_bounce', sourceCampaignId: campaignId, detail: diagnostic });
      suppressedCount += 1;
      await c.subscribers.updateMany(
        { email, status: { $nin: ['unsubscribed', 'complained'] } },
        { $set: { status: 'bounced', bouncedAt: new Date(), updatedAt: new Date() } },
      );
    } else if (bounceType === 'Transient') {
      // Recorded, but suppressed only after repeated failures across distinct
      // campaigns (§8.2) — a full mailbox on one send is not a dead address.
      if (campaignId) {
        await c.subscribers.updateMany(
          { email },
          { $addToSet: { transientBounceCampaignIds: campaignId }, $set: { updatedAt: new Date() } },
        );
      }
      const repeat = await c.subscribers.findOne({ email }, { projection: { transientBounceCampaignIds: 1 } });
      const distinct = repeat?.transientBounceCampaignIds?.length ?? 0;
      if (distinct >= TRANSIENT_BOUNCE_THRESHOLD) {
        await suppress({
          email,
          reason: 'hard_bounce',
          sourceCampaignId: campaignId,
          detail: `Transient bounces across ${distinct} campaigns. Last: ${diagnostic ?? 'no diagnostic'}`,
        });
        suppressedCount += 1;
        await c.subscribers.updateMany(
          { email, status: { $nin: ['unsubscribed', 'complained'] } },
          { $set: { status: 'bounced', bouncedAt: new Date(), updatedAt: new Date() } },
        );
      }
    }

    const subscriber = await c.subscribers.findOne({ email }, { projection: { _id: 1 } });
    await recordEvent('bounce', campaignId, listId, subscriber?._id ?? null, {
      detail: `${bounceType}: ${diagnostic ?? 'no diagnostic'}`,
      // Test sends are excluded from all campaign counts (§6.5).
      countOnCampaign: sendType !== 'test',
    });
  }

  return { type: 'Bounce', handled: true, detail: `${bounceType}, ${suppressedCount} suppressed` };
}

async function handleComplaint(
  notification: SesNotification,
  campaignId: ObjectId | null,
  listId: ObjectId | null,
): Promise<HandleResult> {
  const c = await collections();
  const recipients = notification.complaint?.complainedRecipients ?? [];

  for (const recipient of recipients) {
    if (!recipient.emailAddress) continue;
    const email = normalizeEmail(recipient.emailAddress);

    // Always permanent, no threshold (§8.2).
    await suppress({
      email,
      reason: 'complaint',
      sourceCampaignId: campaignId,
      detail: notification.complaint?.complaintFeedbackType ?? null,
    });

    await c.subscribers.updateMany(
      { email },
      {
        $set: {
          status: 'complained',
          complainedAt: new Date(),
          unsubscribedAt: new Date(),
          unsubscribeSource: 'complaint',
          updatedAt: new Date(),
        },
      },
    );

    const subscriber = await c.subscribers.findOne({ email }, { projection: { _id: 1 } });
    await recordEvent('complaint', campaignId, listId, subscriber?._id ?? null, {
      detail: notification.complaint?.complaintFeedbackType ?? null,
    });
  }

  return { type: 'Complaint', handled: true, detail: `${recipients.length} complaint(s)` };
}

async function handleDelivery(
  notification: SesNotification,
  campaignId: ObjectId | null,
  listId: ObjectId | null,
): Promise<HandleResult> {
  const c = await collections();
  const recipients = notification.delivery?.recipients ?? [];
  for (const address of recipients) {
    const email = normalizeEmail(address);
    const subscriber = await c.subscribers.findOne({ email }, { projection: { _id: 1 } });
    await recordEvent('delivered', campaignId, listId, subscriber?._id ?? null);
  }
  return { type: 'Delivery', handled: true, detail: `${recipients.length} delivered` };
}

async function handleEngagement(
  type: 'open' | 'click',
  notification: SesNotification,
  campaignId: ObjectId | null,
  listId: ObjectId | null,
  url: string | null = null,
): Promise<HandleResult> {
  const c = await collections();
  const address = notification.mail?.destination?.[0];
  const subscriber = address
    ? await c.subscribers.findOne({ email: normalizeEmail(address) }, { projection: { _id: 1 } })
    : null;
  await recordEvent(type, campaignId, listId, subscriber?._id ?? null, { url });
  return { type, handled: true };
}

/**
 * Writes an event and keeps the denormalized campaign counters in step.
 *
 * Counters are incremented on the first event of a given type per subscriber
 * per campaign only. SNS at-least-once delivery plus Apple Mail Privacy
 * Protection would otherwise inflate every number on the dashboard.
 */
export async function recordEvent(
  type: EventType,
  campaignId: ObjectId | null,
  listId: ObjectId | null,
  subscriberId: ObjectId | null,
  options: { url?: string | null; detail?: string | null; countOnCampaign?: boolean } = {},
): Promise<void> {
  const c = await collections();
  const now = new Date();

  let isFirst = true;
  if (campaignId && subscriberId) {
    const existing = await c.events.findOne(
      { campaignId, subscriberId, type },
      { projection: { _id: 1 } },
    );
    isFirst = existing === null;
  }

  await c.events.insertOne({
    campaignId,
    listId,
    subscriberId,
    type,
    ts: now,
    url: options.url ?? null,
    detail: options.detail ?? null,
  } as never);

  if (!campaignId || options.countOnCampaign === false || !isFirst) return;

  const field = COUNTER_FIELD[type];
  if (!field) return;
  await c.campaigns.updateOne({ _id: campaignId }, { $inc: { [field]: 1 } });
}

const COUNTER_FIELD: Partial<Record<EventType, string>> = {
  delivered: 'counts.delivered',
  bounce: 'counts.bounced',
  complaint: 'counts.complained',
  open: 'counts.opened',
  click: 'counts.clicked',
};
