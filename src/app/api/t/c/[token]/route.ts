import { ObjectId } from 'mongodb';
import { NextResponse } from 'next/server';
import { collections } from '@/lib/db';
import { env } from '@/lib/env';
import { recordEvent } from '@/lib/ses-events';
import { isSafeRedirectTarget, verifyClickToken } from '@/lib/tracking';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Click tracking redirect (§13).
 *
 * Redirect targets are signed and re-validated (§12). An unsigned redirector
 * is an open redirect and will be abused — this one will only emit a URL that
 * was signed with the tracking secret at freeze time and still parses as
 * http(s).
 */
export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const payload = verifyClickToken(token);

  if (!payload || !isSafeRedirectTarget(payload.url)) {
    log.warn('rejected click token');
    return NextResponse.redirect(env.appBaseUrl, 302);
  }

  try {
    const c = await collections();
    const campaign = await c.campaigns.findOne(
      { _id: new ObjectId(payload.campaignId) },
      { projection: { trackClicks: 1, listId: 1 } },
    );
    if (campaign?.trackClicks) {
      await recordEvent(
        'click',
        new ObjectId(payload.campaignId),
        campaign.listId ?? null,
        new ObjectId(payload.subscriberId),
        { url: payload.url },
      );
    }
  } catch (error) {
    // The redirect matters more than the metric.
    log.error('click event recording failed', { error: String(error) });
  }

  return NextResponse.redirect(payload.url, 302);
}
