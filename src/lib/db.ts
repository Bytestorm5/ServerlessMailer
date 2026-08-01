import { MongoClient, type Db, type Collection } from 'mongodb';
import { env } from './env';
import type {
  AdminDoc,
  CampaignBatchDoc,
  CampaignDoc,
  CampaignVersionDoc,
  ConfirmationQueueDoc,
  EventDoc,
  ImportJobDoc,
  ListDoc,
  RateLimitDoc,
  SentLogDoc,
  SnsMessageDoc,
  SubscriberDoc,
  SuppressionDoc,
  TestSendDoc,
} from './types';

/**
 * Serverless functions are recycled aggressively, so the client is cached on
 * the global object: a warm invocation reuses the connection pool instead of
 * paying a TLS handshake per request.
 */
declare global {
  // eslint-disable-next-line no-var
  var __mailerMongoClient: Promise<MongoClient> | undefined;
}

function createClient(): Promise<MongoClient> {
  const client = new MongoClient(env.mongoUri, {
    maxPoolSize: 10,
    minPoolSize: 0,
    retryWrites: true,
    // Fail fast rather than hold a serverless invocation open on a dead pool.
    serverSelectionTimeoutMS: 10_000,
  });
  return client.connect();
}

export function getClient(): Promise<MongoClient> {
  if (!global.__mailerMongoClient) {
    global.__mailerMongoClient = createClient();
  }
  return global.__mailerMongoClient;
}

export async function getDb(): Promise<Db> {
  const client = await getClient();
  return client.db(env.mongoDb);
}

/**
 * Asserts the indexes once per process, on first database access.
 *
 * The unique index on `sent_log` is not an optimization — it is the invariant
 * that makes a double-send impossible (§3.6). Leaving its creation to a setup
 * script means a fresh deployment runs without it until somebody remembers,
 * and the failure mode of forgetting is the one failure this system exists to
 * prevent. `createIndex` is idempotent, so the cost after the first call is a
 * no-op.
 *
 * Failures are logged rather than thrown: an index problem must not take down
 * the unsubscribe endpoint, which is the most availability-critical path in
 * the system (§9).
 */
let indexesReady: Promise<void> | undefined;
let assertingIndexes = false;

async function assertIndexesOnce(): Promise<void> {
  // `ensureIndexes` itself calls `collections()`; without this the assertion
  // would recurse into itself.
  if (assertingIndexes) return;
  if (!indexesReady) {
    assertingIndexes = true;
    indexesReady = import('./indexes')
      .then((module) => module.ensureIndexes())
      .then(() => undefined)
      .catch(async (error) => {
        indexesReady = undefined;
        const { log } = await import('./logger');
        log.error('index assertion failed', { error: String(error) });
      })
      .finally(() => {
        assertingIndexes = false;
      });
  }
  await indexesReady;
}

export const COLLECTIONS = {
  lists: 'lists',
  subscribers: 'subscribers',
  suppressions: 'suppressions',
  campaigns: 'campaigns',
  campaignBatches: 'campaign_batches',
  sentLog: 'sent_log',
  events: 'events',
  admins: 'admins',
  campaignVersions: 'campaign_versions',
  importJobs: 'import_jobs',
  confirmationQueue: 'confirmation_queue',
  rateLimits: 'rate_limits',
  snsMessages: 'sns_messages',
  testSends: 'test_sends',
} as const;

export async function collections(): Promise<{
  lists: Collection<ListDoc>;
  subscribers: Collection<SubscriberDoc>;
  suppressions: Collection<SuppressionDoc>;
  campaigns: Collection<CampaignDoc>;
  campaignBatches: Collection<CampaignBatchDoc>;
  sentLog: Collection<SentLogDoc>;
  events: Collection<EventDoc>;
  admins: Collection<AdminDoc>;
  campaignVersions: Collection<CampaignVersionDoc>;
  importJobs: Collection<ImportJobDoc>;
  confirmationQueue: Collection<ConfirmationQueueDoc>;
  rateLimits: Collection<RateLimitDoc>;
  snsMessages: Collection<SnsMessageDoc>;
  testSends: Collection<TestSendDoc>;
  db: Db;
}> {
  const db = await getDb();
  await assertIndexesOnce();
  return {
    db,
    lists: db.collection<ListDoc>(COLLECTIONS.lists),
    subscribers: db.collection<SubscriberDoc>(COLLECTIONS.subscribers),
    suppressions: db.collection<SuppressionDoc>(COLLECTIONS.suppressions),
    campaigns: db.collection<CampaignDoc>(COLLECTIONS.campaigns),
    campaignBatches: db.collection<CampaignBatchDoc>(COLLECTIONS.campaignBatches),
    sentLog: db.collection<SentLogDoc>(COLLECTIONS.sentLog),
    events: db.collection<EventDoc>(COLLECTIONS.events),
    admins: db.collection<AdminDoc>(COLLECTIONS.admins),
    campaignVersions: db.collection<CampaignVersionDoc>(COLLECTIONS.campaignVersions),
    importJobs: db.collection<ImportJobDoc>(COLLECTIONS.importJobs),
    confirmationQueue: db.collection<ConfirmationQueueDoc>(COLLECTIONS.confirmationQueue),
    rateLimits: db.collection<RateLimitDoc>(COLLECTIONS.rateLimits),
    snsMessages: db.collection<SnsMessageDoc>(COLLECTIONS.snsMessages),
    testSends: db.collection<TestSendDoc>(COLLECTIONS.testSends),
  };
}

/** MongoDB duplicate-key error. On `sent_log` this means "already sent" (§3.6). */
export function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
}
