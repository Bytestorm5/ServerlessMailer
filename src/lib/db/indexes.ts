import {
  campaignBatchesCollection,
  campaignVersionsCollection,
  campaignsCollection,
  emailTemplatesCollection,
  eventsCollection,
  importAttestationsCollection,
  rateLimitsCollection,
  seedAddressesCollection,
  sentLogCollection,
  subscribersCollection,
  suppressionsCollection,
} from '@/lib/db/collections';

/**
 * Creates every index the application depends on.
 *
 * The unique index on `sent_log` is not an optimization — it is a
 * database-level invariant that survives bugs in the claim logic (§3.6).
 * `createIndex` is idempotent, so this is safe to run on every deploy.
 */
export async function ensureIndexes(): Promise<void> {
  const [
    subscribers,
    suppressions,
    campaigns,
    batches,
    sentLog,
    events,
    versions,
    templates,
    rateLimits,
    seeds,
    attestations,
  ] = await Promise.all([
    subscribersCollection(),
    suppressionsCollection(),
    campaignsCollection(),
    campaignBatchesCollection(),
    sentLogCollection(),
    eventsCollection(),
    campaignVersionsCollection(),
    emailTemplatesCollection(),
    rateLimitsCollection(),
    seedAddressesCollection(),
    importAttestationsCollection(),
  ]);

  await Promise.all([
    subscribers.createIndex({ listId: 1, email: 1 }, { unique: true, name: 'listId_email_unique' }),
    subscribers.createIndex({ listId: 1, status: 1 }, { name: 'listId_status' }),
    subscribers.createIndex(
      { confirmTokenHash: 1 },
      { sparse: true, name: 'confirmTokenHash_sparse' },
    ),
    subscribers.createIndex({ email: 1 }, { name: 'email' }),
    subscribers.createIndex({ listId: 1, createdAt: -1 }, { name: 'listId_createdAt' }),

    suppressions.createIndex({ email: 1 }, { unique: true, name: 'email_unique' }),

    campaigns.createIndex({ listId: 1, status: 1 }, { name: 'listId_status' }),
    campaigns.createIndex({ status: 1, scheduledFor: 1 }, { name: 'status_scheduledFor' }),

    batches.createIndex({ campaignId: 1, status: 1 }, { name: 'campaignId_status' }),
    batches.createIndex({ status: 1, leaseUntil: 1 }, { name: 'status_leaseUntil' }),

    // The invariant.
    sentLog.createIndex(
      { campaignId: 1, subscriberId: 1 },
      { unique: true, name: 'campaignId_subscriberId_unique' },
    ),
    // Attributes an incoming SES/SNS event back to the campaign and recipient
    // it came from.
    sentLog.createIndex(
      { sesMessageId: 1 },
      { sparse: true, name: 'sesMessageId_sparse' },
    ),

    events.createIndex({ campaignId: 1, type: 1 }, { name: 'campaignId_type' }),
    events.createIndex({ subscriberId: 1, ts: -1 }, { name: 'subscriberId_ts' }),
    events.createIndex(
      { dedupeKey: 1 },
      { unique: true, sparse: true, name: 'dedupeKey_unique' },
    ),

    versions.createIndex({ campaignId: 1, createdAt: -1 }, { name: 'campaignId_createdAt' }),

    // One template per list, enforced by the database rather than by the
    // upsert: two templates for one list is an ambiguous render.
    templates.createIndex({ listId: 1 }, { unique: true, name: 'listId_unique' }),

    // Mongo's TTL monitor reaps expired rate-limit windows.
    rateLimits.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl' }),

    seeds.createIndex({ listId: 1, email: 1 }, { unique: true, name: 'listId_email_unique' }),

    attestations.createIndex({ listId: 1, attestedAt: -1 }, { name: 'listId_attestedAt' }),
  ]);
}
