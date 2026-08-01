import { listsCollection } from '@/lib/db/collections';
import { logger } from '@/lib/logging';
import { renderPublicPage } from '@/lib/pages';
import { clientIp, userAgent } from '@/lib/request-context';
import { confirmSubscriber } from '@/lib/subscribers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Double opt-in confirmation (spec §5.2).
 *
 * The raw token is never stored — the lookup is by HMAC hash — and the hash is
 * cleared on success, which is what makes the link single-use. Every failure
 * mode renders a friendly page offering to start over rather than a raw error.
 */

const RETRY_NOTE =
  '<p class="muted">You can sign up again from the website and we will send a ' +
  'fresh confirmation link.</p>';

export async function GET(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get('token');

  if (!token) {
    return renderPublicPage({
      title: 'Confirm your subscription',
      heading: 'That link is incomplete',
      bodyHtml:
        '<p>The confirmation link is missing its token. Email clients sometimes ' +
        'break long links across lines — try copying the whole link into your ' +
        'browser.</p>' + RETRY_NOTE,
    });
  }

  const result = await confirmSubscriber({
    token,
    ip: clientIp(request),
    userAgent: userAgent(request),
  });

  if (!result.ok) {
    const expired = result.reason === 'expired';
    return renderPublicPage({
      title: 'Confirm your subscription',
      heading: expired ? 'That link has expired' : 'That link is no longer valid',
      bodyHtml:
        (expired
          ? '<p>Confirmation links are valid for seven days. This one has passed ' +
            'its expiry, so it can no longer be used.</p>'
          : '<p>This link has either already been used or is not one we issued. ' +
            'If you have already confirmed, you are all set — no further action ' +
            'is needed.</p>') + RETRY_NOTE,
    });
  }

  logger.info('subscription confirmed', {
    listId: result.subscriber.listId.toHexString(),
  });

  const list = await (await listsCollection()).findOne({ _id: result.subscriber.listId });

  // The redirect target comes from list configuration only. Honouring a `next`
  // parameter here would make this an open redirect.
  if (list?.welcomeUrl) {
    return new Response(null, {
      status: 302,
      headers: {
        location: list.welcomeUrl,
        'cache-control': 'no-store, max-age=0',
      },
    });
  }

  return renderPublicPage({
    title: 'Subscription confirmed',
    heading: "You're subscribed",
    bodyHtml:
      `<p>Thanks for confirming. You will now receive ` +
      `<strong>${list?.name ?? 'our newsletter'}</strong>.</p>` +
      '<p class="muted">Every email includes a one-click unsubscribe link.</p>',
  });
}
