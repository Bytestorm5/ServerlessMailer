import { ObjectId } from 'mongodb';
import { env } from './env';
import { signPayload, verifyPayload } from './crypto';
import { collections } from './db';
import type { UnsubscribeSource } from './types';

/**
 * Unsubscribe tokens (§9.2).
 *
 * `HMAC-SHA256(subscriberId + campaignId, UNSUBSCRIBE_SECRET)` over a payload
 * that also carries the ids, because the endpoint has to know *who* is
 * unsubscribing. Not enumerable, and deliberately without expiry — an email
 * from three years ago must still unsubscribe correctly.
 */

const NO_CAMPAIGN = '0';

export function signUnsubscribeToken(
  subscriberId: ObjectId | string,
  campaignId: ObjectId | string | null,
): string {
  return signPayload(env.unsubscribeSecret, `${String(subscriberId)}:${campaignId ? String(campaignId) : NO_CAMPAIGN}`);
}

export interface UnsubscribeTokenPayload {
  subscriberId: string;
  campaignId: string | null;
}

export function verifyUnsubscribeToken(token: string): UnsubscribeTokenPayload | null {
  const payload = verifyPayload(env.unsubscribeSecret, token);
  if (!payload) return null;
  const [subscriberId, campaignId] = payload.split(':');
  if (!subscriberId || !ObjectId.isValid(subscriberId)) return null;
  if (campaignId && campaignId !== NO_CAMPAIGN && !ObjectId.isValid(campaignId)) return null;
  return {
    subscriberId,
    campaignId: campaignId && campaignId !== NO_CAMPAIGN ? campaignId : null,
  };
}

export function unsubscribeUrl(token: string): string {
  return `${env.appBaseUrl}/api/unsubscribe?t=${encodeURIComponent(token)}`;
}

export function preferencesUrl(token: string): string {
  return `${env.appBaseUrl}/preferences?t=${encodeURIComponent(token)}`;
}

/** `mailto:` half of the List-Unsubscribe pair. */
export function unsubscribeMailto(listSendingDomain: string): string {
  return `unsubscribe@${listSendingDomain}`;
}

export interface UnsubscribeOutcome {
  ok: boolean;
  alreadyUnsubscribed: boolean;
}

/**
 * Applies an unsubscribe.
 *
 * Deliberately does *not* write to global `suppressions` (§9): suppression is
 * for deliverability failures, unsubscribe is a per-list preference. Both
 * exclude from sending, but conflating them would suppress an address on the
 * other domain too.
 *
 * Idempotent — one-click unsubscribe endpoints get retried by mail clients.
 */
export async function applyUnsubscribe(
  subscriberId: string | ObjectId,
  source: UnsubscribeSource,
  campaignId?: string | ObjectId | null,
): Promise<UnsubscribeOutcome> {
  const c = await collections();
  const _id = typeof subscriberId === 'string' ? new ObjectId(subscriberId) : subscriberId;
  const now = new Date();

  const existing = await c.subscribers.findOne({ _id });
  if (!existing) return { ok: false, alreadyUnsubscribed: false };
  if (existing.status === 'unsubscribed') return { ok: true, alreadyUnsubscribed: true };

  await c.subscribers.updateOne(
    { _id },
    {
      $set: {
        status: 'unsubscribed',
        unsubscribedAt: now,
        unsubscribeSource: source,
        updatedAt: now,
        // The confirmation token is spent; leaving it live would let an old
        // confirmation link silently resubscribe someone.
        confirmTokenHash: null,
        confirmTokenExpiresAt: null,
      },
    },
  );

  if (campaignId) {
    const cid = typeof campaignId === 'string' ? new ObjectId(campaignId) : campaignId;
    await c.campaigns.updateOne({ _id: cid }, { $inc: { 'counts.unsubscribed': 1 } });
  }

  return { ok: true, alreadyUnsubscribed: false };
}
