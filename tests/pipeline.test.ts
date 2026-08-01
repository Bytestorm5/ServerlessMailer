import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { ObjectId } from 'mongodb';
import { RecordingMailer, createCampaign, createList, createSubscribers } from './helpers/fixtures';
import { resetCollections, startTestDb, type TestDb } from './helpers/setup';

/**
 * The send pipeline (§7).
 *
 * Phase 2's exit criteria, in test form: a send completes with correct counts,
 * survives a forced mid-send crash, and cannot double-send.
 */

let db: TestDb;
let mailer: RecordingMailer;

// Imported after the environment is configured.
let lib: {
  collections: typeof import('../src/lib/db')['collections'];
  freezeCampaign: typeof import('../src/lib/campaigns')['freezeCampaign'];
  pauseCampaign: typeof import('../src/lib/campaigns')['pauseCampaign'];
  runSendCycle: typeof import('../src/lib/pipeline')['runSendCycle'];
  claimBatch: typeof import('../src/lib/pipeline')['claimBatch'];
  activeSendingCampaignIds: typeof import('../src/lib/pipeline')['activeSendingCampaignIds'];
  checkCircuitBreaker: typeof import('../src/lib/pipeline')['checkCircuitBreaker'];
  suppress: typeof import('../src/lib/suppressions')['suppress'];
  applyUnsubscribe: typeof import('../src/lib/unsubscribe')['applyUnsubscribe'];
  ThrottlingError: typeof import('../src/lib/mailer')['ThrottlingError'];
  setMailerForTesting: typeof import('../src/lib/mailer')['setMailerForTesting'];
};

before(async () => {
  db = await startTestDb();
  const [dbMod, campaigns, pipeline, suppressions, unsubscribe, mailerMod] = await Promise.all([
    import('../src/lib/db'),
    import('../src/lib/campaigns'),
    import('../src/lib/pipeline'),
    import('../src/lib/suppressions'),
    import('../src/lib/unsubscribe'),
    import('../src/lib/mailer'),
  ]);
  lib = {
    collections: dbMod.collections,
    freezeCampaign: campaigns.freezeCampaign,
    pauseCampaign: campaigns.pauseCampaign,
    runSendCycle: pipeline.runSendCycle,
    claimBatch: pipeline.claimBatch,
    activeSendingCampaignIds: pipeline.activeSendingCampaignIds,
    checkCircuitBreaker: pipeline.checkCircuitBreaker,
    suppress: suppressions.suppress,
    applyUnsubscribe: unsubscribe.applyUnsubscribe,
    ThrottlingError: mailerMod.ThrottlingError,
    setMailerForTesting: mailerMod.setMailerForTesting,
  };
});

after(async () => {
  lib.setMailerForTesting(undefined);
  await db.stop();
});

beforeEach(async () => {
  await resetCollections();
  mailer = new RecordingMailer();
  lib.setMailerForTesting(mailer);
});

describe('freeze (§7.1)', () => {
  it('materializes batches of at most 50 and counts recipients', async () => {
    const list = await createList();
    await createSubscribers(list._id, 120);
    const campaign = await createCampaign(list._id);

    const result = await lib.freezeCampaign(campaign._id);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.recipients, 120);
    assert.equal(result.ok && result.batches, 3);

    const c = await lib.collections();
    const batches = await c.campaignBatches.find({ campaignId: campaign._id }).toArray();
    assert.equal(batches.length, 3);
    for (const batch of batches) {
      assert.ok(batch.subscriberIds.length <= 50, 'batch exceeds the SES destination limit');
    }

    const frozen = await c.campaigns.findOne({ _id: campaign._id });
    assert.equal(frozen?.status, 'sending');
    assert.equal(frozen?.counts.recipients, 120);
    assert.ok(frozen?.bodyHtml && frozen.bodyHtml.length > 0, 'body was not frozen');
    assert.ok(frozen?.bodyText && frozen.bodyText.includes('Unsubscribe:'), 'text part lacks unsubscribe');
    assert.ok(frozen?.frozenAt instanceof Date);
  });

  it('excludes suppressed addresses and anyone not confirmed', async () => {
    const list = await createList();
    const people = await createSubscribers(list._id, 10);
    await createSubscribers(list._id, 5, { status: 'pending', email: 'pending@example.com' }).catch(() => []);

    const c = await lib.collections();
    // Two suppressed, two unsubscribed.
    await lib.suppress({ email: people[0]!.email, reason: 'hard_bounce' });
    await lib.suppress({ email: people[1]!.email, reason: 'complaint' });
    await c.subscribers.updateOne({ _id: people[2]!._id }, { $set: { status: 'unsubscribed' } });
    await c.subscribers.updateOne({ _id: people[3]!._id }, { $set: { status: 'pending' } });

    const campaign = await createCampaign(list._id);
    const result = await lib.freezeCampaign(campaign._id);

    assert.equal(result.ok && result.recipients, 6);
  });

  it('refuses to freeze twice, so a double-click cannot double-materialize', async () => {
    const list = await createList();
    await createSubscribers(list._id, 10);
    const campaign = await createCampaign(list._id);

    const first = await lib.freezeCampaign(campaign._id);
    const second = await lib.freezeCampaign(campaign._id);

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.reason, 'wrong_status');

    const c = await lib.collections();
    assert.equal(await c.campaignBatches.countDocuments({ campaignId: campaign._id }), 1);
  });

  it('reports no_recipients rather than starting an empty send', async () => {
    const list = await createList();
    const campaign = await createCampaign(list._id);

    const result = await lib.freezeCampaign(campaign._id);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'no_recipients');

    const c = await lib.collections();
    const after = await c.campaigns.findOne({ _id: campaign._id });
    assert.equal(after?.status, 'draft', 'an empty campaign must stay editable');
    assert.equal(after?.frozenAt, null);
  });
});

describe('send cycle (§7.2–7.4)', () => {
  it('sends every recipient exactly once and completes the campaign', async () => {
    const list = await createList();
    await createSubscribers(list._id, 120);
    const campaign = await createCampaign(list._id);
    await lib.freezeCampaign(campaign._id);

    const summary = await lib.runSendCycle('test-run-1');

    assert.equal(summary.sent, 120);
    assert.equal(summary.failed, 0);
    assert.equal(mailer.destinationCount, 120);
    assert.equal(new Set(mailer.recipients).size, 120, 'an address was sent to twice');

    const c = await lib.collections();
    assert.equal(await c.sentLog.countDocuments({ campaignId: campaign._id }), 120);

    const done = await c.campaigns.findOne({ _id: campaign._id });
    assert.equal(done?.status, 'sent');
    assert.equal(done?.counts.sent, 120);
    assert.ok(done?.completedAt instanceof Date);
  });

  it('attaches a per-recipient one-click unsubscribe header (§9.1)', async () => {
    const list = await createList();
    await createSubscribers(list._id, 3);
    const campaign = await createCampaign(list._id);
    await lib.freezeCampaign(campaign._id);
    await lib.runSendCycle('test-run-headers');

    const destinations = mailer.bulkCalls.flatMap((call) => call.destinations);
    assert.equal(destinations.length, 3);

    const tokens = new Set<string>();
    for (const destination of destinations) {
      const header = destination.headers?.['List-Unsubscribe'];
      assert.ok(header, 'List-Unsubscribe missing');
      assert.match(header, /^<mailto:unsubscribe@news\.test\.com>, <https:\/\/mail\.test\/api\/unsubscribe\?t=[^>]+>$/);
      assert.equal(destination.headers?.['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
      tokens.add(header);
      assert.ok(destination.replacementData.unsubscribe_url?.startsWith('https://mail.test/api/unsubscribe?t='));
    }
    assert.equal(tokens.size, 3, 'unsubscribe tokens must be per-recipient');
  });

  it('resolves merge fallbacks per recipient', async () => {
    const list = await createList();
    await createSubscribers(list._id, 3);
    const campaign = await createCampaign(list._id);
    await lib.freezeCampaign(campaign._id);
    await lib.runSendCycle('test-run-merge');

    const destinations = mailer.bulkCalls.flatMap((call) => call.destinations);
    // person0 has an empty first_name and must fall back to "there".
    const person0 = destinations.find((d) => d.to === 'person0@example.com');
    const person1 = destinations.find((d) => d.to === 'person1@example.com');
    assert.equal(person0?.replacementData.m0, 'there');
    assert.equal(person1?.replacementData.m0, 'Person1');
  });

  it('cannot double-send: replayed batches are skipped by the sent_log invariant (§3.6)', async () => {
    const list = await createList();
    await createSubscribers(list._id, 60);
    const campaign = await createCampaign(list._id);
    await lib.freezeCampaign(campaign._id);
    await lib.runSendCycle('test-run-a');

    const c = await lib.collections();
    const firstPass = await c.sentLog.countDocuments({ campaignId: campaign._id });
    assert.equal(firstPass, 60);

    // Simulate the worst case the lease design has to survive: batches that
    // were already delivered get put back as pending and claimed again.
    await c.campaignBatches.updateMany(
      { campaignId: campaign._id },
      { $set: { status: 'pending', attempts: 0, leaseUntil: new Date(0) } },
    );
    await c.campaigns.updateOne({ _id: campaign._id }, { $set: { status: 'sending', completedAt: null } });

    mailer.reset();
    const replay = await lib.runSendCycle('test-run-b');

    assert.equal(replay.sent, 0, 'a replayed batch must send nothing');
    assert.equal(mailer.destinationCount, 0, 'SES must not even be called for already-sent recipients');
    assert.equal(await c.sentLog.countDocuments({ campaignId: campaign._id }), 60);
  });

  it('survives a crash mid-batch: the lease expires and the next tick finishes the work', async () => {
    const list = await createList();
    await createSubscribers(list._id, 100);
    const campaign = await createCampaign(list._id);
    await lib.freezeCampaign(campaign._id);

    const c = await lib.collections();

    // A run claims a batch and dies before processing it.
    const ids = await lib.activeSendingCampaignIds();
    const claimed = await lib.claimBatch(ids, 'crashed-invocation');
    assert.ok(claimed, 'nothing was claimable');
    assert.equal(claimed.status, 'claimed');

    // While the lease is live, no other invocation may take it.
    const blocked = await c.campaignBatches.findOne({ _id: claimed._id, status: 'pending' });
    assert.equal(blocked, null);

    // Time passes; the lease expires.
    await c.campaignBatches.updateOne({ _id: claimed._id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } });

    const summary = await lib.runSendCycle('recovery-invocation');
    assert.equal(summary.sent, 100, 'the abandoned batch was not recovered');
    assert.equal(await c.sentLog.countDocuments({ campaignId: campaign._id }), 100);
    assert.equal((await c.campaigns.findOne({ _id: campaign._id }))?.status, 'sent');
  });

  it('re-checks status and suppressions at send time, not just at freeze (§7.4)', async () => {
    const list = await createList();
    const people = await createSubscribers(list._id, 10);
    const campaign = await createCampaign(list._id);
    await lib.freezeCampaign(campaign._id);

    // Between freeze and send: one unsubscribes, one is suppressed by a bounce
    // on the other domain.
    await lib.applyUnsubscribe(people[0]!._id, 'one_click');
    await lib.suppress({ email: people[1]!.email, reason: 'hard_bounce' });

    const summary = await lib.runSendCycle('test-run-recheck');

    assert.equal(summary.sent, 8);
    assert.equal(summary.skipped, 2);
    assert.ok(!mailer.recipients.includes(people[0]!.email), 'unsubscribed address was mailed');
    assert.ok(!mailer.recipients.includes(people[1]!.email), 'suppressed address was mailed');
  });

  it('counts a per-destination failure without failing the whole batch', async () => {
    const list = await createList();
    await createSubscribers(list._id, 10);
    const campaign = await createCampaign(list._id);
    await lib.freezeCampaign(campaign._id);

    mailer.failIndexes = new Set([2, 5]);
    const summary = await lib.runSendCycle('test-run-partial');

    assert.equal(summary.sent, 8);
    assert.equal(summary.failed, 2);

    const c = await lib.collections();
    assert.equal(await c.sentLog.countDocuments({ campaignId: campaign._id }), 8);
    const batch = await c.campaignBatches.findOne({ campaignId: campaign._id });
    assert.equal(batch?.status, 'sent', 'one bad address must not fail the batch');
    assert.match(batch?.lastError ?? '', /MESSAGE_REJECTED/);
  });
});

describe('pause and throttling (§7.5, §7.7)', () => {
  it('a paused campaign is not claimable, so sending stops within one tick', async () => {
    const list = await createList();
    await createSubscribers(list._id, 100);
    const campaign = await createCampaign(list._id);
    await lib.freezeCampaign(campaign._id);

    await lib.pauseCampaign(campaign._id, 'operator pressed pause');

    const summary = await lib.runSendCycle('test-run-paused');
    assert.equal(summary.batchesProcessed, 0);
    assert.equal(mailer.destinationCount, 0);

    const c = await lib.collections();
    assert.equal(await c.sentLog.countDocuments({ campaignId: campaign._id }), 0);
    assert.equal(
      await c.campaignBatches.countDocuments({ campaignId: campaign._id, status: 'pending' }),
      2,
      'in-flight work must be left intact for the resume',
    );
  });

  it('releases the batch and ends the run when SES throttles, without burning an attempt', async () => {
    const list = await createList();
    await createSubscribers(list._id, 100);
    const campaign = await createCampaign(list._id);
    await lib.freezeCampaign(campaign._id);

    mailer.throwOnBulk = new lib.ThrottlingError('Maximum sending rate exceeded');

    const summary = await lib.runSendCycle('test-run-throttled');
    assert.equal(summary.throttled, true);
    assert.equal(summary.sent, 0);

    const c = await lib.collections();
    const batches = await c.campaignBatches.find({ campaignId: campaign._id }).toArray();
    const released = batches.find((batch) => (batch.lastError ?? '').includes('Throttled'));
    assert.ok(released, 'no batch was released');
    assert.equal(released.status, 'pending');
    assert.equal(released.attempts, 0, 'back-pressure must not consume an attempt');
  });
});

describe('circuit breaker (§7.8)', () => {
  it('auto-pauses when the complaint rate crosses the threshold', async () => {
    process.env.COMPLAINT_MIN_DELIVERED = '100';
    const list = await createList();
    await createSubscribers(list._id, 10);
    const campaign = await createCampaign(list._id);
    await lib.freezeCampaign(campaign._id);

    const c = await lib.collections();
    // 2 complaints in 1000 delivered = 0.2%, over the 0.1% threshold.
    await c.campaigns.updateOne(
      { _id: campaign._id },
      { $set: { 'counts.delivered': 1000, 'counts.complained': 2 } },
    );

    const verdict = await lib.checkCircuitBreaker(campaign._id);
    assert.equal(verdict.tripped, true);
    assert.equal((await c.campaigns.findOne({ _id: campaign._id }))?.status, 'paused');
    delete process.env.COMPLAINT_MIN_DELIVERED;
  });

  it('does not trip on a sample too small to mean anything', async () => {
    const list = await createList();
    await createSubscribers(list._id, 10);
    const campaign = await createCampaign(list._id);
    await lib.freezeCampaign(campaign._id);

    const c = await lib.collections();
    await c.campaigns.updateOne({ _id: campaign._id }, { $set: { 'counts.delivered': 10, 'counts.complained': 1 } });

    const verdict = await lib.checkCircuitBreaker(campaign._id);
    assert.equal(verdict.tripped, false);
    assert.equal((await c.campaigns.findOne({ _id: campaign._id }))?.status, 'sending');
  });
});

describe('claim atomicity (§7.3)', () => {
  it('concurrent claims never hand out the same batch twice', async () => {
    const list = await createList();
    await createSubscribers(list._id, 250);
    const campaign = await createCampaign(list._id);
    await lib.freezeCampaign(campaign._id);

    const ids = await lib.activeSendingCampaignIds();
    const claims = await Promise.all(
      Array.from({ length: 5 }, (_value, index) => lib.claimBatch(ids, `invocation-${index}`)),
    );

    const claimedIds = claims.filter(Boolean).map((batch) => String((batch as { _id: ObjectId })._id));
    assert.equal(claimedIds.length, 5);
    assert.equal(new Set(claimedIds).size, 5, 'the same batch was claimed by two invocations');
  });
});
