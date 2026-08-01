import { ObjectId } from 'mongodb';
import { verifyRecipientToken } from '@/lib/crypto/tokens';
import { listsCollection, subscribersCollection } from '@/lib/db/collections';
import { logger } from '@/lib/logging';
import { escapeHtml, renderPublicPage } from '@/lib/pages';
import { resubscribe, unsubscribeSubscriber } from '@/lib/subscribers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Unsubscribe (spec §9).
 *
 * Legally required, and the most availability-critical endpoint in the system:
 * if it fails during a send, complaints accrue against the SES thresholds in
 * §8.3. Everything here is written to succeed or to fail quietly with a 200 —
 * never to return an error a mailbox provider would interpret as a broken
 * unsubscribe.
 *
 * Unsubscribing sets `status = unsubscribed` but deliberately does NOT add the
 * address to global `suppressions`: suppression is for deliverability failures,
 * unsubscribe is a per-list preference. Both exclude from sending.
 */

async function readToken(request: Request): Promise<string | null> {
  const fromQuery = new URL(request.url).searchParams.get('t');
  if (fromQuery) return fromQuery;

  // RFC 8058 one-click posts a form body; some providers put the token there.
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/x-www-form-urlencoded')) return null;
  try {
    const body = await request.text();
    return new URLSearchParams(body).get('t');
  } catch {
    return null;
  }
}

interface Resolved {
  subscriberId: ObjectId;
  campaignId: ObjectId | undefined;
}

function resolve(token: string | null): Resolved | null {
  if (!token) return null;
  const payload = verifyRecipientToken(token);
  if (!payload) return null;
  if (!ObjectId.isValid(payload.subscriberId)) return null;
  return {
    subscriberId: new ObjectId(payload.subscriberId),
    campaignId: ObjectId.isValid(payload.campaignId)
      ? new ObjectId(payload.campaignId)
      : undefined,
  };
}

/**
 * One-click (§9.3). Unsubscribe, return 200. Nothing else — no confirmation
 * step, no landing page.
 */
export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const token = await readToken(request);
  const resolved = resolve(token);

  if (!resolved) {
    // A forged or truncated token is not worth a non-200: providers read a
    // failure as a broken unsubscribe and penalise the sender for it.
    logger.warn('unsubscribe called with an unusable token');
    return new Response('OK', { status: 200, headers: { 'cache-control': 'no-store' } });
  }

  if (url.searchParams.get('action') === 'resubscribe') {
    await resubscribe(resolved.subscriberId);
    return new Response('OK', { status: 200, headers: { 'cache-control': 'no-store' } });
  }

  await unsubscribeSubscriber({
    subscriberId: resolved.subscriberId,
    source: 'one_click',
    campaignId: resolved.campaignId,
  });

  return new Response('OK', { status: 200, headers: { 'cache-control': 'no-store' } });
}

/**
 * Human-facing page (§9.3). Performs the unsubscribe, confirms it, and offers a
 * way back. Processing on GET is deliberate: a reader who clicks the link in the
 * email expects to be done, and making them press a second button is exactly the
 * friction that turns an unsubscribe into a spam complaint.
 */
export async function GET(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get('t');
  const resolved = resolve(token);

  if (!resolved) {
    return renderPublicPage({
      title: 'Unsubscribe',
      heading: 'That link is not valid',
      bodyHtml:
        '<p>This unsubscribe link could not be read. It may have been broken by ' +
        'your email client, or truncated when it was copied.</p>' +
        '<p class="muted">If you keep receiving emails you did not ask for, reply ' +
        'to any of them and a person will remove you.</p>',
    });
  }

  const result = await unsubscribeSubscriber({
    subscriberId: resolved.subscriberId,
    source: 'preferences_page',
    campaignId: resolved.campaignId,
  });

  if (!result.ok) {
    return renderPublicPage({
      title: 'Unsubscribe',
      heading: 'We could not find that subscription',
      bodyHtml:
        '<p>It may already have been removed. Either way, you will not receive ' +
        'any further emails from this list.</p>',
    });
  }

  const subscriber = await (await subscribersCollection()).findOne({
    _id: resolved.subscriberId,
  });
  const list = subscriber
    ? await (await listsCollection()).findOne({ _id: subscriber.listId })
    : null;
  const listName = list?.name ?? 'this list';

  return renderPublicPage({
    title: 'Unsubscribed',
    heading: 'You have been unsubscribed',
    bodyHtml:
      `<p>You will no longer receive <strong>${escapeHtml(listName)}</strong>.</p>` +
      '<p class="muted">Changed your mind? You can resubscribe with one click.</p>' +
      `<form method="post" action="/api/unsubscribe?t=${escapeHtml(
        encodeURIComponent(token!),
      )}&amp;action=resubscribe">` +
      '<button type="submit">Resubscribe</button>' +
      '</form>',
  });
}
