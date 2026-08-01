import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createList } from './helpers/fixtures';
import { resetCollections, startTestDb, type TestDb } from './helpers/setup';
import { collections } from '../src/lib/db';
import { confirmSubscriber, upsertPendingSubscriber, upsertImportedSubscriber } from '../src/lib/subscribers';
import { isSuppressed, suppress, suppressedSubset } from '../src/lib/suppressions';
import { applyUnsubscribe, signUnsubscribeToken, verifyUnsubscribeToken } from '../src/lib/unsubscribe';
import { processImportChunk, createImportJob, mapRow } from '../src/lib/import';

/** Double opt-in (§5), suppression (§3.3) and import (§4.3). */

let db: TestDb;

before(async () => {
  db = await startTestDb();
});

after(async () => {
  await db.stop();
});

beforeEach(async () => {
  await resetCollections();
});

describe('double opt-in (§5)', () => {
  it('creates a pending subscriber and mints exactly one token', async () => {
    const list = await createList();
    const result = await upsertPendingSubscriber({
      listId: list._id,
      email: 'New.Person@Example.COM',
      source: 'web_form',
    });

    assert.ok(result.token, 'no confirmation token issued');
    assert.equal(result.subscriber.status, 'pending');
    assert.equal(result.subscriber.email, 'new.person@example.com', 'address was not normalized');
    assert.equal(result.subscriber.emailDomain, 'example.com');
  });

  it('stores only the hash of the token, never the token itself', async () => {
    const list = await createList();
    const result = await upsertPendingSubscriber({ listId: list._id, email: 'a@example.com', source: 'web_form' });

    const c = await collections();
    const stored = await c.subscribers.findOne({ email: 'a@example.com' });
    assert.ok(stored?.confirmTokenHash);
    assert.notEqual(stored.confirmTokenHash, result.token);
    assert.ok(!JSON.stringify(stored).includes(result.token as string), 'the raw token leaked into the document');
  });

  it('confirms with the token and records consent evidence', async () => {
    const list = await createList();
    const { token } = await upsertPendingSubscriber({
      listId: list._id,
      email: 'a@example.com',
      source: 'web_form',
    });

    const result = await confirmSubscriber({
      token: token as string,
      ip: '203.0.113.9',
      userAgent: 'Mozilla/5.0 (test)',
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.subscriber.status, 'confirmed');
    assert.equal(result.ok && result.subscriber.confirmIp, '203.0.113.9');
    assert.equal(result.ok && result.subscriber.confirmUserAgent, 'Mozilla/5.0 (test)');
    assert.ok(result.ok && result.subscriber.confirmedAt instanceof Date);
    assert.equal(result.ok && result.subscriber.confirmTokenHash, null, 'token was not cleared');
  });

  it('rejects an unknown token', async () => {
    const result = await confirmSubscriber({ token: 'not-a-real-token', ip: '1.2.3.4', userAgent: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'unknown');
  });

  it('rejects an expired token', async () => {
    const list = await createList();
    const { token, subscriber } = await upsertPendingSubscriber({
      listId: list._id,
      email: 'a@example.com',
      source: 'web_form',
    });

    const c = await collections();
    await c.subscribers.updateOne(
      { _id: subscriber._id },
      { $set: { confirmTokenExpiresAt: new Date(Date.now() - 1000) } },
    );

    const result = await confirmSubscriber({ token: token as string, ip: '1.2.3.4', userAgent: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'expired');
  });

  it('does not re-issue a token for an already-confirmed address', async () => {
    const list = await createList();
    const first = await upsertPendingSubscriber({ listId: list._id, email: 'a@example.com', source: 'web_form' });
    await confirmSubscriber({ token: first.token as string, ip: '1.1.1.1', userAgent: 'x' });

    const second = await upsertPendingSubscriber({ listId: list._id, email: 'a@example.com', source: 'web_form' });
    assert.equal(second.token, null);
    assert.equal(second.alreadyConfirmed, true);
    assert.equal(second.subscriber.status, 'confirmed', 'a repeat signup must not reset consent');
  });

  it('rate limits confirmation resends to once per interval', async () => {
    const list = await createList();
    const first = await upsertPendingSubscriber({ listId: list._id, email: 'a@example.com', source: 'web_form' });
    assert.ok(first.token);

    const second = await upsertPendingSubscriber({ listId: list._id, email: 'a@example.com', source: 'web_form' });
    assert.equal(second.token, null);
    assert.equal(second.rateLimited, true);
  });

  it('preserves the original consent evidence when someone resubscribes', async () => {
    const list = await createList();
    const first = await upsertPendingSubscriber({ listId: list._id, email: 'a@example.com', source: 'web_form' });
    const confirmed = await confirmSubscriber({ token: first.token as string, ip: '10.0.0.1', userAgent: 'first' });
    const originalConfirmedAt = confirmed.ok ? confirmed.subscriber.confirmedAt : null;

    await applyUnsubscribe(confirmed.ok ? confirmed.subscriber._id : '', 'one_click');

    const c = await collections();
    await c.subscribers.updateOne({ email: 'a@example.com' }, { $set: { confirmEmailSentAt: null } });
    const again = await upsertPendingSubscriber({ listId: list._id, email: 'a@example.com', source: 'web_form' });
    const reconfirmed = await confirmSubscriber({ token: again.token as string, ip: '10.0.0.2', userAgent: 'second' });

    assert.equal(reconfirmed.ok && reconfirmed.subscriber.confirmIp, '10.0.0.1', 'consent evidence was overwritten');
    assert.deepEqual(reconfirmed.ok && reconfirmed.subscriber.confirmedAt, originalConfirmedAt);
  });
});

describe('unsubscribe (§9)', () => {
  it('round-trips a token and rejects a tampered one', () => {
    const subscriberId = '507f1f77bcf86cd799439011';
    const campaignId = '507f191e810c19729de860ea';
    const token = signUnsubscribeToken(subscriberId, campaignId);

    const payload = verifyUnsubscribeToken(token);
    assert.equal(payload?.subscriberId, subscriberId);
    assert.equal(payload?.campaignId, campaignId);

    assert.equal(verifyUnsubscribeToken(token.slice(0, -2) + 'xy'), null);
    assert.equal(verifyUnsubscribeToken('garbage'), null);
    assert.equal(verifyUnsubscribeToken(''), null);
  });

  it('handles a token with no campaign', () => {
    const token = signUnsubscribeToken('507f1f77bcf86cd799439011', null);
    assert.equal(verifyUnsubscribeToken(token)?.campaignId, null);
  });

  it('is idempotent, because mail clients retry one-click requests', async () => {
    const list = await createList();
    const { token, subscriber } = await upsertPendingSubscriber({
      listId: list._id,
      email: 'a@example.com',
      source: 'web_form',
    });
    await confirmSubscriber({ token: token as string, ip: '1.1.1.1', userAgent: 'x' });

    const first = await applyUnsubscribe(subscriber._id, 'one_click');
    const second = await applyUnsubscribe(subscriber._id, 'one_click');

    assert.equal(first.ok, true);
    assert.equal(first.alreadyUnsubscribed, false);
    assert.equal(second.ok, true);
    assert.equal(second.alreadyUnsubscribed, true);
  });

  it('does not add the address to global suppressions (§9)', async () => {
    const list = await createList();
    const { subscriber } = await upsertPendingSubscriber({
      listId: list._id,
      email: 'a@example.com',
      source: 'web_form',
    });

    await applyUnsubscribe(subscriber._id, 'one_click');

    assert.equal(await isSuppressed('a@example.com'), false, 'unsubscribe is a preference, not a bounce');
    const c = await collections();
    assert.equal((await c.subscribers.findOne({ _id: subscriber._id }))?.status, 'unsubscribed');
  });
});

describe('suppressions (§3.3)', () => {
  it('is idempotent and keeps the original reason', async () => {
    const first = await suppress({ email: 'x@example.com', reason: 'hard_bounce', detail: 'first' });
    const second = await suppress({ email: 'x@example.com', reason: 'manual', detail: 'second' });

    assert.equal(first.created, true);
    assert.equal(second.created, false);

    const c = await collections();
    const record = await c.suppressions.findOne({ email: 'x@example.com' });
    assert.equal(record?.reason, 'hard_bounce');
    assert.equal(record?.detail, 'first');
  });

  it('answers bulk membership questions', async () => {
    await suppress({ email: 'a@example.com', reason: 'complaint' });
    await suppress({ email: 'c@example.com', reason: 'manual' });

    const found = await suppressedSubset(['a@example.com', 'b@example.com', 'C@example.com']);
    assert.equal(found.has('a@example.com'), true);
    assert.equal(found.has('b@example.com'), false);
    assert.equal(found.has('c@example.com'), true, 'lookup must normalize case');
  });
});

describe('import (§4.3)', () => {
  it('maps columns to fields and attributes', () => {
    const mapped = mapRow(
      { 'Email Address': ' Ada@Example.com ', 'First Name': 'Ada', Notes: 'ignored' },
      { email: 'Email Address', first_name: 'First Name' },
    );
    assert.equal(mapped.email, 'ada@example.com');
    assert.deepEqual(mapped.attributes, { first_name: 'Ada' });
  });

  it('never resurrects a suppressed address', async () => {
    const list = await createList();
    await suppress({ email: 'bounced@example.com', reason: 'hard_bounce' });

    const job = await createImportJob({
      listId: list._id,
      filename: 'test.csv',
      mapping: { email: 'email' },
      attested: true,
      attestedBy: 'operator@test.com',
    });

    const result = await processImportChunk(
      job,
      [{ email: 'bounced@example.com' }, { email: 'fine@example.com' }],
      2,
    );

    assert.equal(result.suppressed, 1);
    assert.equal(result.created, 1);

    const c = await collections();
    assert.equal(await c.subscribers.countDocuments({ email: 'bounced@example.com' }), 0);
    assert.ok(result.errors.some((error) => error.reason.includes('suppression list')));
  });

  it('reports malformed rows rather than dropping them silently', async () => {
    const list = await createList();
    const job = await createImportJob({
      listId: list._id,
      filename: 'test.csv',
      mapping: { email: 'email' },
      attested: true,
      attestedBy: 'operator@test.com',
    });

    const result = await processImportChunk(job, [{ email: 'not-an-email' }, { email: '' }], 2);

    assert.equal(result.invalid, 2);
    assert.equal(result.created, 0);
    assert.equal(result.errors.length, 2);
  });

  it('is idempotent on (listId, email) and never resets consent', async () => {
    const list = await createList();
    const job = await createImportJob({
      listId: list._id,
      filename: 'test.csv',
      mapping: { email: 'email', first_name: 'name' },
      attested: true,
      attestedBy: 'operator@test.com',
    });

    await processImportChunk(job, [{ email: 'a@example.com', name: 'Ada' }], 2);

    const c = await collections();
    const first = await c.subscribers.findOne({ email: 'a@example.com' });
    assert.equal(first?.status, 'confirmed');
    assert.equal(first?.attributes.first_name, 'Ada');

    // The same person unsubscribes, then appears in a later import.
    await applyUnsubscribe(first!._id, 'one_click');
    const second = await processImportChunk(job, [{ email: 'a@example.com', name: 'Ada Lovelace' }], 2);

    assert.equal(second.created, 0);
    assert.equal(second.updated, 1);
    const after = await c.subscribers.findOne({ email: 'a@example.com' });
    assert.equal(after?.status, 'unsubscribed', 'a re-import must not resurrect an unsubscribed person');
    assert.equal(after?.attributes.first_name, 'Ada Lovelace', 'attributes should still update');
    assert.equal(await c.subscribers.countDocuments({ listId: list._id, email: 'a@example.com' }), 1);
  });

  it('lands unattested imports as pending and queues a confirmation', async () => {
    const list = await createList();
    const job = await createImportJob({
      listId: list._id,
      filename: 'test.csv',
      mapping: { email: 'email' },
      attested: false,
      attestedBy: 'operator@test.com',
    });

    await processImportChunk(job, [{ email: 'a@example.com' }], 2);

    const c = await collections();
    assert.equal((await c.subscribers.findOne({ email: 'a@example.com' }))?.status, 'pending');
    assert.equal(await c.confirmationQueue.countDocuments({}), 1);
  });

  it('records the attestation against attested imports', async () => {
    const list = await createList();
    const job = await createImportJob({
      listId: list._id,
      filename: 'test.csv',
      mapping: { email: 'email' },
      attested: true,
      attestedBy: 'operator@test.com',
    });

    await processImportChunk(job, [{ email: 'a@example.com' }], 2);

    const c = await collections();
    const subscriber = await c.subscribers.findOne({ email: 'a@example.com' });
    assert.equal(String(subscriber?.confirmAttestationId), String(job._id));
    assert.equal(job.attestedBy, 'operator@test.com');
    assert.ok(job.attestationText?.includes('prior express consent'));
  });
});

describe('imported subscriber upsert', () => {
  it('does not duplicate on a concurrent insert race', async () => {
    const list = await createList();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        upsertImportedSubscriber({
          listId: list._id,
          email: 'race@example.com',
          attributes: {},
          confirmed: true,
        }),
      ),
    );

    const c = await collections();
    assert.equal(await c.subscribers.countDocuments({ email: 'race@example.com' }), 1);
    assert.equal(results.filter((r) => r === 'created').length, 1);
  });
});
