import { ObjectId } from 'mongodb';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { collections } from '@/lib/db';
import { badRequest, handle, notFound, parseJson } from '@/lib/api';
import { requireAdmin } from '@/lib/auth';
import { cancelCampaign, pauseCampaign, resumeCampaign, unscheduleCampaign } from '@/lib/campaigns';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

const schema = z.object({
  action: z.enum(['pause', 'resume', 'cancel', 'unschedule', 'retry_failed_batches']),
  reason: z.string().max(300).optional(),
});

/**
 * Pause, resume, abort (§7.7).
 *
 * Pausing removes the campaign from the claim query, so sending stops within
 * one minute with no in-flight work lost. Resuming is safe because `sent_log`
 * makes a re-send of an already-sent batch a no-op.
 */
export async function POST(request: Request, { params }: Params) {
  return handle(async () => {
    const admin = await requireAdmin();
    const { id } = await params;
    if (!ObjectId.isValid(id)) return notFound();

    const body = await parseJson(request, schema);
    const _id = new ObjectId(id);
    const c = await collections();

    switch (body.action) {
      case 'pause': {
        const ok = await pauseCampaign(_id, body.reason ?? `Paused by ${admin.email}`);
        return ok ? NextResponse.json({ ok }) : badRequest('Only a sending campaign can be paused.');
      }
      case 'resume': {
        const ok = await resumeCampaign(_id);
        return ok ? NextResponse.json({ ok }) : badRequest('Only a paused campaign can be resumed.');
      }
      case 'cancel': {
        const ok = await cancelCampaign(_id);
        log.warn('campaign cancelled', { campaignId: id, by: admin.email });
        return ok ? NextResponse.json({ ok }) : badRequest('This campaign cannot be cancelled.');
      }
      case 'unschedule': {
        const ok = await unscheduleCampaign(_id);
        return ok ? NextResponse.json({ ok }) : badRequest('Only a scheduled campaign can be unscheduled.');
      }
      case 'retry_failed_batches': {
        // §15: "Batches at attempts = MAX, failed → inspect lastError; fix and
        // re-materialize failed batches." Resetting attempts is what makes the
        // next tick pick them up again.
        const campaign = await c.campaigns.findOne({ _id });
        if (!campaign) return notFound();

        const reset = await c.campaignBatches.updateMany(
          { campaignId: _id, status: 'failed' },
          { $set: { status: 'pending', attempts: 0, leaseUntil: new Date(0) } },
        );
        if (campaign.status === 'sent' || campaign.status === 'failed') {
          await c.campaigns.updateOne(
            { _id },
            { $set: { status: 'sending', completedAt: null, updatedAt: new Date() } },
          );
        }
        log.info('failed batches re-queued', { campaignId: id, by: admin.email, count: reset.modifiedCount });
        return NextResponse.json({ ok: true, requeued: reset.modifiedCount });
      }
    }
  });
}
