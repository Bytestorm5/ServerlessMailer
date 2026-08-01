import { ObjectId } from 'mongodb';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { collections } from '@/lib/db';
import { badRequest, handle, notFound, parseJson } from '@/lib/api';
import { requireAdmin } from '@/lib/auth';
import { isSyntacticallyValid, normalizeEmail } from '@/lib/email-address';
import { sendTestCampaign } from '@/lib/test-send';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

const schema = z.object({
  /** Arbitrary addresses; omit to use the list's saved seed addresses (§6.5). */
  recipients: z.array(z.string().max(254)).max(50).optional(),
  useSeedList: z.boolean().default(false),
  sampleSubscriberId: z.string().nullable().optional(),
});

export async function POST(request: Request, { params }: Params) {
  return handle(async () => {
    const admin = await requireAdmin();
    const { id } = await params;
    if (!ObjectId.isValid(id)) return notFound();

    const body = await parseJson(request, schema);
    const c = await collections();
    const campaign = await c.campaigns.findOne({ _id: new ObjectId(id) });
    if (!campaign) return notFound();
    const list = await c.lists.findOne({ _id: campaign.listId });
    if (!list) return notFound();

    const raw = body.useSeedList ? list.seedEmails : (body.recipients ?? []);
    const recipients = [...new Set(raw.map(normalizeEmail))].filter(isSyntacticallyValid);
    if (recipients.length === 0) return badRequest('No valid test recipients.');

    const sampleSubscriber =
      body.sampleSubscriberId && ObjectId.isValid(body.sampleSubscriberId)
        ? await c.subscribers.findOne({ _id: new ObjectId(body.sampleSubscriberId) })
        : null;

    const result = await sendTestCampaign({
      campaign,
      list,
      recipients,
      sampleSubscriber,
      sentBy: admin.email,
    });

    return NextResponse.json({ ok: true, ...result });
  });
}
