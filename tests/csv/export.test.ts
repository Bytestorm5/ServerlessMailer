import { beforeEach, describe, expect, it } from 'vitest';
import { exportSubscribersCsv, exportSuppressionsCsv } from '@/lib/csv/export';
import { parseCsv } from '@/lib/csv/parse';
import { subscribersCollection, suppressionsCollection } from '@/lib/db/collections';
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
  ]);
  list = await createList();
});

describe('exportSubscribersCsv', () => {
  it('includes status and the full consent evidence', async () => {
    // §4.4 and §5.3: consent evidence is included in subscriber export, because
    // it is what you produce if a complaint is escalated.
    await createSubscriber(list._id, {
      email: 'ada@example.com',
      status: 'confirmed',
      confirmedAt: new Date('2026-03-01T10:00:00.000Z'),
      confirmIp: '203.0.113.7',
      confirmUserAgent: 'Mozilla/5.0 (test)',
    });

    const { headers, rows } = parseCsv(await exportSubscribersCsv({ listId: list._id }));

    expect(headers).toEqual(
      expect.arrayContaining([
        'email',
        'status',
        'source',
        'created_at',
        'confirmed_at',
        'confirm_ip',
        'confirm_user_agent',
        'unsubscribed_at',
        'unsubscribe_source',
      ]),
    );

    const row = Object.fromEntries(headers.map((header, i) => [header, rows[0][i]]));
    expect(row.email).toBe('ada@example.com');
    expect(row.status).toBe('confirmed');
    expect(row.confirmed_at).toBe('2026-03-01T10:00:00.000Z');
    expect(row.confirm_ip).toBe('203.0.113.7');
    expect(row.confirm_user_agent).toBe('Mozilla/5.0 (test)');
  });

  it('exports first-party names, falling back to legacy attribute storage', async () => {
    await createSubscriber(list._id, {
      email: 'first-party@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    await createSubscriber(list._id, {
      email: 'legacy@example.com',
      attributes: { first_name: 'Grace', last_name: 'Hopper' },
    });

    const { headers, rows } = parseCsv(await exportSubscribersCsv({ listId: list._id }));
    expect(headers).toEqual(expect.arrayContaining(['first_name', 'last_name']));
    // No duplicate columns for the legacy attribute keys.
    expect(headers.filter((h) => h === 'first_name')).toHaveLength(1);

    const byEmail = new Map(
      rows.map((row) => [
        row[headers.indexOf('email')],
        Object.fromEntries(headers.map((header, i) => [header, row[i]])),
      ]),
    );
    expect(byEmail.get('first-party@example.com')?.first_name).toBe('Ada');
    expect(byEmail.get('first-party@example.com')?.last_name).toBe('Lovelace');
    expect(byEmail.get('legacy@example.com')?.first_name).toBe('Grace');
    expect(byEmail.get('legacy@example.com')?.last_name).toBe('Hopper');
  });

  it('exports every status, not only the mailable ones', async () => {
    for (const status of ['confirmed', 'pending', 'unsubscribed', 'bounced'] as const) {
      await createSubscriber(list._id, { email: `${status}@example.com`, status });
    }

    const { rows } = parseCsv(await exportSubscribersCsv({ listId: list._id }));
    expect(rows).toHaveLength(4);
  });

  it('can be filtered to a single status', async () => {
    await createSubscriber(list._id, { email: 'a@example.com', status: 'confirmed' });
    await createSubscriber(list._id, { email: 'b@example.com', status: 'unsubscribed' });

    const { rows } = parseCsv(
      await exportSubscribersCsv({ listId: list._id, status: 'unsubscribed' }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toBe('b@example.com');
  });

  it('includes every attribute as its own column', async () => {
    await createSubscriber(list._id, {
      email: 'a@example.com',
      attributes: { first_name: 'Ada', city: 'London' },
    });
    await createSubscriber(list._id, {
      email: 'b@example.com',
      attributes: { first_name: 'Bob', country: 'UK' },
    });

    const { headers, rows } = parseCsv(await exportSubscribersCsv({ listId: list._id }));

    // The union across the export, so nothing is silently dropped.
    expect(headers).toEqual(expect.arrayContaining(['first_name', 'city', 'country']));
    const byEmail = new Map(rows.map((row) => [row[0], row]));
    const cityIndex = headers.indexOf('city');
    expect(byEmail.get('a@example.com')![cityIndex]).toBe('London');
    expect(byEmail.get('b@example.com')![cityIndex]).toBe('');
  });

  it('excludes other lists', async () => {
    const other = await createList({ name: 'Domain B' });
    await createSubscriber(list._id, { email: 'mine@example.com' });
    await createSubscriber(other._id, { email: 'theirs@example.com' });

    const { rows } = parseCsv(await exportSubscribersCsv({ listId: list._id }));
    expect(rows.map((r) => r[0])).toEqual(['mine@example.com']);
  });

  it('round-trips a value containing a comma and a quote', async () => {
    await createSubscriber(list._id, {
      email: 'tricky@example.com',
      attributes: { company: 'Acme, "The" Inc.' },
    });

    const { headers, rows } = parseCsv(await exportSubscribersCsv({ listId: list._id }));
    const index = headers.indexOf('company');
    expect(rows[0][index]).toBe('Acme, "The" Inc.');
  });

  it('neutralises a value that would otherwise become a spreadsheet formula', async () => {
    // Opening an export in Excel must not execute anything.
    await createSubscriber(list._id, {
      email: 'formula@example.com',
      attributes: { first_name: '=cmd|\'/c calc\'!A0' },
    });

    const csv = await exportSubscribersCsv({ listId: list._id });
    expect(csv).not.toMatch(/(^|,|")=cmd/);
  });

  it('produces a header row even when the list is empty', async () => {
    const { headers, rows } = parseCsv(await exportSubscribersCsv({ listId: list._id }));
    expect(headers).toContain('email');
    expect(rows).toHaveLength(0);
  });

  it('can export a segment', async () => {
    await createSubscriber(list._id, {
      email: 'london@example.com',
      attributes: { city: 'London' },
    });
    await createSubscriber(list._id, {
      email: 'paris@example.com',
      attributes: { city: 'Paris' },
    });

    const { rows } = parseCsv(
      await exportSubscribersCsv({
        listId: list._id,
        query: { attributeEquals: [{ key: 'city', value: 'London' }] },
      }),
    );

    expect(rows.map((r) => r[0])).toEqual(['london@example.com']);
  });
});

describe('exportSuppressionsCsv', () => {
  it('exports the suppression list separately with reason and origin', async () => {
    await addSuppression({
      email: 'bounced@example.com',
      reason: 'hard_bounce',
      detail: 'smtp; 550 5.1.1 user unknown',
      now: new Date('2026-02-02T00:00:00.000Z'),
    });

    const { headers, rows } = parseCsv(await exportSuppressionsCsv());

    expect(headers).toEqual(['email', 'reason', 'created_at', 'source_campaign_id', 'detail']);
    expect(rows[0][0]).toBe('bounced@example.com');
    expect(rows[0][1]).toBe('hard_bounce');
    expect(rows[0][4]).toBe('smtp; 550 5.1.1 user unknown');
  });

  it('produces a header row when nothing is suppressed', async () => {
    const { headers, rows } = parseCsv(await exportSuppressionsCsv());
    expect(headers[0]).toBe('email');
    expect(rows).toHaveLength(0);
  });
});
