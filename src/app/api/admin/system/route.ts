import { NextResponse } from 'next/server';
import { z } from 'zod';
import { collections } from '@/lib/db';
import { env } from '@/lib/env';
import { handle, parseJson } from '@/lib/api';
import { requireAdmin } from '@/lib/auth';
import { ensureIndexes } from '@/lib/indexes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Operational self-check.
 *
 * §15 lists "verify the `sent_log` unique index exists" as the response to a
 * duplicate-send report, so the check is here rather than in a runbook step
 * someone has to remember to perform.
 */
export async function GET() {
  return handle(async () => {
    await requireAdmin();
    const c = await collections();

    const sentLogIndexes = await c.sentLog.indexes();
    const uniqueSentLog = sentLogIndexes.some(
      (index) =>
        index.unique === true &&
        JSON.stringify(index.key) === JSON.stringify({ campaignId: 1, subscriberId: 1 }),
    );

    const suppressionIndexes = await c.suppressions.indexes();
    const uniqueSuppressions = suppressionIndexes.some(
      (index) => index.unique === true && JSON.stringify(index.key) === JSON.stringify({ email: 1 }),
    );

    const subscriberIndexes = await c.subscribers.indexes();
    const uniqueSubscribers = subscriberIndexes.some(
      (index) =>
        index.unique === true && JSON.stringify(index.key) === JSON.stringify({ listId: 1, email: 1 }),
    );

    return NextResponse.json({
      invariants: {
        sentLogUniqueIndex: uniqueSentLog,
        suppressionsUniqueIndex: uniqueSuppressions,
        subscribersUniqueIndex: uniqueSubscribers,
      },
      config: {
        mailerDriver: env.mailerDriver,
        sesRegion: env.sesRegion,
        sesMaxSendRate: env.sesMaxSendRate,
        maxBatchesPerRun: env.maxBatchesPerRun,
        batchLeaseMs: env.batchLeaseMs,
        maxBatchAttempts: env.maxBatchAttempts,
        cronRunBudgetMs: env.cronRunBudgetMs,
        complaintRateThreshold: env.complaintRateThreshold,
        bounceRateThreshold: env.bounceRateThreshold,
        typedConfirmThreshold: env.typedConfirmThreshold,
        appBaseUrl: env.appBaseUrl,
        alertWebhookConfigured: Boolean(env.alertWebhookUrl),
      },
    });
  });
}

const schema = z.object({ action: z.literal('ensure_indexes') });

export async function POST(request: Request) {
  return handle(async () => {
    await requireAdmin();
    await parseJson(request, schema);
    const created = await ensureIndexes();
    return NextResponse.json({ ok: true, indexes: created });
  });
}
