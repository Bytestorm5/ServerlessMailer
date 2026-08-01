import { ObjectId } from 'mongodb';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { collections } from '@/lib/db';
import { badRequest, handle, notFound, parseJson } from '@/lib/api';
import { requireAdmin } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** Recoverable version history — at least the last 20 saves (§6.1). */
export async function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    await requireAdmin();
    const { id } = await params;
    if (!ObjectId.isValid(id)) return notFound();

    const c = await collections();
    const versions = await c.campaignVersions
      .find({ campaignId: new ObjectId(id) })
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray();

    return NextResponse.json({ versions });
  });
}

const restoreSchema = z.object({ versionId: z.string() });

export async function POST(request: Request, { params }: Params) {
  return handle(async () => {
    await requireAdmin();
    const { id } = await params;
    if (!ObjectId.isValid(id)) return notFound();

    const body = await parseJson(request, restoreSchema);
    if (!ObjectId.isValid(body.versionId)) return badRequest('Invalid versionId');

    const c = await collections();
    const campaignId = new ObjectId(id);
    const campaign = await c.campaigns.findOne({ _id: campaignId });
    if (!campaign) return notFound();
    if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
      return badRequest(`A ${campaign.status} campaign cannot be edited.`);
    }

    const version = await c.campaignVersions.findOne({ _id: new ObjectId(body.versionId), campaignId });
    if (!version) return notFound();

    // Restoring is itself a save, so the state being replaced is recoverable.
    const now = new Date();
    await c.campaignVersions.insertOne({
      campaignId,
      subject: campaign.subject,
      preheader: campaign.preheader,
      bodySource: campaign.bodySource,
      createdAt: now,
    } as never);

    await c.campaigns.updateOne(
      { _id: campaignId },
      {
        $set: {
          subject: version.subject,
          preheader: version.preheader,
          bodySource: version.bodySource,
          updatedAt: now,
          lastEditedAt: now,
        },
      },
    );

    return NextResponse.json({ ok: true });
  });
}
