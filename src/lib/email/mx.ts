/**
 * MX verification for signup (§5.1 step 3).
 *
 * A domain with no MX record cannot receive mail, so every message to it is a
 * guaranteed bounce — and bounce rate is measured against an account-level
 * threshold that suspends sending at 10% (§8.3). This check therefore **fails
 * closed**: a DNS error, a timeout, an empty answer and a malformed domain all
 * mean "no MX", never "assume it's fine".
 */

import { resolveMx } from 'node:dns/promises';
import { config } from '@/lib/config';
import { isValidDomain } from '@/lib/email/normalize';
import { logger } from '@/lib/logging';

export type MxResolver = (
  domain: string,
) => Promise<{ exchange: string; priority: number }[]>;

const defaultResolver: MxResolver = (domain) => resolveMx(domain);

let resolver: MxResolver = defaultResolver;

/** Test seam. Passing `undefined` restores the node:dns resolver. */
export function setMxResolver(next: MxResolver | undefined): void {
  resolver = next ?? defaultResolver;
}

export function resetMxResolver(): void {
  resolver = defaultResolver;
}

function normalizeDomain(domain: string): string {
  if (typeof domain !== 'string') return '';
  // A trailing root dot is legal in DNS but not in an address we store.
  return domain.trim().toLowerCase().replace(/\.+$/, '');
}

/**
 * RFC 7505: a single MX of `.` is an explicit declaration that the domain
 * accepts no mail. Treating it as a valid record would send to a black hole.
 */
function isUsableExchange(record: unknown): boolean {
  if (!record || typeof record !== 'object') return false;
  const exchange = (record as { exchange?: unknown }).exchange;
  if (typeof exchange !== 'string') return false;
  const trimmed = exchange.trim();
  return trimmed.length > 0 && trimmed !== '.';
}

export async function hasMxRecord(domain: string): Promise<boolean> {
  // Escape hatch for environments without outbound DNS. Deliberately checked
  // before anything else so it is a true no-op, not a partial one.
  if (config.skipMxCheck()) return true;

  const host = normalizeDomain(domain);
  // Never hand an unvalidated string to a resolver.
  if (!isValidDomain(host)) return false;

  try {
    const records = await resolver(host);
    if (!Array.isArray(records)) return false;
    return records.some(isUsableExchange);
  } catch (error) {
    logger.warn('mx lookup failed; treating domain as undeliverable', {
      domain: host,
      error,
    });
    return false;
  }
}
