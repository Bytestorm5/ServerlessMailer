import { ObjectId } from 'mongodb';
import { NextResponse } from 'next/server';
import { collections } from '@/lib/db';
import { recordEvent } from '@/lib/ses-events';
import { verifyOpenToken } from '@/lib/tracking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Open tracking pixel (§13).
 *
 * Apple Mail Privacy Protection pre-fetches images, which inflates open rates
 * substantially. The UI says so; this endpoint just records what it sees.
 *
 * The pixel is always returned, whatever happens to the bookkeeping — a broken
 * counter must never show a broken image in someone's email.
 */

const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

function pixelResponse(): NextResponse {
  return new NextResponse(new Uint8Array(PIXEL), {
    status: 200,
    headers: {
      'content-type': 'image/gif',
      'content-length': String(PIXEL.length),
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      pragma: 'no-cache',
    },
  });
}

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;

  try {
    const payload = verifyOpenToken(token);
    if (payload) {
      const c = await collections();
      const campaign = await c.campaigns.findOne(
        { _id: new ObjectId(payload.campaignId) },
        { projection: { trackOpens: 1, listId: 1 } },
      );
      // Honour the per-campaign toggle even if a pixel escaped into an
      // untracked send: some sends should go untracked, and that promise holds
      // at read time too.
      if (campaign?.trackOpens) {
        await recordEvent(
          'open',
          new ObjectId(payload.campaignId),
          campaign.listId ?? null,
          new ObjectId(payload.subscriberId),
        );
      }
    }
  } catch {
    // Deliberately swallowed.
  }

  return pixelResponse();
}
