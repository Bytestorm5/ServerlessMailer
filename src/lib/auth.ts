import { cookies } from 'next/headers';
import { env } from './env';
import { collections } from './db';
import { hashPassword, verifyPassword } from './crypto';
import { normalizeEmail } from './email-address';
import { log } from './logger';
import { SESSION_COOKIE, SESSION_TTL_MS, createSessionToken, verifySessionToken } from './session';

/**
 * Admin authentication (§12).
 *
 * The admin UI is the only authenticated surface: there are no subscriber
 * logins and no public write paths to campaigns or subscribers.
 */

export interface AdminIdentity {
  email: string;
}

/**
 * Creates the first admin from `ADMIN_BOOTSTRAP_*` when the collection is
 * empty. Runs at most once per deployment; after that the variables can be
 * removed.
 */
export async function bootstrapAdminIfNeeded(): Promise<void> {
  const email = env.adminBootstrapEmail;
  const password = env.adminBootstrapPassword;
  if (!email || !password) return;

  const c = await collections();
  const count = await c.admins.estimatedDocumentCount();
  if (count > 0) return;

  await c.admins.insertOne({
    email: normalizeEmail(email),
    passwordHash: await hashPassword(password),
    createdAt: new Date(),
    lastLoginAt: null,
  } as never);
  log.info('bootstrapped first admin account');
}

export type LoginResult = { ok: true; token: string } | { ok: false; reason: string };

export async function login(email: string, password: string): Promise<LoginResult> {
  await bootstrapAdminIfNeeded();

  const c = await collections();
  const admin = await c.admins.findOne({ email: normalizeEmail(email) });

  // Always run the hash comparison so a missing account and a wrong password
  // take the same time.
  const stored = admin?.passwordHash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA';
  const valid = await verifyPassword(password, stored);

  if (!admin || !valid) return { ok: false, reason: 'Invalid email or password' };

  await c.admins.updateOne({ _id: admin._id }, { $set: { lastLoginAt: new Date() } });
  return { ok: true, token: await createSessionToken(admin.email, env.sessionSecret) };
}

export function sessionCookieOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

/** Current admin, or null. */
export async function currentAdmin(): Promise<AdminIdentity | null> {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value, env.sessionSecret);
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}

/**
 * Route-handler guard. Middleware already blocks unauthenticated requests to
 * `/api/admin/*`; this is the second lock on the same door, because a routing
 * mistake should not become an authentication bypass.
 */
export async function requireAdmin(): Promise<AdminIdentity> {
  const admin = await currentAdmin();
  if (!admin) throw new UnauthorizedError();
  return admin;
}
