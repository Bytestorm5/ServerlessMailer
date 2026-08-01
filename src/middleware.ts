import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySessionToken } from './lib/session';

/**
 * Blocks unauthenticated access to the admin UI and the admin API (§12).
 *
 * Route handlers repeat the check with `requireAdmin()`. Two locks on one door
 * is deliberate: a matcher mistake here should not silently open a write path
 * to the subscriber list.
 */
export async function middleware(request: NextRequest) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    // Failing closed: without a session secret nothing can be authenticated,
    // so nothing authenticated may be served.
    return NextResponse.json({ error: 'Server not configured' }, { status: 503 });
  }

  const session = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value, secret);
  if (session) return NextResponse.next();

  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('next', request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/admin/:path*', '/api/admin/:path*'],
};
