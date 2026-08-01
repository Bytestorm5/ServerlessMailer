import { ObjectId } from 'mongodb';
import {
  campaignsCollection,
  eventsCollection,
  sentLogCollection,
} from '@/lib/db/collections';
import { logger } from '@/lib/logging';
import {
  markBounced,
  markComplained,
  recordTransientBounce,
} from '@/lib/subscribers';
import { addSuppression } from '@/lib/suppressions';
import type { EventType } from '@/lib/types';

/**
 * SES event handling (spec §8.2).
 *
 * SNS delivers **at least once**, so every handler here is idempotent. Idempotency
 * is enforced at the database level by a unique sparse index on
 * `events.dedupeKey`: a replayed notification loses the race on insert and is
 * skipped, rather than being counted twice. That matters because the complaint
 * count feeds the circuit breaker — double-counting complaints would pause
 * healthy campaigns, and under-counting would fail to pause a bad one.
 *
 * Signature verification happens in the route before this is ever called (§8.1).
 */

const MONGO_DUPLICATE_KEY = 11000;

export type SubscribeUrlFetcher = (url: string) => Promise<void>;

const defaultFetcher: SubscribeUrlFetcher = async (url) => {
  await fetch(url, { method: 'GET' });
};

let subscribeUrlFetcher: SubscribeUrlFetcher = defaultFetcher;

export function setSubscribeUrlFetcher(fetcher: SubscribeUrlFetcher): void {
  subscribeUrlFetcher = fetcher;
}

export function resetSubscribeUrlFetcher(): void {
  subscribeUrlFetcher = defaultFetcher;
}

/** The same host check the signing-certificate URL gets, for the same reason. */
function isAwsUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return host === 'amazonaws.com' || host.endsWith('.amazonaws.com');
}

interface SesRecipient {
  emailAddress?: string;
  diagnosticCode?: string;
}

interface SesEventPayload {
  eventType?: string;
  notificationType?: string;
  mail?: { messageId?: string; destination?: string[] };
  bounce?: {
    bounceType?: string;
    bouncedRecipients?: SesRecipient[];
  };
  complaint?: {
    complainedRecipients?: SesRecipient[];
    complaintFeedbackType?: string;
  };
  delivery?: { recipients?: string[] };
  reject?: { reason?: string };
}

interface Attribution {
  campaignId?: ObjectId;
  subscriberId?: ObjectId;
}

/**
 * Maps an SES message id back to the campaign and recipient it was sent to,
 * using `sent_log` — the same record that guarantees no double-send.
 */
async function attribute(messageId: string | undefined): Promise<Attribution> {
  if (!messageId) return {};
  const entry = await (await sentLogCollection()).findOne({ sesMessageId: messageId });
  if (!entry) return {};
  return { campaignId: entry.campaignId, subscriberId: entry.subscriberId };
}

/**
 * Records the event, returning false if this exact event was already recorded.
 * The unique index on `dedupeKey` is what makes replay safe.
 */
async function recordEvent(input: {
  dedupeKey: string;
  type: EventType;
  attribution: Attribution;
  detail?: string;
  url?: string;
}): Promise<boolean> {
  try {
    await (await eventsCollection()).insertOne({
      _id: new ObjectId(),
      type: input.type,
      ts: new Date(),
      dedupeKey: input.dedupeKey,
      ...(input.attribution.campaignId ? { campaignId: input.attribution.campaignId } : {}),
      ...(input.attribution.subscriberId
        ? { subscriberId: input.attribution.subscriberId }
        : {}),
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.url ? { url: input.url } : {}),
    });
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === MONGO_DUPLICATE_KEY) return false;
    throw err;
  }
}

async function bumpCount(
  campaignId: ObjectId | undefined,
  field: 'bounced' | 'complained' | 'delivered',
): Promise<void> {
  if (!campaignId) return;
  await (await campaignsCollection()).updateOne(
    { _id: campaignId },
    { $inc: { [`counts.${field}`]: 1 } },
  );
}

function recipientsOf(payload: SesEventPayload, kind: 'bounce' | 'complaint'): SesRecipient[] {
  const list =
    kind === 'bounce'
      ? payload.bounce?.bouncedRecipients
      : payload.complaint?.complainedRecipients;
  if (Array.isArray(list) && list.length > 0) return list;
  // Fall back to the envelope destination so an event is never dropped for
  // want of a recipient list.
  return (payload.mail?.destination ?? []).map((emailAddress) => ({ emailAddress }));
}

export async function handleSnsNotification(
  raw: unknown,
): Promise<{ handled: true; action: string } | { handled: false; reason: string }> {
  if (!raw || typeof raw !== 'object') return { handled: false, reason: 'not_an_object' };
  const envelope = raw as Record<string, unknown>;
  const type = typeof envelope.Type === 'string' ? envelope.Type : '';

  if (type === 'SubscriptionConfirmation') {
    const subscribeUrl =
      typeof envelope.SubscribeURL === 'string' ? envelope.SubscribeURL : '';
    // Fetching an arbitrary attacker-supplied URL from inside the deployment is
    // a server-side request forgery primitive, so the host is checked first.
    if (!isAwsUrl(subscribeUrl)) {
      logger.warn('refusing to fetch a non-AWS SubscribeURL');
      return { handled: false, reason: 'bad_subscribe_url' };
    }
    await subscribeUrlFetcher(subscribeUrl);
    logger.info('SNS subscription confirmed');
    return { handled: true, action: 'subscription_confirmed' };
  }

  if (type === 'UnsubscribeConfirmation') {
    logger.warn('SNS topic unsubscribed — bounce and complaint feedback has stopped');
    return { handled: true, action: 'topic_unsubscribed' };
  }

  if (type !== 'Notification') return { handled: false, reason: 'unsupported_type' };

  let payload: SesEventPayload;
  try {
    payload = JSON.parse(String(envelope.Message)) as SesEventPayload;
  } catch {
    return { handled: false, reason: 'unparseable_message' };
  }
  if (!payload || typeof payload !== 'object') {
    return { handled: false, reason: 'unparseable_message' };
  }

  const snsMessageId =
    typeof envelope.MessageId === 'string' ? envelope.MessageId : undefined;
  const eventType = payload.eventType ?? payload.notificationType ?? '';
  const attribution = await attribute(payload.mail?.messageId);
  // Prefer the SNS MessageId: AWS reuses it across redeliveries of the same
  // event, which is exactly the dedupe semantics needed here.
  const baseKey = snsMessageId ?? `${payload.mail?.messageId ?? 'unknown'}:${eventType}`;

  switch (eventType) {
    case 'Bounce': {
      const permanent = payload.bounce?.bounceType === 'Permanent';
      const recipients = recipientsOf(payload, 'bounce');

      for (const recipient of recipients) {
        const email = recipient.emailAddress;
        if (!email) continue;

        const fresh = await recordEvent({
          dedupeKey: `${baseKey}:bounce:${email}`,
          type: 'bounce',
          attribution,
          detail: recipient.diagnosticCode,
        });
        if (!fresh) continue;

        if (permanent) {
          await addSuppression({
            email,
            reason: 'hard_bounce',
            detail: recipient.diagnosticCode,
            sourceCampaignId: attribution.campaignId,
          });
          await markBounced({
            email,
            campaignId: attribution.campaignId,
            detail: recipient.diagnosticCode,
          });
          await bumpCount(attribution.campaignId, 'bounced');
        } else {
          // Transient: record it, and suppress only once the same address has
          // failed across enough distinct campaigns.
          await recordTransientBounce({
            email,
            campaignId: attribution.campaignId,
            detail: recipient.diagnosticCode,
          });
        }
      }

      return { handled: true, action: permanent ? 'bounce_permanent' : 'bounce_transient' };
    }

    case 'Complaint': {
      for (const recipient of recipientsOf(payload, 'complaint')) {
        const email = recipient.emailAddress;
        if (!email) continue;

        const fresh = await recordEvent({
          dedupeKey: `${baseKey}:complaint:${email}`,
          type: 'complaint',
          attribution,
          detail: payload.complaint?.complaintFeedbackType,
        });
        if (!fresh) continue;

        // Always permanent, no threshold (§8.2).
        await addSuppression({
          email,
          reason: 'complaint',
          detail: payload.complaint?.complaintFeedbackType,
          sourceCampaignId: attribution.campaignId,
        });
        await markComplained({ email, campaignId: attribution.campaignId });
        await bumpCount(attribution.campaignId, 'complained');
      }
      return { handled: true, action: 'complaint' };
    }

    case 'Delivery': {
      const recipients = payload.delivery?.recipients ?? payload.mail?.destination ?? [];
      for (const email of recipients) {
        const fresh = await recordEvent({
          dedupeKey: `${baseKey}:delivery:${email}`,
          type: 'delivered',
          attribution,
        });
        if (fresh) await bumpCount(attribution.campaignId, 'delivered');
      }
      return { handled: true, action: 'delivery' };
    }

    case 'Reject': {
      await recordEvent({
        dedupeKey: `${baseKey}:reject`,
        type: 'reject',
        attribution,
        detail: payload.reject?.reason,
      });
      // Loud: a reject indicates a configuration problem, not a recipient
      // problem, so the recipient is deliberately left untouched.
      logger.error('SES rejected a message — check configuration', {
        reason: payload.reject?.reason,
        campaignId: attribution.campaignId?.toHexString(),
      });
      return { handled: true, action: 'reject' };
    }

    default:
      return { handled: false, reason: `unhandled_event_type:${eventType || 'none'}` };
  }
}
