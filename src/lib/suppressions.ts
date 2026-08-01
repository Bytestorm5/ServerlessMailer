import type { ObjectId } from 'mongodb';
import { collections, isDuplicateKeyError } from './db';
import { normalizeEmail } from './email-address';
import type { SuppressionReason } from './types';

/**
 * The suppression list is sacred (§1.2).
 *
 * Global across both lists and both domains, because SES reputation
 * thresholds are account-level: a hard bounce on one domain is evidence about
 * the address, not about the list it happened to be on.
 *
 * There is deliberately no bypass flag anywhere in this module.
 */

export interface SuppressInput {
  email: string;
  reason: SuppressionReason;
  sourceCampaignId?: ObjectId | null;
  detail?: string | null;
}

/** Idempotent: re-suppressing an address keeps the original record and reason. */
export async function suppress(input: SuppressInput): Promise<{ created: boolean }> {
  const c = await collections();
  const email = normalizeEmail(input.email);
  try {
    await c.suppressions.insertOne({
      email,
      reason: input.reason,
      createdAt: new Date(),
      sourceCampaignId: input.sourceCampaignId ?? null,
      detail: input.detail ?? null,
    } as never);
    return { created: true };
  } catch (error) {
    if (isDuplicateKeyError(error)) return { created: false };
    throw error;
  }
}

export async function isSuppressed(email: string): Promise<boolean> {
  const c = await collections();
  const found = await c.suppressions.findOne({ email: normalizeEmail(email) }, { projection: { _id: 1 } });
  return found !== null;
}

/**
 * Bulk membership test. Returns the subset of the input that is suppressed.
 * Used on every send path and on import, both of which deal in thousands of
 * addresses at a time.
 */
export async function suppressedSubset(emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const c = await collections();
  const normalized = emails.map(normalizeEmail);
  const found = new Set<string>();
  const CHUNK = 1000;
  for (let i = 0; i < normalized.length; i += CHUNK) {
    const chunk = normalized.slice(i, i + CHUNK);
    const cursor = c.suppressions.find({ email: { $in: chunk } }, { projection: { email: 1 } });
    for await (const doc of cursor) found.add(doc.email);
  }
  return found;
}

export async function unsuppress(email: string): Promise<boolean> {
  const c = await collections();
  const result = await c.suppressions.deleteOne({ email: normalizeEmail(email) });
  return result.deletedCount === 1;
}
