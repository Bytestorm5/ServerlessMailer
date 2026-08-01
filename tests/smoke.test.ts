import { describe, expect, it } from 'vitest';
import { createList, createSubscriber } from '@tests/helpers/factories';
import { subscribersCollection } from '@/lib/db/collections';

describe('test harness', () => {
  it('connects to an isolated database and enforces the unique subscriber index', async () => {
    const list = await createList();
    await createSubscriber(list._id, { email: 'dupe@example.com' });

    await expect(
      createSubscriber(list._id, { email: 'dupe@example.com' }),
    ).rejects.toMatchObject({ code: 11000 });

    const count = await (await subscribersCollection()).countDocuments();
    expect(count).toBe(1);
  });
});
