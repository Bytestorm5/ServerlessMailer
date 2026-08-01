import { ObjectId } from 'mongodb';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { collections } from '@/lib/db';
import { badRequest, handle, notFound, parseJson } from '@/lib/api';
import { requireAdmin } from '@/lib/auth';
import { segmentQuerySchema, tiptapDocSchema } from '@/lib/schemas';
import type { TiptapDoc } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** Editor version history depth (§6.1: at least the last 20 saves). */
const VERSION_HISTORY_LIMIT = 20;
const MAX_BODY_BYTES = 1_000_000;

export async function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    await requireAdmin();
    const { id } = await params;
    if (!ObjectId.isValid(id)) return notFound();

    const c = await collections();
    const campaign = await c.campaigns.findOne({ _id: new ObjectId(id) });
    if (!campaign) return notFound();

    const list = await c.lists.findOne({ _id: campaign.listId });
    return NextResponse.json({ campaign, list });
  });
}

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  subject: z.string().max(300).optional(),
  preheader: z.string().max(300).optional(),
  bodySource: tiptapDocSchema.optional(),
  segmentQuery: segmentQuerySchema.optional(),
  trackOpens: z.boolean().optional(),
  trackClicks: z.boolean().optional(),
});

/**
 * Autosave target for the editor (§6.1).
 *
 * Only a `draft` or `scheduled` campaign is editable. After freeze the body is
 * immutable — a template change mid-send must not produce two different
 * emails (§6.2), and the way to guarantee that is to refuse the write.
 */
export async function PATCH(request: Request, { params }: Params) {
  return handle(async () => {
    await requireAdmin();
    const { id } = await params;
    if (!ObjectId.isValid(id)) return notFound();

    const body = await parseJson(request, patchSchema);
    const c = await collections();
    const _id = new ObjectId(id);

    const campaign = await c.campaigns.findOne({ _id });
    if (!campaign) return notFound();
    if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
      return badRequest(`A ${campaign.status} campaign cannot be edited.`);
    }

    if (body.bodySource && JSON.stringify(body.bodySource).length > MAX_BODY_BYTES) {
      return badRequest('Body is too large.');
    }

    const now = new Date();
    const update: Record<string, unknown> = { updatedAt: now, lastEditedAt: now };
    for (const key of ['name', 'subject', 'preheader', 'trackOpens', 'trackClicks'] as const) {
      if (body[key] !== undefined) update[key] = body[key];
    }
    if (body.segmentQuery !== undefined) update.segmentQuery = body.segmentQuery;

    if (body.bodySource !== undefined) {
      const next = body.bodySource as unknown as TiptapDoc;
      const changed = JSON.stringify(campaign.bodySource) !== JSON.stringify(next);
      update.bodySource = next;

      if (changed) {
        // Snapshot the *previous* state, so restoring a version undoes the
        // save that replaced it.
        await c.campaignVersions.insertOne({
          campaignId: _id,
          subject: campaign.subject,
          preheader: campaign.preheader,
          bodySource: campaign.bodySource,
          createdAt: now,
        } as never);

        const stale = await c.campaignVersions
          .find({ campaignId: _id }, { projection: { _id: 1 } })
          .sort({ createdAt: -1 })
          .skip(VERSION_HISTORY_LIMIT)
          .toArray();
        if (stale.length > 0) {
          await c.campaignVersions.deleteMany({ _id: { $in: stale.map((v) => v._id) } });
        }
      }
    }

    await c.campaigns.updateOne({ _id }, { $set: update });
    return NextResponse.json({ ok: true, savedAt: now.toISOString() });
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return handle(async () => {
    await requireAdmin();
    const { id } = await params;
    if (!ObjectId.isValid(id)) return notFound();

    const c = await collections();
    const _id = new ObjectId(id);
    const campaign = await c.campaigns.findOne({ _id });
    if (!campaign) return notFound();

    // A campaign that has sent anything is a record, not a document.
    if (campaign.status !== 'draft') {
      return badRequest(`Only draft campaigns can be deleted. This one is ${campaign.status}.`);
    }

    await c.campaigns.deleteOne({ _id });
    await c.campaignVersions.deleteMany({ campaignId: _id });
    return NextResponse.json({ ok: true });
  });
}
