import { NextResponse } from 'next/server';
import { z } from 'zod';
import { handle, parseJson } from '@/lib/api';
import { login, sessionCookieOptions } from '@/lib/auth';
import { SESSION_COOKIE } from '@/lib/session';
import { clientIp, consumeRateLimit } from '@/lib/rate-limit';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(512),
});

export async function POST(request: Request) {
  return handle(async () => {
    const ip = clientIp(request.headers);
    // Login is the one public write path into the admin surface, so it gets
    // the same rate limiting as the signup form.
    const limit = await consumeRateLimit(`login:${ip}`, 20, 900);
    if (!limit.allowed) {
      return NextResponse.json({ error: 'Too many attempts. Try again shortly.' }, { status: 429 });
    }

    const body = await parseJson(request, schema);
    const result = await login(body.email, body.password);

    if (!result.ok) {
      log.warn('failed admin login', { ip });
      return NextResponse.json({ error: result.reason }, { status: 401 });
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions());
    return response;
  });
}
