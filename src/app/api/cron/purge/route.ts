import { verifyCronRequest } from '@/lib/auth';
import { logger } from '@/lib/logging';
import { purgeExpiredPending } from '@/lib/subscribers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Daily housekeeping (spec §4.1).
 *
 * Purges `pending` records that expired unconfirmed after seven days. Only
 * `pending` is ever removed — `unsubscribed`, `bounced` and `complained` are
 * tombstones and are the proof that the address was correctly excluded.
 */
export async function GET(request: Request): Promise<Response> {
  if (!verifyCronRequest(request)) {
    return Response.json({ ok: false }, { status: 401 });
  }

  try {
    const purged = await purgeExpiredPending();
    return Response.json({ ok: true, purged }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    logger.error('purge failed', { error: (err as Error).message });
    return Response.json({ ok: false, error: 'purge failed' }, { status: 500 });
  }
}
