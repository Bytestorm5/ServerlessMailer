import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ADMIN_COOKIE_NAME, verifySessionToken, type AdminSession } from '@/lib/auth';

/**
 * Server-component session guard (spec §12: the admin UI is authenticated and
 * there are no public write paths to campaigns or subscribers).
 *
 * Kept separate from `auth.ts` because it imports `next/headers`, which only
 * resolves inside a request scope and would otherwise make the pure auth
 * helpers untestable.
 */
export async function getAdminSession(): Promise<AdminSession | null> {
  const store = await cookies();
  return verifySessionToken(store.get(ADMIN_COOKIE_NAME)?.value);
}

export async function requireAdminPage(): Promise<AdminSession> {
  const session = await getAdminSession();
  if (!session) redirect('/login');
  return session;
}
