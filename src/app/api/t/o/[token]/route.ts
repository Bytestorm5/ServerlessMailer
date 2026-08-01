import { ObjectId } from 'mongodb';
import { verifyRecipientToken } from '@/lib/crypto/tokens';
import { campaignsCollection, eventsCollection } from '@/lib/db/collections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Open tracking (spec §13).
 *
 * Note that Apple Mail Privacy Protection pre-fetches images and so inflates
 * open rates substantially; the UI presents this as a soft signal, never as a
 * precise figure.
 *
 * This endpoint always returns a valid image. A broken image in an email looks
 * like a broken email, so failing closed here means recording nothing — not
 * serving an error.
 */

const MONGO_DUPLICATE_KEY = 11000;

// The smallest valid transparent GIF.
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

function pixelResponse(): Response {
  return new Response(new Uint8Array(PIXEL), {
    status: 200,
    headers: {
      'content-type': 'image/gif',
      'content-length': String(PIXEL.byteLength),
      // Must not be cached, or a reopen never reaches the server.
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      pragma: 'no-cache',
    },
  });
}

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token: raw } = await ctx.params;
  // Tolerate a filename suffix, which some clients append.
  const token = raw.replace(/\.(gif|png|jpg)$/i, '');

  const payload = verifyRecipientToken(token);
  if (!payload) return pixelResponse();
  if (!ObjectId.isValid(payload.campaignId) || !ObjectId.isValid(payload.subscriberId)) {
    return pixelResponse();
  }

  const campaignId = new ObjectId(payload.campaignId);
  const subscriberId = new ObjectId(payload.subscriberId);

  try {
    // The dedupe key makes the headline count unique per subscriber, so it is
    // not inflated by one person reopening the same email.
    await (await eventsCollection()).insertOne({
      _id: new ObjectId(),
      campaignId,
      subscriberId,
      type: 'open',
      ts: new Date(),
      dedupeKey: `open:${payload.campaignId}:${payload.subscriberId}`,
    });
    await (await campaignsCollection()).updateOne(
      { _id: campaignId },
      { $inc: { 'counts.opened': 1 } },
    );
  } catch (err) {
    // A duplicate simply means they have opened it before.
    if ((err as { code?: number }).code !== MONGO_DUPLICATE_KEY) {
      // Never let a tracking failure break the image.
    }
  }

  return pixelResponse();
}
