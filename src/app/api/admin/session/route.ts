import { ADMIN_COOKIE_NAME, createSessionToken, verifyAdminPassword } from '@/lib/auth';
import { consumeRateLimit } from '@/lib/ratelimit';
import { clientIp } from '@/lib/request-context';
import { logger } from '@/lib/logging';
import { readJson } from '@/lib/api/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SESSION_DAYS = 7;

/** Admin sign-in. Rate limited so the password cannot be brute forced. */
export async function POST(request: Request): Promise<Response> {
  const ip = clientIp(request) ?? 'unknown';
  const limit = await consumeRateLimit(`admin-login:${ip}`, 10, 15 * 60 * 1000);
  if (!limit.allowed) {
    return Response.json({ ok: false, error: 'too many attempts' }, { status: 429 });
  }

  const body = await readJson(request);
  const password = typeof body?.password === 'string' ? body.password : '';

  if (!verifyAdminPassword(password)) {
    logger.warn('failed admin sign-in attempt');
    // Deliberately vague: there is only one account, so naming the reason
    // tells an attacker nothing useful but confirms the endpoint works.
    return Response.json({ ok: false, error: 'invalid credentials' }, { status: 401 });
  }

  const token = createSessionToken('admin');
  const response = Response.json({ ok: true });
  response.headers.append(
    'set-cookie',
    `${ADMIN_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${
      SESSION_DAYS * 24 * 60 * 60
    }`,
  );
  return response;
}

export async function DELETE(): Promise<Response> {
  const response = Response.json({ ok: true });
  response.headers.append(
    'set-cookie',
    `${ADMIN_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`,
  );
  return response;
}
