import { MongoClient, type Db } from 'mongodb';
import { config } from '@/lib/config';

/**
 * A single MongoClient per process. Serverless invocations reuse the module
 * scope between warm starts, so caching the connection promise here is what
 * keeps connection counts sane on Atlas.
 */
let clientPromise: Promise<MongoClient> | undefined;
let cachedUri: string | undefined;

export function getMongoClient(): Promise<MongoClient> {
  const uri = config.mongoUri();
  // Tests point at a per-file database on a shared in-memory server; if the URI
  // itself changes, the cached client is for the wrong server.
  if (clientPromise && cachedUri === uri) return clientPromise;
  cachedUri = uri;
  clientPromise = new MongoClient(uri, {
    maxPoolSize: 10,
    retryWrites: true,
  }).connect();
  return clientPromise;
}

export async function getDb(): Promise<Db> {
  const client = await getMongoClient();
  return client.db(config.mongoDb());
}

export async function closeMongo(): Promise<void> {
  if (!clientPromise) return;
  const client = await clientPromise;
  clientPromise = undefined;
  cachedUri = undefined;
  await client.close();
}

/** Test-only helper; dropping a database in production is never intended. */
export async function dropTestDatabase(): Promise<void> {
  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) return;
  if (!clientPromise) return;
  const db = await getDb();
  await db.dropDatabase();
}
