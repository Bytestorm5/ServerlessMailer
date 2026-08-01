import type { ObjectId } from 'mongodb';
import { ObjectId as ObjectIdCtor } from 'mongodb';
import { suppressionsCollection } from '@/lib/db/collections';
import { normalizeAndValidate, normalizeEmail } from '@/lib/email/normalize';
import { logger } from '@/lib/logging';
import type { SuppressionDoc, SuppressionReason } from '@/lib/types';

/**
 * The suppression list is sacred (spec §1.2). It is global across both lists and
 * both sending domains, because SES reputation thresholds are account-level: a
 * hard bounce on one domain must never be re-mailed from the other.
 *
 * Every function here is written to fail closed. `addSuppression` is idempotent
 * and never throws on a duplicate, so no caller is ever tempted to wrap it in a
 * try/catch that quietly swallows a real failure.
 */

const MONGO_DUPLICATE_KEY = 11000;

/** Escapes a user-supplied search term so it cannot act as a regular expression. */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function isSuppressed(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const collection = await suppressionsCollection();
  const found = await collection.findOne(
    { email: normalized },
    { projection: { _id: 1 } },
  );
  return found !== null;
}

/**
 * Returns the suppressed subset of `emails`, normalized. Used by the send
 * pipeline and by import, both of which check thousands of addresses at once.
 */
export async function filterSuppressed(emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const normalized = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
  if (normalized.length === 0) return new Set();

  const collection = await suppressionsCollection();
  const out = new Set<string>();
  // Chunked so a very large recipient set cannot build a query document that
  // exceeds MongoDB's 16MB BSON limit.
  const CHUNK = 1000;
  for (let i = 0; i < normalized.length; i += CHUNK) {
    const chunk = normalized.slice(i, i + CHUNK);
    const cursor = collection.find(
      { email: { $in: chunk } },
      { projection: { email: 1 } },
    );
    for await (const doc of cursor) out.add(doc.email);
  }
  return out;
}

export async function addSuppression(input: {
  email: string;
  reason: SuppressionReason;
  detail?: string;
  sourceCampaignId?: ObjectId;
  now?: Date;
}): Promise<{ created: boolean }> {
  const check = normalizeAndValidate(input.email);
  if (!check.ok) {
    // Storing a malformed address would create a suppression entry that can
    // never match a real subscriber — worse than useless, it hides the problem.
    throw new Error(`Cannot suppress an invalid email address (${check.reason})`);
  }

  const doc: SuppressionDoc = {
    _id: new ObjectIdCtor(),
    email: check.email,
    reason: input.reason,
    createdAt: input.now ?? new Date(),
    ...(input.sourceCampaignId ? { sourceCampaignId: input.sourceCampaignId } : {}),
    ...(input.detail ? { detail: input.detail } : {}),
  };

  const collection = await suppressionsCollection();
  try {
    await collection.insertOne(doc);
    logger.info('suppression added', {
      reason: input.reason,
      domain: check.domain,
    });
    return { created: true };
  } catch (err) {
    if ((err as { code?: number }).code === MONGO_DUPLICATE_KEY) {
      // Already suppressed. The original record is the evidentiary one and is
      // deliberately left untouched — a later import must not rewrite why an
      // address was suppressed.
      return { created: false };
    }
    throw err;
  }
}

export async function removeSuppression(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const collection = await suppressionsCollection();
  const result = await collection.deleteOne({ email: normalized });
  if (result.deletedCount > 0) {
    logger.warn('suppression removed', { domain: normalized.split('@')[1] });
  }
  return result.deletedCount > 0;
}

export async function listSuppressions(
  opts: { search?: string; limit?: number; skip?: number } = {},
): Promise<{ items: SuppressionDoc[]; total: number }> {
  const collection = await suppressionsCollection();
  const filter = opts.search
    ? { email: { $regex: escapeRegExp(opts.search), $options: 'i' } }
    : {};

  const [items, total] = await Promise.all([
    collection
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(opts.skip ?? 0)
      .limit(Math.min(opts.limit ?? 50, 500))
      .toArray(),
    collection.countDocuments(filter),
  ]);

  return { items, total };
}
