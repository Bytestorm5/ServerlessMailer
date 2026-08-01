import { logger } from '@/lib/logging';
import { handleSnsNotification } from '@/lib/sns/handle';
import { verifySnsMessage, type SnsMessage } from '@/lib/sns/verify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * SES bounce and complaint feedback (spec §8).
 *
 * The signature is verified before any work happens. A shared-secret URL is not
 * sufficient here: the endpoint is otherwise trivially spoofable, and spoofing
 * it means an attacker can suppress the entire subscriber list.
 *
 * SNS retries on a non-2xx. Because every handler is idempotent, the safe
 * response to a *transient* internal failure is 500 (so SNS retries), while the
 * safe response to an unverifiable message is 403 (so it is never processed).
 */
export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }

  if (!raw || typeof raw !== 'object') {
    return Response.json({ ok: false, error: 'invalid payload' }, { status: 400 });
  }

  const verified = await verifySnsMessage(raw as SnsMessage);
  if (!verified) {
    // Deliberately not 500: an unverified message must never be retried into
    // the handler.
    logger.warn('rejected an SNS message that failed signature verification');
    return Response.json({ ok: false, error: 'signature verification failed' }, { status: 403 });
  }

  try {
    const result = await handleSnsNotification(raw);
    if (!result.handled) {
      // Understood, but nothing to do — acknowledge so SNS stops retrying.
      logger.info('SNS message not actionable', { reason: result.reason });
      return Response.json({ ok: true, handled: false, reason: result.reason });
    }
    return Response.json({ ok: true, handled: true, action: result.action });
  } catch (err) {
    // Let SNS retry; the handlers are idempotent so a replay is harmless.
    logger.error('SNS handler failed', { error: (err as Error).message });
    return Response.json({ ok: false, error: 'handler failed' }, { status: 500 });
  }
}
