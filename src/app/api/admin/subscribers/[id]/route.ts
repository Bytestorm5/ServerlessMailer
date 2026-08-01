import { ObjectId } from 'mongodb';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { collections } from '@/lib/db';
import { handle, notFound, parseJson } from '@/lib/api';
import { requireAdmin } from '@/lib/auth';
import { applyUnsubscribe } from '@/lib/unsubscribe';
import { isSuppressed } from '@/lib/suppressions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * Subscriber detail (§4.5): full status, consent evidence, campaigns sent and
 * events received.
 */
export async function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    await requireAdmin();
    const { id } = await params;
    if (!ObjectId.isValid(id)) return notFound();

    const c = await collections();
    const _id = new ObjectId(id);
    const subscriber = await c.subscribers.findOne({ _id });
    if (!subscriber) return notFound();

    const [list, sent, events, suppressed] = await Promise.all([
      c.lists.findOne({ _id: subscriber.listId }),
      c.sentLog.find({ subscriberId: _id }).sort({ sentAt: -1 }).limit(100).toArray(),
      c.events.find({ subscriberId: _id }).sort({ ts: -1 }).limit(200).toArray(),
      isSuppressed(subscriber.email),
    ]);

    const campaignIds = [...new Set(sent.map((entry) => String(entry.campaignId)))].map((v) => new ObjectId(v));
    const campaigns = await c.campaigns
      .find({ _id: { $in: campaignIds } }, { projection: { subject: 1, status: 1, startedAt: 1 } })
      .toArray();

    const suppression = suppressed ? await c.suppressions.findOne({ email: subscriber.email }) : null;

    return NextResponse.json({
      subscriber,
      list,
      sent,
      events,
      campaigns,
      suppression,
    });
  });
}

const patchSchema = z.object({
  action: z.enum(['unsubscribe', 'resubscribe']).optional(),
  attributes: z.record(z.string().max(500)).optional(),
});

/**
 * Operator edits. Consent evidence fields are deliberately absent from the
 * schema: they are append-only (§5.3) and there is no admin path to rewrite
 * them.
 */
export async function PATCH(request: Request, { params }: Params) {
  return handle(async () => {
    await requireAdmin();
    const { id } = await params;
    if (!ObjectId.isValid(id)) return notFound();

    const body = await parseJson(request, patchSchema);
    const c = await collections();
    const _id = new ObjectId(id);
    const subscriber = await c.subscribers.findOne({ _id });
    if (!subscriber) return notFound();

    if (body.action === 'unsubscribe') {
      await applyUnsubscribe(_id, 'admin');
    }

    if (body.action === 'resubscribe') {
      if (await isSuppressed(subscriber.email)) {
        return NextResponse.json(
          { error: 'Address is suppressed. Remove the suppression first, deliberately.' },
          { status: 409 },
        );
      }
      if (subscriber.status === 'bounced' || subscriber.status === 'complained') {
        return NextResponse.json(
          { error: 'This address bounced or complained. Resubscribing it risks the SES account.' },
          { status: 409 },
        );
      }
      await c.subscribers.updateOne(
        { _id },
        {
          $set: {
            status: 'confirmed',
            unsubscribedAt: null,
            unsubscribeSource: null,
            updatedAt: new Date(),
            ...(subscriber.confirmedAt ? {} : { confirmedAt: new Date() }),
          },
        },
      );
    }

    if (body.attributes) {
      const update: Record<string, string> = {};
      for (const [key, value] of Object.entries(body.attributes)) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) update[`attributes.${key}`] = value;
      }
      if (Object.keys(update).length > 0) {
        await c.subscribers.updateOne({ _id }, { $set: { ...update, updatedAt: new Date() } });
      }
    }

    return NextResponse.json({ ok: true });
  });
}
