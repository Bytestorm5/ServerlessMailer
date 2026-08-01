import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { handle } from '@/lib/api';
import { applyUnsubscribe, verifyUnsubscribeToken } from '@/lib/unsubscribe';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Unsubscribe (§9).
 *
 * The most availability-critical endpoint in the system. If it fails during a
 * send, complaints accrue against the SES thresholds — a broken unsubscribe
 * link does not stop people leaving, it converts them into spam reports.
 *
 * Everything here is synchronous. There is no reason to queue an update to one
 * document, and a queue is one more thing that can be down.
 */

function tokenFrom(request: Request, formToken?: string | null): string {
  const url = new URL(request.url);
  return formToken ?? url.searchParams.get('t') ?? '';
}

/**
 * One-click unsubscribe (RFC 8058), the target of the `List-Unsubscribe-Post`
 * header. Unsubscribe, return 200. No confirmation step, no landing page.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  let formToken: string | null = null;

  // Mail clients POST `List-Unsubscribe=One-Click` as a form body; the token
  // stays in the query string, but accept it from the body too.
  try {
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const form = await request.formData();
      const value = form.get('t');
      if (typeof value === 'string') formToken = value;
    }
  } catch {
    // A malformed body must not stop the unsubscribe.
  }

  const token = formToken ?? url.searchParams.get('t') ?? '';
  const payload = verifyUnsubscribeToken(token);

  if (!payload) {
    log.warn('one-click unsubscribe with invalid token');
    // Still a 200: a mail provider that sees an error may retry or, worse,
    // surface a failure to the recipient who then reports spam instead.
    return new NextResponse('OK', { status: 200 });
  }

  try {
    await applyUnsubscribe(payload.subscriberId, 'one_click', payload.campaignId);
  } catch (error) {
    log.error('one-click unsubscribe failed', { error: String(error) });
  }

  return new NextResponse('OK', {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/** Human-facing entry point: hand off to the page that confirms and explains. */
export async function GET(request: Request) {
  return handle(async () => {
    const token = tokenFrom(request);
    const target = new URL('/unsubscribe', env.appBaseUrl);
    if (token) target.searchParams.set('t', token);
    return NextResponse.redirect(target, 303);
  });
}
