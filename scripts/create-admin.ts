import { createInterface } from 'node:readline/promises';
import { loadEnv } from './load-env';

/** Creates or resets an admin account: `npm run create-admin [email] [password]`. */
async function main(): Promise<void> {
  loadEnv();

  const { collections, getClient } = await import('../src/lib/db');
  const { hashPassword } = await import('../src/lib/crypto');
  const { normalizeEmail } = await import('../src/lib/email-address');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const email = normalizeEmail(process.argv[2] ?? (await rl.question('Admin email: ')));
  const password = process.argv[3] ?? (await rl.question('Password: '));
  rl.close();

  if (!email || password.length < 12) {
    console.error('An email and a password of at least 12 characters are required.');
    process.exit(1);
  }

  const c = await collections();
  await c.admins.updateOne(
    { email },
    {
      $set: { passwordHash: await hashPassword(password) },
      $setOnInsert: { email, createdAt: new Date(), lastLoginAt: null },
    },
    { upsert: true },
  );

  console.log(`Admin ready: ${email}`);

  const client = await getClient();
  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
