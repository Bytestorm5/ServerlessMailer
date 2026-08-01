import { NextResponse } from 'next/server';
import { handle, invocationId, verifyCronRequest } from '@/lib/api';
import { dueScheduledCampaigns, freezeCampaign } from '@/lib/campaigns';
import { runSendCycle } from '@/lib/pipeline';
import { errorMessage, log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The send cron (§7.2), invoked every minute.
 *
 * Vercel sends cron invocations as `GET` with `Authorization: Bearer
 * ${CRON_SECRET}`. Overlapping invocations are safe — they claim disjoint
 * batches — and a failed invocation needs no retry, because the batches it
 * leased are reclaimed on lease expiry.
 */
export async function GET(request: Request) {
  return handle(async () => {
    // 1. Verify the cron secret before any work.
    if (!verifyCronRequest(request)) {
      log.warn('cron/send rejected: bad or missing CRON_SECRET');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const id = invocationId();

    // Scheduled campaigns are frozen here rather than in a separate job, so
    // there is exactly one place where a campaign starts sending.
    const due = await dueScheduledCampaigns();
    const frozen: { campaignId: string; result: string }[] = [];
    for (const campaign of due) {
      try {
        const result = await freezeCampaign(campaign._id);
        frozen.push({
          campaignId: String(campaign._id),
          result: result.ok ? `frozen: ${result.recipients} recipients` : result.reason,
        });
      } catch (error) {
        log.error('scheduled freeze failed', {
          campaignId: String(campaign._id),
          error: errorMessage(error),
        });
        frozen.push({ campaignId: String(campaign._id), result: 'error' });
      }
    }

    const summary = await runSendCycle(id);
    log.info('cron/send complete', { ...summary, frozen: frozen.length });

    return NextResponse.json({ ok: true, ...summary, frozen });
  });
}

/** Manual kicks from the dashboard use the same code path. */
export const POST = GET;
