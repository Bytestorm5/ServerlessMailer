import { loadEnv } from './load-env';

/**
 * Development seed: one list plus a few confirmed subscribers.
 *
 * Refuses to run against a database that already has real subscribers, and
 * refuses outright when the mailer is pointed at SES.
 */
async function main(): Promise<void> {
  loadEnv();

  const { collections, getClient } = await import('../src/lib/db');
  const { ensureIndexes } = await import('../src/lib/indexes');
  const { env } = await import('../src/lib/env');

  if (env.mailerDriver === 'ses') {
    console.error('Refusing to seed while MAILER_DRIVER=ses.');
    process.exit(1);
  }

  await ensureIndexes();
  const c = await collections();

  const existing = await c.subscribers.estimatedDocumentCount();
  if (existing > 100) {
    console.error(`Refusing to seed: ${existing} subscribers already exist.`);
    process.exit(1);
  }

  const now = new Date();
  const list = await c.lists.findOneAndUpdate(
    { name: 'Example Weekly' },
    {
      $setOnInsert: {
        name: 'Example Weekly',
        sendingDomain: 'news.example.com',
        fromName: 'Example',
        fromEmail: 'hello@news.example.com',
        replyTo: 'hello@example.com',
        physicalAddress: 'Example Ltd, 1 Example Street, Exampleton, EX1 2MP',
        sesConfigurationSet: 'example-newsletter',
        active: true,
        welcomeUrl: '',
        mergeFields: ['city'],
        seedEmails: ['seed@example.com'],
        createdAt: now,
        updatedAt: now,
      },
    },
    { upsert: true, returnDocument: 'after' },
  );

  if (!list) throw new Error('Failed to create list');

  const people = [
    { email: 'ada@example.com', first_name: 'Ada', city: 'London' },
    { email: 'grace@example.com', first_name: 'Grace', city: 'New York' },
    // Deliberately blank, so previews and test sends exercise the fallback.
    { email: 'alan@example.com', first_name: '', city: 'Wilmslow' },
    { email: 'katherine@example.com', first_name: 'Katherine', city: 'Hampton' },
  ];

  for (const person of people) {
    await c.subscribers.updateOne(
      { listId: list._id, email: person.email },
      {
        $setOnInsert: {
          listId: list._id,
          email: person.email,
          emailDomain: 'example.com',
          status: 'confirmed',
          attributes: { first_name: person.first_name, city: person.city },
          source: 'web_form',
          createdAt: now,
          updatedAt: now,
          confirmedAt: now,
          confirmIp: '127.0.0.1',
          confirmUserAgent: 'seed-script',
        },
      },
      { upsert: true },
    );
  }

  console.log(`Seeded list "${list.name}" (${String(list._id)}) with ${people.length} subscribers.`);
  console.log(`Signup form: ${env.appBaseUrl}/subscribe/${String(list._id)}`);

  const client = await getClient();
  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
