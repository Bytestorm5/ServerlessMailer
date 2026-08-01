import { ObjectId } from 'mongodb';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { collections } from '@/lib/db';
import { handle, notFound, parseJson } from '@/lib/api';
import { requireAdmin } from '@/lib/auth';
import { applyTemplateData, resolveMergePlanFromSample } from '@/lib/merge';
import { renderStoredCampaign } from '@/lib/render/render-campaign';
import { buildSampleData } from '@/lib/test-send';
import { availableMergeFields } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

const schema = z.object({
  /** Renders with a real subscriber's merge data, so fallbacks get exercised (§6.3). */
  sampleSubscriberId: z.string().nullable().optional(),
});

/**
 * Preview (§6.3).
 *
 * Uses the same render path as the send, then performs the merge substitution
 * locally that SES would perform server-side. A preview produced by different
 * code would be a lie.
 */
export async function POST(request: Request, { params }: Params) {
  return handle(async () => {
    await requireAdmin();
    const { id } = await params;
    if (!ObjectId.isValid(id)) return notFound();

    const body = await parseJson(request, schema);
    const c = await collections();
    const campaign = await c.campaigns.findOne({ _id: new ObjectId(id) });
    if (!campaign) return notFound();
    const list = await c.lists.findOne({ _id: campaign.listId });
    if (!list) return notFound();

    const rendered = renderStoredCampaign(campaign, list);

    const subscriber =
      body.sampleSubscriberId && ObjectId.isValid(body.sampleSubscriberId)
        ? await c.subscribers.findOne({ _id: new ObjectId(body.sampleSubscriberId) })
        : null;

    const sample = buildSampleData(list, subscriber);
    const data: Record<string, string> = {
      ...resolveMergePlanFromSample(rendered.mergePlan, sample),
      unsubscribe_url: '#unsubscribe-preview',
      preferences_url: '#preferences-preview',
      physical_address: list.physicalAddress,
      list_name: list.name,
      from_name: list.fromName,
      subject: campaign.subject,
      open_pixel_url: 'about:blank',
    };
    rendered.trackedLinks.forEach((target, index) => {
      // Previews show the real destination, not a tracking redirect: the point
      // is to check where the reader ends up.
      data[`c${index}`] = target;
    });

    return NextResponse.json({
      subject: applyTemplateData(rendered.subjectTemplate, data),
      html: applyTemplateData(rendered.html, data),
      text: applyTemplateData(rendered.text, data),
      mergePlan: rendered.mergePlan,
      availableFields: availableMergeFields(list),
      sampleSubscriber: subscriber ? { id: String(subscriber._id), email: subscriber.email } : null,
      warnings: rendered.mjmlErrors,
    });
  });
}

/** A handful of confirmed subscribers to populate the preview-as dropdown. */
export async function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    await requireAdmin();
    const { id } = await params;
    if (!ObjectId.isValid(id)) return notFound();

    const c = await collections();
    const campaign = await c.campaigns.findOne({ _id: new ObjectId(id) }, { projection: { listId: 1 } });
    if (!campaign) return notFound();

    const samples = await c.subscribers
      .find({ listId: campaign.listId, status: 'confirmed' }, { projection: { email: 1, attributes: 1 } })
      .limit(25)
      .toArray();

    return NextResponse.json({
      samples: samples.map((s) => ({ id: String(s._id), email: s.email, attributes: s.attributes })),
    });
  });
}
