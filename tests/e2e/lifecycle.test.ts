import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';

import { POST as subscribe } from '@/app/api/subscribe/route';
import { GET as confirm } from '@/app/api/confirm/route';
import { POST as unsubscribeOneClick } from '@/app/api/unsubscribe/route';
import { GET as cronSend } from '@/app/api/cron/send/route';

import { handleSnsNotification } from '@/lib/sns/handle';
import { freezeCampaign } from '@/lib/pipeline/freeze';
import { resetSleeper, setSleeper } from '@/lib/pipeline/process';
import { updateCampaignDraft, createCampaign } from '@/lib/campaigns';
import { importSubscribers } from '@/lib/csv/import';
import { isSuppressed } from '@/lib/suppressions';
import { setMxResolver, resetMxResolver } from '@/lib/email/mx';
import { resetSesAdapter, setSesAdapter } from '@/lib/ses/registry';
import {
  campaignBatchesCollection,
  campaignsCollection,
  eventsCollection,
  rateLimitsCollection,
  sentLogCollection,
  subscribersCollection,
  suppressionsCollection,
} from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import { createList, validCampaignDoc } from '@tests/helpers/factories';
import { FakeSes } from '@tests/helpers/fake-ses';
import type { ListDoc } from '@/lib/types';

let list: ListDoc;
let ses: FakeSes;

beforeEach(async () => {
  await ensureIndexes();
  await Promise.all([
    (await subscribersCollection()).deleteMany({}),
    (await suppressionsCollection()).deleteMany({}),
    (await campaignsCollection()).deleteMany({}),
    (await campaignBatchesCollection()).deleteMany({}),
    (await sentLogCollection()).deleteMany({}),
    (await eventsCollection()).deleteMany({}),
    (await rateLimitsCollection()).deleteMany({}),
  ]);
  list = await createList();
  ses = new FakeSes();
  ses.verifiedIdentities.add('news.domain-a.com');
  setSesAdapter(ses);
  setMxResolver(async () => [{ exchange: 'mx.example.com', priority: 10 }]);
  setSleeper(async () => {});
});

afterEach(() => {
  resetSesAdapter();
  resetMxResolver();
  resetSleeper();
});

const origin = 'https://mail.example.com';

async function signUp(email: string, ip = '203.0.113.10') {
  return subscribe(
    new Request(`${origin}/api/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ email, listId: list._id.toHexString() }),
    }),
  );
}

/** Pulls the confirmation token out of the email that was actually sent. */
function tokenFromLastEmail(): string {
  const text = ses.simpleSends.at(-1)!.content.text;
  return decodeURIComponent(text.match(/token=([^\s]+)/)![1]);
}

async function runCron() {
  return cronSend(
    new Request(`${origin}/api/cron/send`, {
      headers: { authorization: 'Bearer test-cron-secret' },
    }),
  );
}

async function readyCampaign() {
  const campaign = await createCampaign({ listId: list._id, subject: 'This week' });
  await updateCampaignDraft({ campaignId: campaign._id, bodySource: validCampaignDoc() });
  return campaign;
}

describe('the whole journey: signup to unsubscribe', () => {
  it('carries one reader from the form to a delivered campaign and out again', async () => {
    // 1. Signup — lands as pending, confirmation sent transactionally.
    expect((await signUp('reader@example.com')).status).toBe(200);
    let doc = await (await subscribersCollection()).findOne({ email: 'reader@example.com' });
    expect(doc?.status).toBe('pending');
    expect(ses.simpleSends).toHaveLength(1);
    expect(ses.bulkSends).toHaveLength(0);

    // 2. Confirmation — consent evidence is captured from the request.
    const response = await confirm(
      new Request(`${origin}/api/confirm?token=${encodeURIComponent(tokenFromLastEmail())}`, {
        headers: { 'x-forwarded-for': '198.51.100.22', 'user-agent': 'Firefox/1.0' },
      }),
    );
    expect(response.status).toBe(302);

    doc = await (await subscribersCollection()).findOne({ email: 'reader@example.com' });
    expect(doc?.status).toBe('confirmed');
    expect(doc?.confirmIp).toBe('198.51.100.22');
    expect(doc?.confirmUserAgent).toBe('Firefox/1.0');

    // 3. Compose and send a campaign.
    const campaign = await readyCampaign();
    expect(await freezeCampaign(campaign._id)).toMatchObject({ ok: true, recipients: 1 });

    const cron = await runCron();
    expect(cron.status).toBe(200);
    expect((await cron.json()).sent).toBe(1);
    expect(ses.bulkSends).toHaveLength(1);

    // The delivered message carries both bulk-sender unsubscribe headers.
    const destination = ses.bulkSends[0].params.destinations[0];
    expect(destination.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const unsubscribeUrl = destination.headers['List-Unsubscribe'].match(/<(https:[^>]+)>/)![1];

    // 4. SES reports the delivery, attributed by the real message id that came
    //    back from the send.
    const campaignMessageId = ses.bulkSends[0].results[0].messageId!;
    await handleSnsNotification({
      Type: 'Notification',
      MessageId: 'sns-delivery-1',
      Message: JSON.stringify({
        eventType: 'Delivery',
        mail: { messageId: campaignMessageId, destination: ['reader@example.com'] },
        delivery: { recipients: ['reader@example.com'] },
      }),
    });
    expect(
      (await (await campaignsCollection()).findOne({ _id: campaign._id }))?.counts.delivered,
    ).toBe(1);

    // 5. One-click unsubscribe, using the header exactly as a provider would.
    const unsubscribed = await unsubscribeOneClick(
      new Request(unsubscribeUrl, { method: 'POST' }),
    );
    expect(unsubscribed.status).toBe(200);

    doc = await (await subscribersCollection()).findOne({ email: 'reader@example.com' });
    expect(doc?.status).toBe('unsubscribed');
    // Unsubscribe is a per-list preference, not a deliverability failure.
    expect(await isSuppressed('reader@example.com')).toBe(false);
    // Consent evidence survives as a tombstone.
    expect(doc?.confirmIp).toBe('198.51.100.22');

    // 6. A second campaign must not reach them.
    const second = await readyCampaign();
    expect(await freezeCampaign(second._id)).toMatchObject({
      ok: false,
      reason: 'validation_failed',
    });
  });
});

describe('a hard bounce removes the address everywhere', () => {
  it('suppresses on bounce and excludes the address from every later send', async () => {
    await signUp('bouncer@example.com');
    await confirm(
      new Request(`${origin}/api/confirm?token=${encodeURIComponent(tokenFromLastEmail())}`),
    );
    await signUp('good@example.com', '203.0.113.11');
    await confirm(
      new Request(`${origin}/api/confirm?token=${encodeURIComponent(tokenFromLastEmail())}`),
    );

    const first = await readyCampaign();
    await freezeCampaign(first._id);
    await runCron();
    const messageId = ses.bulkSends[0].results.find(
      (r) => r.email === 'bouncer@example.com',
    )!.messageId!;

    // SES reports a permanent bounce for that exact message.
    await handleSnsNotification({
      Type: 'Notification',
      MessageId: 'sns-bounce-1',
      Message: JSON.stringify({
        eventType: 'Bounce',
        mail: { messageId, destination: ['bouncer@example.com'] },
        bounce: {
          bounceType: 'Permanent',
          bouncedRecipients: [
            { emailAddress: 'bouncer@example.com', diagnosticCode: 'smtp; 550 5.1.1' },
          ],
        },
      }),
    });

    expect(await isSuppressed('bouncer@example.com')).toBe(true);

    // A later campaign excludes them at freeze time.
    ses.reset();
    const second = await readyCampaign();
    expect(await freezeCampaign(second._id)).toMatchObject({ ok: true, recipients: 1 });
    await runCron();
    expect(ses.allSentAddresses()).toEqual(['good@example.com']);

    // And a re-import cannot resurrect them.
    const imported = await importSubscribers({
      listId: list._id,
      csv: 'email\nbouncer@example.com\n',
      mapping: { email: 'email' },
      markConfirmed: true,
      attestation: { text: 'prior consent', by: 'operator' },
    });
    expect(imported).toMatchObject({ skippedSuppressed: 1, imported: 0 });
  });
});

describe('a complaint mid-send trips the circuit breaker', () => {
  it('auto-pauses the campaign before the rest of the list goes out', async () => {
    const subscribers = await subscribersCollection();
    await subscribers.insertMany(
      Array.from({ length: 300 }, (_, i) => ({
        _id: new ObjectId(),
        listId: list._id,
        email: `bulk-${i}@example.com`,
        emailDomain: 'example.com',
        status: 'confirmed' as const,
        attributes: {},
        source: 'import' as const,
        createdAt: new Date(),
        confirmedAt: new Date(),
        history: [],
      })),
    );

    const campaign = await readyCampaign();
    await freezeCampaign(campaign._id);

    // Constrain the run so the whole list cannot go out in a single tick —
    // that 30-minute send window is precisely what makes the breaker useful.
    const previousMax = process.env.MAX_BATCHES_PER_RUN;
    process.env.MAX_BATCHES_PER_RUN = '2';

    try {
      // One tick goes out, then the complaints land.
      await runCron();
      await (await campaignsCollection()).updateOne(
        { _id: campaign._id },
        { $set: { 'counts.delivered': 5000, 'counts.complained': 40 } },
      );

      const summary = await (await runCron()).json();
      expect(summary.pausedCampaigns).toContain(campaign._id.toHexString());

      const sentBefore = await (await sentLogCollection()).countDocuments({
        campaignId: campaign._id,
      });

      // Subsequent ticks send nothing at all while paused.
      await runCron();
      await runCron();
      expect(
        await (await sentLogCollection()).countDocuments({ campaignId: campaign._id }),
      ).toBe(sentBefore);
      // The whole point: a bad campaign caught at minute three costs 1,800
      // sends instead of 19,000.
      expect(sentBefore).toBeLessThan(300);
    } finally {
      if (previousMax === undefined) delete process.env.MAX_BATCHES_PER_RUN;
      else process.env.MAX_BATCHES_PER_RUN = previousMax;
    }
  }, 60_000);
});

describe('enumeration resistance end to end', () => {
  it('gives the same answer for a stranger, a subscriber, and a suppressed address', async () => {
    await signUp('known@example.com');
    await confirm(
      new Request(`${origin}/api/confirm?token=${encodeURIComponent(tokenFromLastEmail())}`),
    );
    await (await suppressionsCollection()).insertOne({
      _id: new ObjectId(),
      email: 'blocked@example.com',
      reason: 'complaint',
      createdAt: new Date(),
    });

    const answers = await Promise.all(
      ['stranger@example.com', 'known@example.com', 'blocked@example.com'].map(
        async (email, index) => {
          const response = await signUp(email, `203.0.113.${20 + index}`);
          return { status: response.status, body: await response.json() };
        },
      ),
    );

    for (const answer of answers) {
      expect(answer.status).toBe(answers[0].status);
      expect(answer.body).toEqual(answers[0].body);
    }

    // And the suppressed address was not created.
    expect(
      await (await subscribersCollection()).findOne({ email: 'blocked@example.com' }),
    ).toBeNull();
  });
});
