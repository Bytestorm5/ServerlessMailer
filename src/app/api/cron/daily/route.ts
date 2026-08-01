import { NextResponse } from 'next/server';
import { collections } from '@/lib/db';
import { PENDING_TTL_DAYS } from '@/lib/env';
import { handle, verifyCronRequest } from '@/lib/api';
import { recoverStalledFreezes } from '@/lib/campaigns';
import { ensureIndexes } from '@/lib/indexes';
import { rollingReputation } from '@/lib/reputation';
import { sendAlert } from '@/lib/alerts';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Daily maintenance.
 *
 * Purges unconfirmed `pending` records after 7 days (§4.1), clears expired
 * confirmation tokens, recovers half-finished freezes, re-asserts the indexes,
 * and alerts when the rolling reputation numbers approach the SES thresholds
 * (§8.3).
 *
 * Note what is *not* purged: `unsubscribed`, `bounced` and `complained`
 * records are tombstones and are never deleted. They are the proof the address
 * was correctly excluded.
 */
export async function GET(request: Request) {
  return handle(async () => {
    if (!verifyCronRequest(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const c = await collections();
    const now = new Date();
    const cutoff = new Date(now.getTime() - PENDING_TTL_DAYS * 24 * 60 * 60 * 1000);

    const purged = await c.subscribers.deleteMany({ status: 'pending', createdAt: { $lt: cutoff } });

    const expiredTokens = await c.subscribers.updateMany(
      { confirmTokenExpiresAt: { $lt: now }, confirmTokenHash: { $ne: null } },
      { $set: { confirmTokenHash: null, confirmTokenExpiresAt: null } },
    );

    const recoveredFreezes = await recoverStalledFreezes();

    // Queue entries for subscribers that no longer exist (purged pendings).
    const staleQueue = await c.confirmationQueue.deleteMany({
      status: { $in: ['sent', 'failed'] },
      createdAt: { $lt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) },
    });

    const indexes = await ensureIndexes();

    const reputation = await rollingReputation();
    for (const window of reputation) {
      if (window.bounceStatus !== 'ok' || window.complaintStatus !== 'ok') {
        await sendAlert(`Reputation warning (${window.label})`, {
          bounceRate: `${(window.bounceRate * 100).toFixed(2)}%`,
          complaintRate: `${(window.complaintRate * 100).toFixed(3)}%`,
          sent: window.sent,
        });
      }
    }

    const summary = {
      purgedPending: purged.deletedCount,
      expiredTokens: expiredTokens.modifiedCount,
      recoveredFreezes,
      cleanedQueueEntries: staleQueue.deletedCount,
      indexesAsserted: indexes.length,
    };
    log.info('cron/daily complete', summary);

    return NextResponse.json({ ok: true, ...summary, reputation });
  });
}

export const POST = GET;
