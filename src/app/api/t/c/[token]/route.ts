import { ObjectId } from 'mongodb';
import { isAllowedRedirectTarget, verifyClickToken, verifyRecipientToken } from '@/lib/crypto/tokens';
import { campaignsCollection, eventsCollection } from '@/lib/db/collections';
import { logger } from '@/lib/logging';
import { renderPublicPage } from '@/lib/pages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Click tracking (spec §13, §12).
 *
 * The redirect target is carried inside a signed token and re-checked against
 * the allowlist before use. An unsigned redirector is an open redirect and will
 * be abused — so an unverifiable token renders a page rather than redirecting
 * anywhere at all.
 */

const MONGO_DUPLICATE_KEY = 11000;

function refuse(): Response {
  return renderPublicPage({
    title: 'Link not recognised',
    heading: 'That link could not be verified',
    bodyHtml:
      '<p>This link did not carry a valid signature, so it has not been ' +
      'followed. It may have been altered in transit.</p>' +
      '<p class="muted">If you copied it from an email, try clicking the link ' +
      'in the email directly.</p>',
    status: 400,
  });
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await ctx.params;

  const target = verifyClickToken(token);
  if (!target) {
    logger.warn('click token failed verification');
    return refuse();
  }
  // Belt and braces: the signature proves we minted it, the allowlist proves it
  // is somewhere we are still willing to send people.
  if (!isAllowedRedirectTarget(target.url)) {
    logger.warn('click target rejected by allowlist');
    return refuse();
  }

  // The recipient parameter is separate from the signed target, so a forwarded
  // email that lost it still reaches the article.
  const recipientToken = new URL(request.url).searchParams.get('r');
  const recipient = recipientToken ? verifyRecipientToken(recipientToken) : null;

  try {
    const campaignId = ObjectId.isValid(target.campaignId)
      ? new ObjectId(target.campaignId)
      : undefined;
    const subscriberId =
      recipient && ObjectId.isValid(recipient.subscriberId)
        ? new ObjectId(recipient.subscriberId)
        : undefined;

    await (await eventsCollection()).insertOne({
      _id: new ObjectId(),
      ...(campaignId ? { campaignId } : {}),
      ...(subscriberId ? { subscriberId } : {}),
      type: 'click',
      ts: new Date(),
      url: target.url,
      // Unique per subscriber, so the headline count is people, not clicks.
      dedupeKey: subscriberId
        ? `click:${target.campaignId}:${recipient!.subscriberId}`
        : undefined,
    });

    if (campaignId) {
      await (await campaignsCollection()).updateOne(
        { _id: campaignId },
        { $inc: { 'counts.clicked': 1 } },
      );
    }
  } catch (err) {
    // A duplicate means they have clicked before; anything else must still not
    // stop the reader reaching the page they asked for.
    if ((err as { code?: number }).code !== MONGO_DUPLICATE_KEY) {
      logger.error('failed to record click', { error: (err as Error).message });
    }
  }

  return new Response(null, {
    status: 302,
    headers: {
      location: target.url,
      'cache-control': 'no-store, max-age=0',
      'referrer-policy': 'no-referrer',
    },
  });
}
