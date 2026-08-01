import { badRequest, notFound, toObjectId, withAdmin } from '@/lib/api/guard';
import {
  campaignsCollection,
  eventsCollection,
  sentLogCollection,
  subscribersCollection,
} from '@/lib/db/collections';
import { isSuppressed } from '@/lib/suppressions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Individual subscriber detail (spec section 4.5): full status history, consent
 * evidence, campaigns sent, and events received.
 */
export const GET = withAdmin<Ctx>(async (_request, ctx) => {
  const id = toObjectId((await ctx.params).id);
  if (!id) return badRequest('invalid subscriber id');

  const subscriber = await (await subscribersCollection()).findOne({ _id: id });
  if (!subscriber) return notFound('subscriber not found');

  const sent = await (await sentLogCollection())
    .find({ subscriberId: id })
    .sort({ sentAt: -1 })
    .limit(100)
    .toArray();

  const campaigns = await (await campaignsCollection())
    .find({ _id: { $in: sent.map((entry) => entry.campaignId) } })
    .toArray();
  const subjects = new Map(campaigns.map((c) => [c._id.toHexString(), c.subject]));

  const events = await (await eventsCollection())
    .find({ subscriberId: id })
    .sort({ ts: -1 })
    .limit(200)
    .toArray();

  return Response.json({
    ok: true,
    subscriber: {
      id: subscriber._id.toHexString(),
      listId: subscriber.listId.toHexString(),
      email: subscriber.email,
      status: subscriber.status,
      source: subscriber.source,
      attributes: subscriber.attributes,
      createdAt: subscriber.createdAt,
      // Consent evidence: the record produced if a complaint is escalated.
      consent: {
        confirmedAt: subscriber.confirmedAt ?? null,
        confirmIp: subscriber.confirmIp ?? null,
        confirmUserAgent: subscriber.confirmUserAgent ?? null,
      },
      unsubscribedAt: subscriber.unsubscribedAt ?? null,
      unsubscribeSource: subscriber.unsubscribeSource ?? null,
      history: subscriber.history ?? [],
      suppressed: await isSuppressed(subscriber.email),
    },
    campaignsSent: sent.map((entry) => ({
      campaignId: entry.campaignId.toHexString(),
      subject: subjects.get(entry.campaignId.toHexString()) ?? '(deleted)',
      sentAt: entry.sentAt,
    })),
    events: events.map((event) => ({
      type: event.type,
      ts: event.ts,
      url: event.url ?? null,
      detail: event.detail ?? null,
    })),
  });
});
