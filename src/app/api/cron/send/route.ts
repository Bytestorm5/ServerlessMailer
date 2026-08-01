import { verifyCronRequest } from '@/lib/auth';
import { logger } from '@/lib/logging';
import { runSendCycle } from '@/lib/pipeline/run';

// Vercel cron invocations arrive as GET requests, and cron expressions are UTC
// only (§2.2). maxDuration is 60s; the run budgets 45s of that (§7.2).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The send cron (spec §7.2).
 *
 * Fires every minute. Overlapping invocations are safe because batches are
 * claimed atomically, and a failed invocation is recovered by lease expiry on
 * the next tick — cron plus lease expiry *is* the retry queue.
 */
export async function GET(request: Request): Promise<Response> {
  // Verified before any work at all (§12). CRON_SECRET is auto-provisioned by
  // Vercel and sent as a bearer token.
  if (!verifyCronRequest(request)) {
    return Response.json({ ok: false }, { status: 401 });
  }

  try {
    const summary = await runSendCycle();
    return Response.json({ ok: true, ...summary }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    // A thrown run leaves its batches leased; the next tick reclaims them.
    logger.error('send cycle failed', { error: (err as Error).message });
    return Response.json({ ok: false, error: 'send cycle failed' }, { status: 500 });
  }
}
