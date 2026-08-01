import { MongoMemoryServer } from 'mongodb-memory-server';

/**
 * Test harness.
 *
 * Environment is set before any application module is imported, because
 * `src/lib/db` caches a client on first use. Every DB-backed test gets a real
 * mongod: the invariants under test here — the unique index on `sent_log`,
 * atomic batch claiming — are database behaviours, and a fake would be testing
 * the fake.
 */

export function setupEnv(): void {
  process.env.APP_BASE_URL = 'https://mail.test';
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.SESSION_SECRET = 'test-session-secret';
  process.env.CONFIRM_TOKEN_SECRET = 'test-confirm-secret';
  process.env.UNSUBSCRIBE_SECRET = 'test-unsubscribe-secret';
  process.env.TRACKING_SECRET = 'test-tracking-secret';
  process.env.MAILER_DRIVER = 'console';
  process.env.DISABLE_MX_CHECK = '1';
  // Keeps the pacing sleep in the send loop from dominating the test runtime
  // while still exercising the code path.
  process.env.SES_MAX_SEND_RATE = '1000';
  process.env.CRON_RUN_BUDGET_MS = '10000';
}

export interface TestDb {
  uri: string;
  stop: () => Promise<void>;
}

export async function startTestDb(): Promise<TestDb> {
  setupEnv();
  const server = await MongoMemoryServer.create();
  process.env.MONGODB_URI = server.getUri();
  process.env.MONGODB_DB = 'servlerless_mailer_test';

  const { ensureIndexes } = await import('../../src/lib/indexes');
  await ensureIndexes();

  return {
    uri: server.getUri(),
    stop: async () => {
      const { getClient } = await import('../../src/lib/db');
      const client = await getClient();
      await client.close();
      await server.stop();
    },
  };
}

export async function resetCollections(): Promise<void> {
  const { collections } = await import('../../src/lib/db');
  const c = await collections();
  await Promise.all([
    c.subscribers.deleteMany({}),
    c.suppressions.deleteMany({}),
    c.campaigns.deleteMany({}),
    c.campaignBatches.deleteMany({}),
    c.sentLog.deleteMany({}),
    c.events.deleteMany({}),
    c.lists.deleteMany({}),
    c.confirmationQueue.deleteMany({}),
    c.snsMessages.deleteMany({}),
    c.rateLimits.deleteMany({}),
  ]);
}
