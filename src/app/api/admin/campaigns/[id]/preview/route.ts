import { ObjectId } from 'mongodb';
import { badRequest, notFound, readJson, toObjectId, withAdmin } from '@/lib/api/guard';
import { campaignsCollection, listsCollection, subscribersCollection } from '@/lib/db/collections';
import { config } from '@/lib/config';
import { renderCampaignPreview, unsubscribeUrlFor } from '@/lib/render/campaign';
import { validateEditorDoc } from '@/lib/render/doc';
import { subscriberMergeData } from '@/lib/subscriber-name';
import { getTemplateHtml } from '@/lib/templates';
import { BODY_MODES, type BodyMode, type CampaignDoc, type EditorDoc, type RecipientContext } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Live preview (§6.3). Renders the *unsaved* draft the editor sends up, using a
 * real subscriber's merge data so fallbacks get exercised.
 */
export const POST = withAdmin<Ctx>(async (request, ctx) => {
  const id = toObjectId((await ctx.params).id);
  if (!id) return badRequest('invalid campaign id');

  const campaign = await (await campaignsCollection()).findOne({ _id: id });
  if (!campaign) return notFound('campaign not found');
  const list = await (await listsCollection()).findOne({ _id: campaign.listId });
  if (!list) return notFound('list not found');

  const body = await readJson(request);
  const draftBody = body?.bodySource as EditorDoc | undefined;
  if (draftBody) {
    const validation = validateEditorDoc(draftBody);
    if (!validation.ok) {
      return Response.json({ ok: false, error: 'invalid_body', errors: validation.errors }, { status: 400 });
    }
  }

  const draftMode =
    typeof body?.bodyMode === 'string' && (BODY_MODES as readonly string[]).includes(body.bodyMode)
      ? (body.bodyMode as BodyMode)
      : undefined;

  const draft: CampaignDoc = {
    ...campaign,
    subject: typeof body?.subject === 'string' ? body.subject : campaign.subject,
    preheader: typeof body?.preheader === 'string' ? body.preheader : campaign.preheader,
    bodySource: draftBody ?? campaign.bodySource,
    bodyMode: draftMode ?? campaign.bodyMode,
    bodyHtmlSource:
      typeof body?.bodyHtmlSource === 'string' ? body.bodyHtmlSource : campaign.bodyHtmlSource,
  };

  const subscriberId =
    typeof body?.subscriberId === 'string' && ObjectId.isValid(body.subscriberId)
      ? new ObjectId(body.subscriberId)
      : undefined;
  const subscriber = subscriberId
    ? await (await subscribersCollection()).findOne({ _id: subscriberId })
    : await (await subscribersCollection()).findOne({
        listId: campaign.listId,
        status: 'confirmed',
      });

  const previewId = subscriber?._id ?? new ObjectId();
  const { url, token } = unsubscribeUrlFor(id.toHexString(), previewId.toHexString());

  const recipient: RecipientContext = {
    subscriberId: previewId.toHexString(),
    email: subscriber?.email ?? 'preview@example.com',
    attributes: subscriber ? subscriberMergeData(subscriber) : {},
    unsubscribeUrl: url,
    trackingToken: token,
    openPixelUrl: draft.trackOpens ? `${config.appBaseUrl()}/api/t/o/${token}` : undefined,
  };

  try {
    // The list's current template, so editing the template page and reloading
    // the campaign shows the change.
    const templateHtml = await getTemplateHtml(campaign.listId, 'campaign');
    const rendered = await renderCampaignPreview(draft, list, recipient, templateHtml);
    return Response.json({ ok: true, ...rendered });
  } catch (err) {
    // Surfaced rather than swallowed: a body that does not render must not be
    // shown as if it did (§6.3).
    return Response.json(
      { ok: false, error: (err as Error).message },
      { status: 422 },
    );
  }
});
