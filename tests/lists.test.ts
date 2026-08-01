import { beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import {
  ListValidationError,
  createList,
  deleteList,
  getList,
  listSummaries,
  serializeList,
  updateList,
  validateListInput,
  type ListInput,
} from '@/lib/lists';
import {
  campaignsCollection,
  importAttestationsCollection,
  listsCollection,
  seedAddressesCollection,
  subscribersCollection,
} from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import {
  createCampaign,
  createList as seedList,
  createSubscriber,
} from '@tests/helpers/factories';

/**
 * List configuration (§3.1). The rules that matter are the ones that would
 * otherwise fail later and louder: an unusable sending identity, a From address
 * SES will reject for every recipient at once, and deleting a list that
 * subscribers and campaigns still point at.
 */

const VALID: ListInput = {
  name: 'Domain A Weekly',
  sendingDomain: 'news.domain-a.com',
  fromName: 'Domain A',
  fromEmail: 'hello@news.domain-a.com',
  replyTo: 'hello@domain-a.com',
  physicalAddress: '1 Example Street, London, EC1A 1AA, United Kingdom',
  sesConfigurationSet: 'domain-a-config',
  active: true,
  welcomeUrl: 'https://domain-a.com/welcome',
};

beforeEach(async () => {
  await ensureIndexes();
  await Promise.all([
    (await listsCollection()).deleteMany({}),
    (await subscribersCollection()).deleteMany({}),
    (await campaignsCollection()).deleteMany({}),
    (await seedAddressesCollection()).deleteMany({}),
    (await importAttestationsCollection()).deleteMany({}),
  ]);
});

describe('validateListInput', () => {
  it('normalizes the sending identity', () => {
    const fields = validateListInput({
      ...VALID,
      // Trailing root dot and mixed case are two spellings of one domain; SES
      // compares identities as strings, so they must not both be storable.
      sendingDomain: '  News.Domain-A.com. ',
      fromEmail: '  Hello@News.Domain-A.com ',
      name: '  Domain A Weekly  ',
    });

    expect(fields.sendingDomain).toBe('news.domain-a.com');
    expect(fields.fromEmail).toBe('hello@news.domain-a.com');
    expect(fields.name).toBe('Domain A Weekly');
  });

  it('accepts a From address on a subdomain of the verified identity', () => {
    // An SES domain identity covers its subdomains.
    expect(() =>
      validateListInput({ ...VALID, fromEmail: 'hello@mail.news.domain-a.com' }),
    ).not.toThrow();
  });

  it('rejects a From address outside the sending domain', () => {
    expect(() => validateListInput({ ...VALID, fromEmail: 'hello@elsewhere.com' })).toThrow(
      /verified SES identity/,
    );
  });

  it('rejects a From address that merely ends with the sending domain', () => {
    // `evil-news.domain-a.com` is not covered by `news.domain-a.com`.
    expect(() =>
      validateListInput({ ...VALID, fromEmail: 'hello@evilnews.domain-a.com' }),
    ).toThrow(ListValidationError);
  });

  it.each([
    ['name', { name: '   ' }, /name is required/],
    ['name length', { name: 'x'.repeat(121) }, /120 characters/],
    ['sendingDomain', { sendingDomain: '' }, /sendingDomain is required/],
    ['sendingDomain syntax', { sendingDomain: 'https://news.domain-a.com/' }, /bare hostname/],
    ['fromName', { fromName: '' }, /fromName is required/],
    ['fromEmail', { fromEmail: 'not-an-email' }, /valid email/],
    ['replyTo', { replyTo: 'nope@' }, /replyTo must be a valid email/],
    ['physicalAddress', { physicalAddress: '' }, /physicalAddress is required/],
    ['physicalAddress length', { physicalAddress: 'x'.repeat(501) }, /500 characters/],
    ['sesConfigurationSet', { sesConfigurationSet: '' }, /sesConfigurationSet is required/],
    ['welcomeUrl', { welcomeUrl: 'javascript:alert(1)' }, /http\(s\) URL/],
  ])('rejects a bad %s', (_label, patch, expected) => {
    expect(() => validateListInput({ ...VALID, ...patch })).toThrow(expected as RegExp);
  });

  it('treats a blank welcomeUrl as absent rather than invalid', () => {
    const fields = validateListInput({ ...VALID, welcomeUrl: '  ' });
    expect('welcomeUrl' in fields).toBe(false);
  });

  it('defaults active to true and honours an explicit false', () => {
    expect(validateListInput({ ...VALID, active: undefined }).active).toBe(true);
    expect(validateListInput({ ...VALID, active: false }).active).toBe(false);
  });
});

describe('createList', () => {
  it('stores a validated document', async () => {
    const now = new Date('2026-03-01T00:00:00.000Z');
    const list = await createList(VALID, now);

    const stored = await getList(list._id);
    expect(stored?.name).toBe('Domain A Weekly');
    expect(stored?.createdAt).toEqual(now);
    expect(stored?.active).toBe(true);
    expect(serializeList(stored!).id).toBe(list._id.toHexString());
  });

  it('refuses an invalid document without writing anything', async () => {
    await expect(createList({ ...VALID, fromEmail: 'x@other.com' })).rejects.toThrow(
      ListValidationError,
    );
    expect(await (await listsCollection()).countDocuments({})).toBe(0);
  });
});

describe('updateList', () => {
  it('merges a partial patch onto the stored document', async () => {
    const list = await createList(VALID);
    const updated = await updateList(list._id, { fromName: 'Domain A Newsletter' });

    expect(updated?.fromName).toBe('Domain A Newsletter');
    // Untouched fields survive a one-field patch.
    expect(updated?.sendingDomain).toBe('news.domain-a.com');
    expect(updated?.physicalAddress).toBe(VALID.physicalAddress);
  });

  it('re-validates the merged result, not just the patch', async () => {
    const list = await createList(VALID);
    // The new domain is valid in isolation; it is the stored fromEmail that
    // makes the *result* unsendable, which is exactly what merge-then-validate
    // is for.
    await expect(updateList(list._id, { sendingDomain: 'news.domain-b.com' })).rejects.toThrow(
      /verified SES identity/,
    );

    const unchanged = await getList(list._id);
    expect(unchanged?.sendingDomain).toBe('news.domain-a.com');
  });

  it('accepts a coordinated change of both halves of the pair', async () => {
    const list = await createList(VALID);
    const updated = await updateList(list._id, {
      sendingDomain: 'news.domain-b.com',
      fromEmail: 'hello@news.domain-b.com',
    });
    expect(updated?.sendingDomain).toBe('news.domain-b.com');
  });

  it('clears welcomeUrl when it is blanked', async () => {
    const list = await createList(VALID);
    const updated = await updateList(list._id, { welcomeUrl: '' });
    expect(updated?.welcomeUrl).toBeUndefined();
    expect(serializeList(updated!).welcomeUrl).toBeNull();
  });

  it('toggles active', async () => {
    const list = await createList(VALID);
    expect((await updateList(list._id, { active: false }))?.active).toBe(false);
    expect((await updateList(list._id, { active: true }))?.active).toBe(true);
  });

  it('returns null for a list that does not exist', async () => {
    expect(await updateList(new ObjectId(), { fromName: 'x' })).toBeNull();
  });
});

describe('deleteList', () => {
  it('deletes a list nothing references', async () => {
    const list = await createList(VALID);
    expect(await deleteList(list._id)).toEqual({ deleted: true });
    expect(await getList(list._id)).toBeNull();
  });

  it('refuses a list that still has subscribers', async () => {
    const list = await seedList();
    await createSubscriber(list._id, { email: 'a@example.com' });

    const result = await deleteList(list._id);
    expect(result.deleted).toBe(false);
    if (result.deleted || result.reason !== 'in_use') throw new Error('expected in_use');
    expect(result.subscribers).toBe(1);
    // The refusal names the reversible alternative.
    expect(result.message).toMatch(/Deactivate the list instead/);
    expect(await getList(list._id)).not.toBeNull();
  });

  it('refuses a list that still has campaigns', async () => {
    const list = await seedList();
    await createCampaign(list._id);

    const result = await deleteList(list._id);
    if (result.deleted || result.reason !== 'in_use') throw new Error('expected in_use');
    expect(result.campaigns).toBe(1);
  });

  it('counts unsubscribed subscribers as references', async () => {
    const list = await seedList();
    // Consent evidence outlives the subscription, so an unsubscribed record
    // still blocks deletion.
    await createSubscriber(list._id, { email: 'gone@example.com', status: 'unsubscribed' });

    const result = await deleteList(list._id);
    expect(result.deleted).toBe(false);
  });

  it('removes seed addresses and import attestations alongside the list', async () => {
    const list = await createList(VALID);
    await (await seedAddressesCollection()).insertOne({
      _id: new ObjectId(),
      listId: list._id,
      email: 'seed@example.com',
      createdAt: new Date(),
    });
    await (await importAttestationsCollection()).insertOne({
      _id: new ObjectId(),
      listId: list._id,
      attestationText: 'prior opt-in consent',
      attestedBy: 'admin',
      attestedAt: new Date(),
      filename: 'import.csv',
      rowCount: 1,
      importedAsConfirmed: true,
    });

    expect(await deleteList(list._id)).toEqual({ deleted: true });
    expect(await (await seedAddressesCollection()).countDocuments({ listId: list._id })).toBe(0);
    expect(
      await (await importAttestationsCollection()).countDocuments({ listId: list._id }),
    ).toBe(0);
  });

  it('reports a missing list rather than claiming a deletion', async () => {
    expect(await deleteList(new ObjectId())).toEqual({ deleted: false, reason: 'not_found' });
  });
});

describe('listSummaries', () => {
  it('returns per-list counts, sorted by name', async () => {
    const a = await createList({ ...VALID, name: 'Zebra Weekly' });
    const b = await createList({
      ...VALID,
      name: 'Alpha Monthly',
      sendingDomain: 'news.domain-b.com',
      fromEmail: 'hello@news.domain-b.com',
    });

    await createSubscriber(a._id, { email: 'one@example.com', status: 'confirmed' });
    await createSubscriber(a._id, { email: 'two@example.com', status: 'pending' });
    await createSubscriber(a._id, { email: 'three@example.com', status: 'unsubscribed' });
    await createCampaign(a._id);

    const summaries = await listSummaries();
    expect(summaries.map((s) => s.list.name)).toEqual(['Alpha Monthly', 'Zebra Weekly']);

    const zebra = summaries.find((s) => s.list._id.equals(a._id))!;
    expect(zebra).toMatchObject({ confirmed: 1, pending: 1, unsubscribed: 1, campaigns: 1 });

    const alpha = summaries.find((s) => s.list._id.equals(b._id))!;
    expect(alpha).toMatchObject({ confirmed: 0, pending: 0, campaigns: 0 });
  });
});
