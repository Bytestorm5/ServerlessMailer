/**
 * Admin authentication and cron authorization (spec §12; CONTRACTS §27).
 *
 * Two independent credentials live here because they share one discipline:
 *
 *  - **The admin session** — an HMAC-signed cookie carrying the operator and
 *    the issue time, valid for seven days. There is no session store; the
 *    signature *is* the store, which is what lets a stateless serverless
 *    function authorise a request without a database round trip.
 *  - **The cron bearer token** — `CRON_SECRET`, auto-provisioned by Vercel and
 *    sent as `Authorization: Bearer …` (§2.2). It gates the entire send
 *    pipeline, so it is verified before any work at all.
 *
 * Three rules hold throughout:
 *
 *  1. **Fail closed** (§1.2). Every verifier returns `false`/`null` when its
 *     secret is missing. An unconfigured deployment must reject everyone, never
 *     accept anyone; a missing secret is logged (never the presented value) so
 *     the misconfiguration is visible rather than silent.
 *  2. **Verifiers never throw.** They sit on the request path of the cron route
 *     and every admin route; an exception there is a 500 instead of a clean 401.
 *  3. **Comparisons are constant time**, and verification re-derives the
 *     canonical token rather than comparing a decoded field. Re-deriving kills a
 *     family of bugs at once: non-canonical base64, signature splicing, key
 *     reordering and smuggled extra claims all fail because they cannot
 *     reproduce the token byte for byte.
 */

import { config } from '@/lib/config';
import { constantTimeEqual, hmacHex } from '@/lib/crypto/tokens';
import { logger } from '@/lib/logging';

export interface AdminSession {
  user: string;
  issuedAt: number;
}

export const ADMIN_COOKIE_NAME = 'sm_admin';

const SEPARATOR = '.';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** `Bearer <token>`, scheme matched case-insensitively per RFC 7235. */
const BEARER = /^Bearer[ \t]+(\S.*)$/i;

/**
 * Reads a secret, converting "not configured" into `undefined` instead of the
 * throw `config` raises. The caller then denies the request — an unconfigured
 * secret must never widen access, and a 401 with a log line beats a 500.
 */
function readSecret(accessor: () => string, name: string): string | undefined {
  try {
    return accessor();
  } catch {
    logger.error('auth secret is not configured; denying request', { variable: name });
    return undefined;
  }
}

/**
 * The canonical signed payload. Fixed key order, exactly two claims: any other
 * encoding of the same session is not this token and will not verify.
 */
function canonicalPayload(session: AdminSession): string {
  return JSON.stringify({ user: session.user, issuedAt: session.issuedAt });
}

function sign(payload: string, secret: string): string {
  const encoded = Buffer.from(payload, 'utf8').toString('base64url');
  return `${encoded}${SEPARATOR}${hmacHex(payload, secret)}`;
}

/**
 * Mints a session token. Base64url and hex only, so the result is safe to place
 * in a `Set-Cookie` value without escaping.
 */
export function createSessionToken(user: string, now: Date = new Date()): string {
  if (typeof user !== 'string' || user === '') {
    // A token with no subject could never verify, so refuse at mint time where
    // the bug is visible rather than at the next sign-in.
    throw new Error('createSessionToken requires a non-empty user');
  }
  return sign(canonicalPayload({ user, issuedAt: now.getTime() }), config.adminSessionSecret());
}

/**
 * Verifies a session token, returning `null` for a tampered payload, a tampered
 * signature, an expired token, malformed input or `undefined`.
 */
export function verifySessionToken(
  token: string | undefined,
  now: Date = new Date(),
): AdminSession | null {
  if (typeof token !== 'string' || token === '') return null;

  const secret = readSecret(config.adminSessionSecret, 'ADMIN_SESSION_SECRET');
  if (secret === undefined) return null;

  try {
    const parts = token.split(SEPARATOR);
    // base64url and hex both exclude `.`, so a well-formed token has exactly one.
    if (parts.length !== 2) return null;
    const [encoded, signature] = parts as [string, string];
    if (encoded === '' || signature === '') return null;

    const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

    const { user, issuedAt } = parsed as Record<string, unknown>;
    if (typeof user !== 'string' || user === '') return null;
    if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt)) return null;

    const session: AdminSession = { user, issuedAt };
    // Compare the whole re-derived token, not the signature alone.
    if (!constantTimeEqual(sign(canonicalPayload(session), secret), token)) return null;

    // Expiry is checked only after the signature holds, so a forged token can
    // never be distinguished from an expired one by the response.
    if (now.getTime() - issuedAt >= SESSION_TTL_MS) return null;

    return session;
  } catch {
    return null;
  }
}

/** Constant-time comparison against the configured admin password. */
export function verifyAdminPassword(password: string): boolean {
  if (typeof password !== 'string') return false;
  const expected = readSecret(config.adminPassword, 'ADMIN_PASSWORD');
  if (expected === undefined) return false;
  return constantTimeEqual(password, expected);
}

/**
 * Reads one cookie out of a `Cookie` header.
 *
 * Split on the *first* `=` only, because a cookie value may legally contain
 * more. Names are compared whole, so `xsm_admin` and `sm_admin_shadow` cannot
 * impersonate `sm_admin`. An empty value is skipped rather than returned, so a
 * stale cleared cookie cannot mask a live one sent alongside it.
 */
function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const segment of header.split(';')) {
    const eq = segment.indexOf('=');
    if (eq === -1) continue;
    if (segment.slice(0, eq).trim() !== name) continue;
    const value = segment.slice(eq + 1).trim();
    if (value !== '') return value;
  }
  return undefined;
}

/**
 * The guard behind every admin route (§12): no valid session, no access.
 *
 * Async by contract — it is called from a route handler and keeps the door open
 * for a future session store without changing any caller.
 */
export async function requireAdmin(request: Request): Promise<AdminSession | null> {
  return verifySessionToken(readCookie(request.headers.get('cookie'), ADMIN_COOKIE_NAME));
}

/**
 * Verifies `Authorization: Bearer ${CRON_SECRET}` (§2.2, §7.2, §12).
 *
 * Returns `false` when `CRON_SECRET` is unset. Vercel always provisions it, so
 * an absent value means something is wrong with the deployment — and the right
 * answer to "I cannot check this credential" is to refuse, not to run the send
 * pipeline for an unauthenticated caller.
 */
export function verifyCronRequest(request: Request): boolean {
  const secret = readSecret(config.cronSecret, 'CRON_SECRET');
  if (secret === undefined) return false;

  const header = request.headers.get('authorization');
  if (typeof header !== 'string') return false;

  const match = BEARER.exec(header.trim());
  // The pattern requires at least one non-space character after the scheme, so
  // `Bearer` alone and `Bearer   ` never reach the comparison.
  if (!match) return false;

  return constantTimeEqual((match[1] as string).trim(), secret);
}
