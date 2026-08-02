import { badRequest, notFound, readJson, toObjectId, withAdmin } from '@/lib/api/guard';
import { listCampaignVersions, updateCampaignDraft } from '@/lib/campaigns';
import { campaignsCollection, listsCollection } from '@/lib/db/collections';
import { BODY_MODES, type BodyMode, type EditorDoc, type SegmentQuery } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export const GET = withAdmin<Ctx>(async (_request, ctx) => {
  const id = toObjectId((await ctx.params).id);
  if (!id) return badRequest('invalid campaign id');

  const campaign = await (await campaignsCollection()).findOne({ _id: id });
  if (!campaign) return notFound('campaign not found');
  const list = await (await listsCollection()).findOne({ _id: campaign.listId });

  return Response.json({
    ok: true,
    campaign: {
      id: campaign._id.toHexString(),
      listId: campaign.listId.toHexString(),
      subject: campaign.subject,
      preheader: campaign.preheader,
      bodySource: campaign.bodySource,
      bodyMode: campaign.bodyMode ?? 'rich',
      bodyHtmlSource: campaign.bodyHtmlSource ?? '',
      segmentQuery: campaign.segmentQuery,
      status: campaign.status,
      trackOpens: campaign.trackOpens,
      trackClicks: campaign.trackClicks,
      counts: campaign.counts,
      scheduledFor: campaign.scheduledFor ?? null,
      pausedReason: campaign.pausedReason ?? null,
    },
    list: list
      ? {
          id: list._id.toHexString(),
          name: list.name,
          fromName: list.fromName,
          fromEmail: list.fromEmail,
          replyTo: list.replyTo,
        }
      : null,
    versions: (await listCampaignVersions(id, 20)).map((version) => ({
      id: version._id.toHexString(),
      createdAt: version.createdAt,
      subject: version.subject,
    })),
  });
});

/** An unrecognised mode is ignored rather than stored: it would render as nothing. */
function readBodyMode(value: unknown): BodyMode | undefined {
  return typeof value === 'string' && (BODY_MODES as readonly string[]).includes(value)
    ? (value as BodyMode)
    : undefined;
}

export const PATCH = withAdmin<Ctx>(async (request, ctx) => {
  const id = toObjectId((await ctx.params).id);
  if (!id) return badRequest('invalid campaign id');
  const body = await readJson(request);
  if (!body) return badRequest('invalid body');

  const result = await updateCampaignDraft({
    campaignId: id,
    subject: typeof body.subject === 'string' ? body.subject : undefined,
    preheader: typeof body.preheader === 'string' ? body.preheader : undefined,
    bodySource: body.bodySource as EditorDoc | undefined,
    bodyMode: readBodyMode(body.bodyMode),
    bodyHtmlSource: typeof body.bodyHtmlSource === 'string' ? body.bodyHtmlSource : undefined,
    segmentQuery: body.segmentQuery as SegmentQuery | undefined,
    trackOpens: typeof body.trackOpens === 'boolean' ? body.trackOpens : undefined,
    trackClicks: typeof body.trackClicks === 'boolean' ? body.trackClicks : undefined,
  });

  if (!result.ok) {
    if (result.reason === 'not_found') return notFound('campaign not found');
    return Response.json(
      { ok: false, error: result.reason, errors: result.errors ?? [] },
      // A campaign that is already sending is a conflict, not a bad request.
      { status: result.reason === 'immutable' ? 409 : 400 },
    );
  }

  return Response.json({ ok: true });
});
