import { loadEnv } from './load-env';

/** Creates every index in §3. Safe to re-run; the daily cron also calls it. */
async function main(): Promise<void> {
  loadEnv();

  const { ensureIndexes } = await import('../src/lib/indexes');
  const { getClient } = await import('../src/lib/db');

  const created = await ensureIndexes();
  console.log(`Asserted ${created.length} indexes:`);
  for (const name of created) console.log(`  ${name}`);

  const client = await getClient();
  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
