import { withAdmin } from '@/lib/api/guard';
import { campaignsCollection, listsCollection, subscribersCollection, suppressionsCollection } from '@/lib/db/collections';
import { reputationSnapshot } from '@/lib/stats';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Dashboard payload. Reputation first, because that is what stops sending. */
export const GET = withAdmin(async () => {
  const [lists, subscribers, suppressions, campaigns] = await Promise.all([
    (await listsCollection()).find({}).toArray(),
    await subscribersCollection(),
    (await suppressionsCollection()).countDocuments(),
    (await campaignsCollection())
      .find({}, { sort: { createdAt: -1 }, limit: 10 })
      .toArray(),
  ]);

  const perList = await Promise.all(
    lists.map(async (list) => ({
      id: list._id.toHexString(),
      name: list.name,
      sendingDomain: list.sendingDomain,
      confirmed: await subscribers.countDocuments({ listId: list._id, status: 'confirmed' }),
      pending: await subscribers.countDocuments({ listId: list._id, status: 'pending' }),
      unsubscribed: await subscribers.countDocuments({ listId: list._id, status: 'unsubscribed' }),
      reputation: await reputationSnapshot({ listId: list._id }),
    })),
  );

  return Response.json({
    ok: true,
    reputation: await reputationSnapshot({}),
    suppressions,
    lists: perList,
    recentCampaigns: campaigns.map((campaign) => ({
      id: campaign._id.toHexString(),
      subject: campaign.subject,
      status: campaign.status,
      counts: campaign.counts,
      createdAt: campaign.createdAt,
      completedAt: campaign.completedAt ?? null,
    })),
  });
});
