import { MongoMemoryServer } from 'mongodb-memory-server';

let mongod: MongoMemoryServer | undefined;

export async function setup() {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  // Vitest forwards provided values to workers via `inject`, but env is simpler
  // and every module under test reads the URI from env anyway.
  process.env.__MONGO_URI__ = mongod.getUri();
}

export async function teardown() {
  await mongod?.stop();
}
