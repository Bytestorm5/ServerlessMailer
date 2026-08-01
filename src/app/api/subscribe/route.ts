import { ObjectId } from 'mongodb';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { collections } from '@/lib/db';
import { env } from '@/lib/env';
import { handle, parseJson } from '@/lib/api';
import { validateAddress } from '@/lib/email-address';
import { clientIp, consumeRateLimit } from '@/lib/rate-limit';
import { isSuppressed } from '@/lib/suppressions';
import { upsertPendingSubscriber } from '@/lib/subscribers';
import { sendConfirmationEmail } from '@/lib/transactional';
import { verifyTurnstile } from '@/lib/turnstile';
import { log, redactEmail } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  listId: z.string(),
  email: z.string().max(254),
  attributes: z.record(z.string().max(200)).optional(),
  /** Honeypot: real people leave this empty. */
  website: z.string().optional(),
  turnstileToken: z.string().optional(),
});

/**
 * Signup (§5.1).
 *
 * The response is identical whether the address is new, already pending,
 * already confirmed, suppressed, malformed or rate-limited. Any variation is
 * an email enumeration oracle, and the only way to be sure there is no
 * variation is to have exactly one success path (§12).
 */
const GENERIC_SUCCESS = {
  ok: true,
  message: 'Thanks. Check your inbox for a confirmation link.',
};

export async function POST(request: Request) {
  return handle(async () => {
    const body = await parseJson(request, schema);
    const ip = clientIp(request.headers);

    // 2. Honeypot first — it costs nothing and rejects most of the volume.
    if (body.website && body.website.trim() !== '') {
      log.info('signup rejected: honeypot', { ip });
      return NextResponse.json(GENERIC_SUCCESS);
    }

    // 1. Rate limit by IP and by address.
    const ipLimit = await consumeRateLimit(`signup:ip:${ip}`, env.signupRateLimitPerIp, env.signupRateLimitWindowSec);
    if (!ipLimit.allowed) {
      log.warn('signup rate limited by ip', { ip, count: ipLimit.count });
      return NextResponse.json(GENERIC_SUCCESS);
    }

    if (!(await verifyTurnstile(body.turnstileToken, ip))) {
      log.info('signup rejected: turnstile', { ip });
      return NextResponse.json(GENERIC_SUCCESS);
    }

    if (!ObjectId.isValid(body.listId)) return NextResponse.json(GENERIC_SUCCESS);
    const listId = new ObjectId(body.listId);

    const c = await collections();
    const list = await c.lists.findOne({ _id: listId, active: true });
    if (!list) return NextResponse.json(GENERIC_SUCCESS);

    // 3. Normalize, validate syntax, and require an MX record.
    const validation = await validateAddress(body.email);
    if (!validation.ok) {
      log.info('signup rejected: invalid address', { ip, reason: validation.reason });
      return NextResponse.json(GENERIC_SUCCESS);
    }
    const { email } = validation;

    const emailLimit = await consumeRateLimit(`signup:email:${email}`, 5, env.signupRateLimitWindowSec);
    if (!emailLimit.allowed) return NextResponse.json(GENERIC_SUCCESS);

    // 4. Suppressed addresses are silently accepted and dropped. Never
    //    disclose suppression state.
    if (await isSuppressed(email)) {
      log.info('signup ignored: suppressed address', { domain: email.split('@')[1] });
      return NextResponse.json(GENERIC_SUCCESS);
    }

    // 5–6. Upsert as pending and mint a token whose hash alone is stored.
    const result = await upsertPendingSubscriber({
      listId,
      email,
      attributes: body.attributes,
      source: 'web_form',
    });

    // 7. Transactional send, immediately. This does not go through the
    //    campaign cron.
    if (result.token) {
      try {
        await sendConfirmationEmail(list, email, result.token);
      } catch (error) {
        // The subscriber record stands; a resend after the rate-limit window
        // will retry. Failing the request would leak that the address is new.
        log.error('confirmation email send failed', { error: String(error), to: redactEmail(email) });
      }
    }

    // 8. One response, always.
    return NextResponse.json(GENERIC_SUCCESS);
  });
}
