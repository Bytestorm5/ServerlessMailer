import { NextResponse } from 'next/server';
import { collections } from '@/lib/db';
import { env } from '@/lib/env';
import { handle } from '@/lib/api';
import { clientIp } from '@/lib/rate-limit';
import { confirmSubscriber } from '@/lib/subscribers';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Confirmation (§5.2).
 *
 * Failure is a friendly page offering to start over, not a raw error: the
 * person clicking this link did what was asked of them, and an expired token
 * is the system's problem to explain.
 */
export async function GET(request: Request) {
  return handle(async () => {
    const url = new URL(request.url);
    const token = url.searchParams.get('token') ?? '';

    if (!token) {
      return NextResponse.redirect(new URL('/confirm/failed?reason=missing', env.appBaseUrl), 303);
    }

    const result = await confirmSubscriber({
      token,
      ip: clientIp(request.headers),
      userAgent: request.headers.get('user-agent') ?? 'unknown',
    });

    if (!result.ok) {
      log.info('confirmation failed', { reason: result.reason });
      return NextResponse.redirect(new URL(`/confirm/failed?reason=${result.reason}`, env.appBaseUrl), 303);
    }

    const c = await collections();
    const list = await c.lists.findOne({ _id: result.subscriber.listId });

    // 5. Redirect to the configurable welcome page.
    const destination = list?.welcomeUrl?.trim()
      ? list.welcomeUrl
      : new URL('/confirmed', env.appBaseUrl).toString();

    return NextResponse.redirect(destination, 303);
  });
}
