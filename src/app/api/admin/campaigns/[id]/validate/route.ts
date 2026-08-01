import { ObjectId } from 'mongodb';
import { NextResponse } from 'next/server';
import { collections } from '@/lib/db';
import { env } from '@/lib/env';
import { handle, notFound } from '@/lib/api';
import { requireAdmin } from '@/lib/auth';
import { runPreSendGate } from '@/lib/validation';
import { describeSegment } from '@/lib/segments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

/**
 * Runs the pre-send gate (§6.6) and returns everything the send-confirmation
 * modal needs to restate in plain language (§6.7).
 *
 * `?quick=1` skips the link reachability probe so the editor can show live
 * status without hitting every external site on each keystroke. The send path
 * never passes it.
 */
export async function POST(request: Request, { params }: Params) {
  return handle(async () => {
    await requireAdmin();
    const { id } = await params;
    if (!ObjectId.isValid(id)) return notFound();

    const quick = new URL(request.url).searchParams.get('quick') === '1';

    const c = await collections();
    const campaign = await c.campaigns.findOne({ _id: new ObjectId(id) });
    if (!campaign) return notFound();
    const list = await c.lists.findOne({ _id: campaign.listId });
    if (!list) return notFound();

    const gate = await runPreSendGate(campaign, list, { skipLinkProbe: quick });

    return NextResponse.json({
      ...gate,
      confirmation: {
        recipientCount: gate.recipientCount,
        listName: list.name,
        fromName: list.fromName,
        fromEmail: list.fromEmail,
        replyTo: list.replyTo,
        subject: campaign.subject,
        segment: describeSegment(campaign.segmentQuery),
        // Above this threshold the operator must type the list name to
        // confirm. This is the last human checkpoint before 19,000 people
        // receive something.
        typedConfirmationRequired: gate.recipientCount >= env.typedConfirmThreshold,
        typedConfirmationPhrase: list.name,
      },
    });
  });
}
