import { collections } from './db';

/**
 * Index definitions from §3, plus the supporting collections.
 *
 * The unique index on `sent_log` is not an optimization. It is a
 * database-level invariant that survives bugs in the claim logic (§3.6): a
 * duplicate-key error on insert means "already sent" and is swallowed.
 */
export async function ensureIndexes(): Promise<string[]> {
  const c = await collections();
  const created: string[] = [];

  const record = async (name: string, fn: () => Promise<unknown>) => {
    await fn();
    created.push(name);
  };

  // §3.2 subscribers
  await record('subscribers.listId_email_unique', () =>
    c.subscribers.createIndex({ listId: 1, email: 1 }, { unique: true, name: 'listId_email_unique' }),
  );
  await record('subscribers.listId_status', () =>
    c.subscribers.createIndex({ listId: 1, status: 1 }, { name: 'listId_status' }),
  );
  await record('subscribers.confirmTokenHash', () =>
    c.subscribers.createIndex({ confirmTokenHash: 1 }, { sparse: true, name: 'confirmTokenHash' }),
  );
  await record('subscribers.email', () => c.subscribers.createIndex({ email: 1 }, { name: 'email' }));
  await record('subscribers.listId_createdAt', () =>
    c.subscribers.createIndex({ listId: 1, createdAt: -1 }, { name: 'listId_createdAt' }),
  );
  // Drives the daily purge of unconfirmed pending records (§4.1).
  await record('subscribers.status_createdAt', () =>
    c.subscribers.createIndex({ status: 1, createdAt: 1 }, { name: 'status_createdAt' }),
  );

  // §3.3 suppressions
  await record('suppressions.email_unique', () =>
    c.suppressions.createIndex({ email: 1 }, { unique: true, name: 'email_unique' }),
  );
  await record('suppressions.createdAt', () =>
    c.suppressions.createIndex({ createdAt: -1 }, { name: 'createdAt' }),
  );

  // §3.4 campaigns
  await record('campaigns.listId_status', () =>
    c.campaigns.createIndex({ listId: 1, status: 1 }, { name: 'listId_status' }),
  );
  await record('campaigns.status_scheduledFor', () =>
    c.campaigns.createIndex({ status: 1, scheduledFor: 1 }, { name: 'status_scheduledFor' }),
  );

  // §3.5 campaign_batches
  await record('campaign_batches.campaignId_status', () =>
    c.campaignBatches.createIndex({ campaignId: 1, status: 1 }, { name: 'campaignId_status' }),
  );
  await record('campaign_batches.status_leaseUntil', () =>
    c.campaignBatches.createIndex({ status: 1, leaseUntil: 1 }, { name: 'status_leaseUntil' }),
  );

  // §3.6 sent_log — the invariant
  await record('sent_log.campaignId_subscriberId_unique', () =>
    c.sentLog.createIndex(
      { campaignId: 1, subscriberId: 1 },
      { unique: true, name: 'campaignId_subscriberId_unique' },
    ),
  );
  await record('sent_log.sesMessageId', () =>
    c.sentLog.createIndex({ sesMessageId: 1 }, { sparse: true, name: 'sesMessageId' }),
  );

  // §3.7 events
  await record('events.campaignId_type', () =>
    c.events.createIndex({ campaignId: 1, type: 1 }, { name: 'campaignId_type' }),
  );
  await record('events.subscriberId_ts', () =>
    c.events.createIndex({ subscriberId: 1, ts: -1 }, { name: 'subscriberId_ts' }),
  );
  await record('events.type_ts', () => c.events.createIndex({ type: 1, ts: -1 }, { name: 'type_ts' }));
  // De-duplicates repeated opens/clicks per subscriber per campaign for counts.
  await record('events.campaignId_subscriberId_type', () =>
    c.events.createIndex({ campaignId: 1, subscriberId: 1, type: 1 }, { name: 'campaignId_subscriberId_type' }),
  );

  // Supporting collections
  await record('admins.email_unique', () =>
    c.admins.createIndex({ email: 1 }, { unique: true, name: 'email_unique' }),
  );
  await record('campaign_versions.campaignId_createdAt', () =>
    c.campaignVersions.createIndex({ campaignId: 1, createdAt: -1 }, { name: 'campaignId_createdAt' }),
  );
  await record('import_jobs.listId_createdAt', () =>
    c.importJobs.createIndex({ listId: 1, createdAt: -1 }, { name: 'listId_createdAt' }),
  );
  await record('confirmation_queue.status_leaseUntil', () =>
    c.confirmationQueue.createIndex({ status: 1, leaseUntil: 1 }, { name: 'status_leaseUntil' }),
  );
  await record('confirmation_queue.subscriberId', () =>
    c.confirmationQueue.createIndex({ subscriberId: 1 }, { name: 'subscriberId' }),
  );
  await record('rate_limits.ttl', () =>
    c.rateLimits.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl' }),
  );
  await record('sns_messages.ttl', () =>
    c.snsMessages.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl' }),
  );
  await record('test_sends.campaignId', () =>
    c.testSends.createIndex({ campaignId: 1, sentAt: -1 }, { name: 'campaignId_sentAt' }),
  );

  return created;
}
