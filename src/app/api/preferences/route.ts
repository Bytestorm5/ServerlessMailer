import { ObjectId } from 'mongodb';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { collections } from '@/lib/db';
import { handle, parseJson } from '@/lib/api';
import { applyUnsubscribe, verifyUnsubscribeToken } from '@/lib/unsubscribe';
import { isSuppressed } from '@/lib/suppressions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Backs the human-facing unsubscribe and preferences pages (§9.3).
 *
 * The token is the only credential, so the response deliberately exposes only
 * what the holder of that emailed link already knows: their own address and
 * whether they are currently subscribed.
 */

export async function GET(request: Request) {
  return handle(async () => {
    const token = new URL(request.url).searchParams.get('t') ?? '';
    const payload = verifyUnsubscribeToken(token);
    if (!payload) return NextResponse.json({ ok: false, error: 'invalid_token' }, { status: 400 });

    const c = await collections();
    const subscriber = await c.subscribers.findOne({ _id: new ObjectId(payload.subscriberId) });
    if (!subscriber) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });

    const list = await c.lists.findOne({ _id: subscriber.listId });

    return NextResponse.json({
      ok: true,
      email: subscriber.email,
      status: subscriber.status,
      listName: list?.name ?? 'this newsletter',
    });
  });
}

const actionSchema = z.object({
  t: z.string(),
  action: z.enum(['unsubscribe', 'resubscribe']),
});

export async function POST(request: Request) {
  return handle(async () => {
    const body = await parseJson(request, actionSchema);
    const payload = verifyUnsubscribeToken(body.t);
    if (!payload) return NextResponse.json({ ok: false, error: 'invalid_token' }, { status: 400 });

    const c = await collections();
    const _id = new ObjectId(payload.subscriberId);

    if (body.action === 'unsubscribe') {
      const result = await applyUnsubscribe(_id, 'preferences_page', payload.campaignId);
      return NextResponse.json({ ok: result.ok, status: 'unsubscribed' });
    }

    const subscriber = await c.subscribers.findOne({ _id });
    if (!subscriber) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });

    // Resubscribe is allowed from this page because the person holding the
    // token demonstrably received the email. It is refused for addresses that
    // bounced or complained: those are deliverability facts, not preferences,
    // and re-enabling them is how an SES account gets suspended.
    if (subscriber.status === 'bounced' || subscriber.status === 'complained' || (await isSuppressed(subscriber.email))) {
      return NextResponse.json({ ok: false, error: 'suppressed' }, { status: 409 });
    }

    await c.subscribers.updateOne(
      { _id },
      {
        $set: {
          status: 'confirmed',
          unsubscribedAt: null,
          unsubscribeSource: null,
          updatedAt: new Date(),
          // Keeps the original consent evidence when it exists; records this
          // moment when it does not.
          ...(subscriber.confirmedAt ? {} : { confirmedAt: new Date() }),
        },
      },
    );

    return NextResponse.json({ ok: true, status: 'confirmed' });
  });
}
