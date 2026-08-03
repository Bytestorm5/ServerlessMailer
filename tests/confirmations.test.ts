import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sendPendingConfirmations } from '@/lib/confirmations';
import { importSubscribers } from '@/lib/csv/import';
import { hashConfirmToken } from '@/lib/crypto/tokens';
import { confirmSubscriber } from '@/lib/subscribers';
import {
  emailTemplatesCollection,
  listsCollection,
  subscribersCollection,
} from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import { runSendCycle } from '@/lib/pipeline/run';
import { resetSesAdapter, setSesAdapter } from '@/lib/ses/registry';
import { createList, createSubscriber } from '@tests/helpers/factories';
import { FakeSes } from '@tests/helpers/fake-ses';
import type { ListDoc } from '@/lib/types';

let list: ListDoc;
let ses: FakeSes;

beforeEach(async () => {
  await ensureIndexes();
  await Promise.all([
    (await subscribersCollection()).deleteMany({}),
    (await listsCollection()).deleteMany({}),
    (await emailTemplatesCollection()).deleteMany({}),
  ]);
  list = await createList();
  ses = new FakeSes();
  setSesAdapter(ses);
});

afterEach(() => {
  resetSesAdapter();
});

async function reload(email: string) {
  return (await subscribersCollection()).findOne({ email });
}

describe('sendPendingConfirmations', () => {
  it('sends a confirmation to a pending subscriber who has never had one', async () => {
    await createSubscriber(list._id, { email: 'waiting@example.com', status: 'pending' });

    const result = await sendPendingConfirmations();

    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(ses.simpleSends).toHaveLength(1);
    expect(ses.simpleSends[0].to).toBe('waiting@example.com');
    expect(ses.simpleSends[0].content.subject).toMatch(/confirm/i);
  });

  it('stores only the hash of the token it just emailed', async () => {
    await createSubscriber(list._id, { email: 'hashed@example.com', status: 'pending' });
    await sendPendingConfirmations();

    const token = decodeURIComponent(
      ses.simpleSends[0].content.text.match(/token=([^\s]+)/)![1],
    );
    const doc = await reload('hashed@example.com');

    expect(doc?.confirmTokenHash).toBe(hashConfirmToken(token));
    expect(JSON.stringify(doc)).not.toContain(token);
  });

  it('produces a link that actually confirms the subscriber', async () => {
    // The whole point: an import without an attestation must produce records
    // that can still become confirmed.
    await createSubscriber(list._id, { email: 'usable@example.com', status: 'pending' });
    await sendPendingConfirmations();

    const token = decodeURIComponent(
      ses.simpleSends[0].content.text.match(/token=([^\s]+)/)![1],
    );
    const confirmed = await confirmSubscriber({ token, ip: '203.0.113.1' });

    expect(confirmed.ok).toBe(true);
    expect((await reload('usable@example.com'))?.status).toBe('confirmed');
  });

  it('does not send twice to the same subscriber', async () => {
    await createSubscriber(list._id, { email: 'once@example.com', status: 'pending' });

    await sendPendingConfirmations();
    const second = await sendPendingConfirmations();

    expect(second.sent).toBe(0);
    expect(ses.simpleSends).toHaveLength(1);
  });

  it('ignores subscribers who already had a confirmation sent', async () => {
    await createSubscriber(list._id, {
      email: 'already@example.com',
      status: 'pending',
      confirmEmailSentAt: new Date(),
    });

    expect(await sendPendingConfirmations()).toEqual({ sent: 0, failed: 0 });
    expect(ses.simpleSends).toHaveLength(0);
  });

  it.each(['confirmed', 'unsubscribed', 'bounced', 'complained'] as const)(
    'never emails a %s subscriber',
    async (status) => {
      await createSubscriber(list._id, { email: `${status}@example.com`, status });

      expect(await sendPendingConfirmations()).toEqual({ sent: 0, failed: 0 });
      expect(ses.simpleSends).toHaveLength(0);
    },
  );

  it('is bounded so a large import drains over several ticks', async () => {
    for (let i = 0; i < 10; i += 1) {
      await createSubscriber(list._id, { email: `bulk-${i}@example.com`, status: 'pending' });
    }

    expect((await sendPendingConfirmations({ limit: 4 })).sent).toBe(4);
    expect((await sendPendingConfirmations({ limit: 4 })).sent).toBe(4);
    expect((await sendPendingConfirmations({ limit: 4 })).sent).toBe(2);
    expect((await sendPendingConfirmations({ limit: 4 })).sent).toBe(0);
    expect(ses.simpleSends).toHaveLength(10);
  });

  it('retries on the next tick when the send fails', async () => {
    await createSubscriber(list._id, { email: 'flaky@example.com', status: 'pending' });
    ses.failAddresses.add('flaky@example.com');

    expect(await sendPendingConfirmations()).toEqual({ sent: 0, failed: 1 });
    // The marker is cleared, so this subscriber is picked up again rather than
    // being stranded pending forever.
    expect((await reload('flaky@example.com'))?.confirmEmailSentAt).toBeUndefined();

    ses.failAddresses.clear();
    expect((await sendPendingConfirmations()).sent).toBe(1);
  });

  it('skips a pending subscriber whose list has been removed', async () => {
    await createSubscriber(list._id, { email: 'orphan@example.com', status: 'pending' });
    await (await listsCollection()).deleteOne({ _id: list._id });

    expect(await sendPendingConfirmations()).toEqual({ sent: 0, failed: 1 });
    expect(ses.simpleSends).toHaveLength(0);
  });

  it('does nothing when the limit is zero', async () => {
    await createSubscriber(list._id, { email: 'x@example.com', status: 'pending' });
    expect(await sendPendingConfirmations({ limit: 0 })).toEqual({ sent: 0, failed: 0 });
  });
});

describe('an import without an attestation still reaches its subscribers', () => {
  it('mails everyone it imported as pending, via the cron', async () => {
    // §4.3: without the prior-consent attestation, imported addresses "land as
    // pending and receive a confirmation email". Import cannot send them
    // inline, so the send cron drains them.
    const imported = await importSubscribers({
      listId: list._id,
      csv: 'email\na@example.com\nb@example.com\nc@example.com\n',
      mapping: { email: 'email' },
      markConfirmed: false,
    });

    expect(imported).toMatchObject({ imported: 3 });
    expect(ses.simpleSends).toHaveLength(0);

    const summary = await runSendCycle();

    expect(summary.confirmationsSent).toBe(3);
    expect(ses.simpleSends.map((s) => s.to).sort()).toEqual([
      'a@example.com',
      'b@example.com',
      'c@example.com',
    ]);
  });

  it('does not mail anyone from an attested import, who is already confirmed', async () => {
    await importSubscribers({
      listId: list._id,
      csv: 'email\nmigrated@example.com\n',
      mapping: { email: 'email' },
      markConfirmed: true,
      attestation: { text: 'prior consent held', by: 'operator' },
    });

    const summary = await runSendCycle();

    expect(summary.confirmationsSent).toBe(0);
    expect(ses.simpleSends).toHaveLength(0);
  });
});

describe('the suppression list is checked here too', () => {
  it('never emails a suppressed address, and stops reconsidering it', async () => {
    // §1.2: every send path checks the suppression list. No exceptions.
    const { addSuppression } = await import('@/lib/suppressions');
    await createSubscriber(list._id, { email: 'blocked@example.com', status: 'pending' });
    await createSubscriber(list._id, { email: 'fine@example.com', status: 'pending' });
    await addSuppression({ email: 'blocked@example.com', reason: 'hard_bounce' });

    const result = await sendPendingConfirmations();

    expect(result.sent).toBe(1);
    expect(ses.simpleSends.map((s) => s.to)).toEqual(['fine@example.com']);

    // Not retried on the next tick.
    expect((await sendPendingConfirmations()).sent).toBe(0);
    expect((await reload('blocked@example.com'))?.status).toBe('pending');
  });
});

describe('sendPendingConfirmations through a confirmation template', () => {
  const TEMPLATE =
    '<!doctype html><html><body><p>Salaam {{ first_name | default: "friend" }}, ' +
    'confirm for {{list_name}}.</p><a href="{{confirm_url}}">CONFIRM</a></body></html>';

  it('sends the operator’s design instead of the built-in email', async () => {
    const { saveTemplate } = await import('@/lib/templates');
    await saveTemplate(list._id, 'confirmation', TEMPLATE);
    await createSubscriber(list._id, {
      email: 'waiting@example.com',
      status: 'pending',
      attributes: { first_name: 'Ada' },
    });

    await sendPendingConfirmations();

    const sent = ses.simpleSends[0].content;
    expect(sent.html).toContain('Salaam Ada, confirm for Domain A Weekly.');
    expect(sent.html).not.toContain('Please confirm you want to receive');
  });

  it('sends a working link, with the token resolved rather than left as a placeholder', async () => {
    const { saveTemplate } = await import('@/lib/templates');
    await saveTemplate(list._id, 'confirmation', TEMPLATE);
    const subscriber = await createSubscriber(list._id, {
      email: 'waiting@example.com',
      status: 'pending',
    });

    await sendPendingConfirmations();

    const token = ses.simpleSends[0].content.html.match(/token=([^"&]+)/)![1];
    expect(await reload('waiting@example.com')).toMatchObject({
      confirmTokenHash: hashConfirmToken(decodeURIComponent(token)),
    });

    // And the link actually confirms the subscriber it was minted for.
    expect(await confirmSubscriber({ token: decodeURIComponent(token) })).toMatchObject({
      ok: true,
      subscriber: expect.objectContaining({ _id: subscriber._id, status: 'confirmed' }),
    });
  });

  it('leaves a list without a confirmation template on the built-in email', async () => {
    await createSubscriber(list._id, { email: 'plain@example.com', status: 'pending' });

    await sendPendingConfirmations();

    expect(ses.simpleSends[0].content.html).toContain('Please confirm you want to receive');
  });
});
