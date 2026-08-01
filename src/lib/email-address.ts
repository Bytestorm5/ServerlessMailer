import { promises as dns } from 'node:dns';
import { env } from './env';
import { log } from './logger';

/**
 * Address normalization and validation.
 *
 * Normalization is lowercase-and-trim only. Deliberately no gmail dot/plus
 * folding: two addresses that differ by a plus tag are two consenting people,
 * and silently merging them destroys a consent record.
 */

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1) : '';
}

/**
 * Deliberately conservative syntax check. It rejects things RFC 5322 permits
 * (quoted local parts, comments) because none of them occur in a real
 * newsletter list, and accepting them widens the surface for header injection.
 */
const SYNTAX_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function isSyntacticallyValid(email: string): boolean {
  if (email.length < 6 || email.length > 254) return false;
  if (email.includes('..')) return false;
  if (email.startsWith('.') || email.includes('.@') || email.startsWith('@')) return false;
  // Control characters and newlines are a header-injection vector.
  if (/[\x00-\x1f\x7f]/.test(email)) return false;
  const at = email.lastIndexOf('@');
  if (at <= 0) return false;
  const local = email.slice(0, at);
  if (local.length > 64) return false;
  return SYNTAX_RE.test(email);
}

// MX results are cached in-process: a serverless instance handling a burst of
// signups from one domain should not issue one DNS query per submission.
const mxCache = new Map<string, { hasMx: boolean; expiresAt: number }>();
const MX_CACHE_TTL_MS = 10 * 60 * 1000;
const MX_TIMEOUT_MS = 3000;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Returns true when the domain can receive mail.
 *
 * A definitive negative answer (NXDOMAIN / no records) rejects. Anything
 * indefinite — timeout, SERVFAIL, resolver outage — accepts. That looks like a
 * violation of "fail closed", but the failure being guarded against here is
 * different: rejecting on an indefinite answer means a DNS blip silently
 * refuses every genuine signup, and the cost of accepting is one confirmation
 * email that bounces before the address ever reaches a campaign.
 */
export async function domainHasMx(domain: string): Promise<boolean> {
  if (env.disableMxCheck) return true;
  if (!domain) return false;

  const cached = mxCache.get(domain);
  if (cached && cached.expiresAt > Date.now()) return cached.hasMx;

  let hasMx: boolean;
  try {
    const result = await withTimeout(dns.resolveMx(domain), MX_TIMEOUT_MS);
    if (result === 'timeout') {
      log.warn('mx lookup timed out, accepting', { domain });
      return true;
    }
    hasMx = result.length > 0;
    if (!hasMx) {
      // RFC 5321 §5.1: an A record is an implicit mail destination.
      const a = await withTimeout(dns.resolve4(domain).catch(() => [] as string[]), MX_TIMEOUT_MS);
      hasMx = a !== 'timeout' && a.length > 0;
    }
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN') {
      hasMx = false;
    } else {
      log.warn('mx lookup failed, accepting', { domain, code });
      return true;
    }
  }

  mxCache.set(domain, { hasMx, expiresAt: Date.now() + MX_CACHE_TTL_MS });
  return hasMx;
}

export type AddressValidation =
  | { ok: true; email: string; domain: string }
  | { ok: false; reason: 'syntax' | 'no_mx' };

export async function validateAddress(raw: string, options: { checkMx?: boolean } = {}): Promise<AddressValidation> {
  const email = normalizeEmail(raw);
  if (!isSyntacticallyValid(email)) return { ok: false, reason: 'syntax' };
  const domain = emailDomain(email);
  if (options.checkMx !== false) {
    const hasMx = await domainHasMx(domain);
    if (!hasMx) return { ok: false, reason: 'no_mx' };
  }
  return { ok: true, email, domain };
}
