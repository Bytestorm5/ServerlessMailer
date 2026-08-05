import { beforeEach, describe, expect, it } from 'vitest';
import { importSubscribers, type ImportResult } from '@/lib/csv/import';
import {
  importAttestationsCollection,
  subscribersCollection,
  suppressionsCollection,
} from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import { addSuppression } from '@/lib/suppressions';
import { createList, createSubscriber } from '@tests/helpers/factories';
import type { ListDoc } from '@/lib/types';

let list: ListDoc;

beforeEach(async () => {
  await ensureIndexes();
  await Promise.all([
    (await subscribersCollection()).deleteMany({}),
    (await suppressionsCollection()).deleteMany({}),
    (await importAttestationsCollection()).deleteMany({}),
  ]);
  list = await createList();
});

const ATTESTATION = {
  text: 'I confirm every address gave prior opt-in consent.',
  by: 'operator@example.com',
};

async function run(
  csv: string,
  overrides: Partial<Parameters<typeof importSubscribers>[0]> = {},
): Promise<ImportResult> {
  const result = await importSubscribers({
    listId: list._id,
    csv,
    mapping: { email: 'email' },
    markConfirmed: false,
    ...overrides,
  });
  if ('error' in result) throw new Error(result.error);
  return result;
}

async function statusOf(email: string) {
  return (await (await subscribersCollection()).findOne({ email }))?.status;
}

describe('importSubscribers — the suppression rule', () => {
  it('skips every address that is suppressed', async () => {
    // §4.3: a suppressed address must never be resurrected by a re-import.
    // This is the single most common way people destroy sender reputation.
    await addSuppression({ email: 'bounced@example.com', reason: 'hard_bounce' });
    await addSuppression({ email: 'angry@example.com', reason: 'complaint' });

    const result = await run(
      'email\nfresh@example.com\nbounced@example.com\nangry@example.com\n',
    );

    expect(result.imported).toBe(1);
    expect(result.skippedSuppressed).toBe(2);
    expect(await (await subscribersCollection()).countDocuments()).toBe(1);
    expect(await statusOf('bounced@example.com')).toBeUndefined();
  });

  it('matches suppressions regardless of case in the file', async () => {
    await addSuppression({ email: 'shouty@example.com', reason: 'complaint' });

    const result = await run('email\nSHOUTY@EXAMPLE.COM\n');

    expect(result.skippedSuppressed).toBe(1);
    expect(result.imported).toBe(0);
  });
});

describe('importSubscribers — consent state', () => {
  it('lands addresses as pending without an attestation', async () => {
    const result = await run('email\nnew@example.com\n');

    expect(result.imported).toBe(1);
    expect(await statusOf('new@example.com')).toBe('pending');
  });

  it('refuses to import as confirmed without an attestation', async () => {
    const result = await importSubscribers({
      listId: list._id,
      csv: 'email\nnew@example.com\n',
      mapping: { email: 'email' },
      markConfirmed: true,
    });

    expect('error' in result).toBe(true);
    expect(await (await subscribersCollection()).countDocuments()).toBe(0);
  });

  it('imports as confirmed when the operator attests, and logs the wording verbatim', async () => {
    const result = await run('email\nmigrated@example.com\n', {
      markConfirmed: true,
      attestation: ATTESTATION,
      filename: 'squarespace-export.csv',
    });

    expect(await statusOf('migrated@example.com')).toBe('confirmed');

    const attestation = await (await importAttestationsCollection()).findOne({});
    expect(attestation?.attestationText).toBe(ATTESTATION.text);
    expect(attestation?.attestedBy).toBe(ATTESTATION.by);
    expect(attestation?.importedAsConfirmed).toBe(true);
    expect(attestation?.filename).toBe('squarespace-export.csv');
    expect(result.attestationId).toBeDefined();
  });

  it('never resurrects someone who unsubscribed', async () => {
    // Re-importing an old export must not undo an opt-out.
    await createSubscriber(list._id, {
      email: 'gone@example.com',
      status: 'unsubscribed',
      unsubscribedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const result = await run('email\ngone@example.com\n', {
      markConfirmed: true,
      attestation: ATTESTATION,
    });

    expect(result.skippedTombstoned).toBe(1);
    expect(await statusOf('gone@example.com')).toBe('unsubscribed');
  });

  it.each(['bounced', 'complained'] as const)(
    'never resurrects a %s address',
    async (status) => {
      await createSubscriber(list._id, { email: `${status}@example.com`, status });

      await run(`email\n${status}@example.com\n`, {
        markConfirmed: true,
        attestation: ATTESTATION,
      });

      expect(await statusOf(`${status}@example.com`)).toBe(status);
    },
  );

  it('does not overwrite an existing confirmation timestamp', async () => {
    const original = new Date('2024-05-05T00:00:00.000Z');
    await createSubscriber(list._id, {
      email: 'longtime@example.com',
      status: 'confirmed',
      confirmedAt: original,
      confirmIp: '203.0.113.99',
    });

    await run('email\nlongtime@example.com\n', {
      markConfirmed: true,
      attestation: ATTESTATION,
    });

    const doc = await (await subscribersCollection()).findOne({ email: 'longtime@example.com' });
    expect(doc?.confirmedAt).toEqual(original);
    expect(doc?.confirmIp).toBe('203.0.113.99');
  });

  it('promotes a pending subscriber when the operator attests', async () => {
    await createSubscriber(list._id, { email: 'waiting@example.com', status: 'pending' });

    const result = await run('email\nwaiting@example.com\n', {
      markConfirmed: true,
      attestation: ATTESTATION,
    });

    expect(result.updated).toBe(1);
    expect(await statusOf('waiting@example.com')).toBe('confirmed');
  });
});

describe('importSubscribers — idempotency', () => {
  it('re-importing the same file changes nothing', async () => {
    const csv = 'email,first_name\na@example.com,Ada\nb@example.com,Bob\n';
    const mapping = { email: 'email', attributes: { first_name: 'first_name' } };

    const first = await run(csv, { mapping });
    const second = await run(csv, { mapping });

    expect(first.imported).toBe(2);
    expect(second.imported).toBe(0);
    expect(second.updated).toBe(2);
    expect(await (await subscribersCollection()).countDocuments()).toBe(2);
  });

  it('updates attributes on re-import without duplicating anyone', async () => {
    const mapping = { email: 'email', attributes: { first_name: 'first_name' } };
    await run('email,first_name\na@example.com,Ada\n', { mapping });
    await run('email,first_name\na@example.com,Augusta\n', { mapping });

    const doc = await (await subscribersCollection()).findOne({ email: 'a@example.com' });
    expect(doc?.firstName).toBe('Augusta');
    expect(await (await subscribersCollection()).countDocuments()).toBe(1);
  });

  it('keeps the same address on a different list separate', async () => {
    const other = await createList({ name: 'Domain B' });
    await run('email\nboth@example.com\n');
    await run('email\nboth@example.com\n', { listId: other._id });

    expect(await (await subscribersCollection()).countDocuments()).toBe(2);
  });
});

describe('importSubscribers — malformed rows are reported, not dropped', () => {
  it('reports each invalid address with its row number', async () => {
    // Two columns so an empty email cell is unambiguous rather than a blank line.
    const result = await run(
      [
        'email,first_name',
        'good@example.com,Ada',
        'not-an-email,Bob',
        ',Carol',
        'also bad@,Dan',
        'fine@example.com,Eve',
      ].join('\n'),
    );

    expect(result.imported).toBe(2);
    expect(result.errors).toHaveLength(3);
    // Row numbers are 1-based and account for the header row, so the operator
    // can find the offending line in their spreadsheet.
    expect(result.errors.map((e) => e.row).sort((a, b) => a - b)).toEqual([3, 4, 5]);
    expect(result.errors.some((e) => /valid email/i.test(e.reason))).toBe(true);
    expect(result.errors.some((e) => /no email/i.test(e.reason))).toBe(true);
  });

  it('reports duplicates within the same file', async () => {
    const result = await run('email\ndupe@example.com\ndupe@example.com\n');

    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toMatch(/duplicate/i);
  });

  it('rejects a file with no matching email column', async () => {
    const result = await importSubscribers({
      listId: list._id,
      csv: 'address\na@example.com\n',
      mapping: { email: 'email' },
      markConfirmed: false,
    });

    expect(result).toMatchObject({ error: expect.stringContaining('email') });
  });

  it('rejects an empty file', async () => {
    const result = await importSubscribers({
      listId: list._id,
      csv: '',
      mapping: { email: 'email' },
      markConfirmed: false,
    });

    expect('error' in result).toBe(true);
  });
});

describe('importSubscribers — attribute mapping', () => {
  it('maps only the columns it was told to map', async () => {
    const result = await run('email,first_name,secret\na@example.com,Ada,hunter2\n', {
      mapping: { email: 'email', attributes: { first_name: 'first_name' } },
    });

    expect(result.imported).toBe(1);
    const doc = await (await subscribersCollection()).findOne({ email: 'a@example.com' });
    // Name columns land on the first-party fields, not in the attribute map.
    expect(doc?.firstName).toBe('Ada');
    expect(doc?.attributes).toEqual({});
  });

  it('stores mapped name columns first-party and the rest as attributes', async () => {
    await run('email,fn,ln,employer\na@example.com,Ada,Lovelace,Analytical Engines\n', {
      mapping: {
        email: 'email',
        attributes: { fn: 'first_name', ln: 'last_name', employer: 'company' },
      },
    });

    const doc = await (await subscribersCollection()).findOne({ email: 'a@example.com' });
    expect(doc?.firstName).toBe('Ada');
    expect(doc?.lastName).toBe('Lovelace');
    expect(doc?.attributes).toEqual({ company: 'Analytical Engines' });
  });

  it('ignores an attribute key that could reach outside the attributes subdocument', async () => {
    await run('email,evil\na@example.com,value\n', {
      mapping: { email: 'email', attributes: { evil: 'status' } },
    });

    // 'status' is a safe key name, but it must land under attributes, not at the
    // document root where it would overwrite the subscriber's real status.
    const doc = await (await subscribersCollection()).findOne({ email: 'a@example.com' });
    expect(doc?.status).toBe('pending');
    expect(doc?.attributes.status).toBe('value');
  });

  it('handles quoted fields containing commas', async () => {
    await run('email,company\na@example.com,"Acme, Inc."\n', {
      mapping: { email: 'email', attributes: { company: 'company' } },
    });

    const doc = await (await subscribersCollection()).findOne({ email: 'a@example.com' });
    expect(doc?.attributes.company).toBe('Acme, Inc.');
  });

  it('records the source as import', async () => {
    await run('email\na@example.com\n');
    const doc = await (await subscribersCollection()).findOne({ email: 'a@example.com' });
    expect(doc?.source).toBe('import');
  });
});
