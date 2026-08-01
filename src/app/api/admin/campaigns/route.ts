import { badRequest, readJson, toObjectId, withAdmin } from '@/lib/api/guard';
import { createCampaign } from '@/lib/campaigns';
import { campaignsCollection, listsCollection } from '@/lib/db/collections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAdmin(async (request) => {
  const url = new URL(request.url);
  const listId = toObjectId(url.searchParams.get('listId') ?? undefined);
  const status = url.searchParams.get('status') ?? undefined;

  const campaigns = await (await campaignsCollection())
    .find({
      ...(listId ? { listId } : {}),
      ...(status ? { status } : {}),
    })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();

  return Response.json({
    ok: true,
    campaigns: campaigns.map((campaign) => ({
      id: campaign._id.toHexString(),
      listId: campaign.listId.toHexString(),
      subject: campaign.subject,
      status: campaign.status,
      counts: campaign.counts,
      scheduledFor: campaign.scheduledFor ?? null,
      createdAt: campaign.createdAt,
      completedAt: campaign.completedAt ?? null,
      pausedReason: campaign.pausedReason ?? null,
    })),
  });
});

export const POST = withAdmin(async (request) => {
  const body = await readJson(request);
  const listId = toObjectId(typeof body?.listId === 'string' ? body.listId : undefined);
  if (!listId) return badRequest('a valid listId is required');

  const list = await (await listsCollection()).findOne({ _id: listId });
  if (!list) return badRequest('unknown list');

  const campaign = await createCampaign({
    listId,
    subject: typeof body?.subject === 'string' ? body.subject : undefined,
  });

  return Response.json({ ok: true, id: campaign._id.toHexString() }, { status: 201 });
});
