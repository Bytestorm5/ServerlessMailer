import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createCampaign, createList, createSubscribers } from './helpers/fixtures';
import { resetCollections, startTestDb, type TestDb } from './helpers/setup';
import { collections } from '../src/lib/db';
import { handleSesNotification, TRANSIENT_BOUNCE_THRESHOLD } from '../src/lib/ses-events';
import { isSuppressed } from '../src/lib/suppressions';
import type { ObjectId } from 'mongodb';

/** Bounce and complaint handling (§8.2). */

let db: TestDb;
let listId: ObjectId;
let campaignId: ObjectId;

before(async () => {
  db = await startTestDb();
});

after(async () => {
  await db.stop();
});

beforeEach(async () => {
  await resetCollections();
  const list = await createList();
  listId = list._id;
  const campaign = await createCampaign(listId);
  campaignId = campaign._id;
  await createSubscribers(listId, 3);
});

function tags() {
  return {
    campaign_id: [String(campaignId)],
    list_id: [String(listId)],
    type: ['campaign'],
  };
}

describe('bounces', () => {
  it('suppresses on a permanent bounce and marks the subscriber bounced', async () => {
    await handleSesNotification({
      eventType: 'Bounce',
      mail: { messageId: 'm1', destination: ['person0@example.com'], tags: tags() },
      bounce: {
        bounceType: 'Permanent',
        bounceSubType: 'General',
        bouncedRecipients: [{ emailAddress: 'person0@example.com', diagnosticCode: '550 5.1.1 unknown' }],
      },
    });

    assert.equal(await isSuppressed('person0@example.com'), true);

    const c = await collections();
    const subscriber = await c.subscribers.findOne({ email: 'person0@example.com' });
    assert.equal(subscriber?.status, 'bounced');
    assert.ok(subscriber?.bouncedAt instanceof Date);

    const suppression = await c.suppressions.findOne({ email: 'person0@example.com' });
    assert.equal(suppression?.reason, 'hard_bounce');
    assert.equal(suppression?.detail, '550 5.1.1 unknown');
    assert.equal(String(suppression?.sourceCampaignId), String(campaignId));

    assert.equal((await c.campaigns.findOne({ _id: campaignId }))?.counts.bounced, 1);
  });

  it('does not suppress a single transient bounce', async () => {
    await handleSesNotification({
      eventType: 'Bounce',
      mail: { messageId: 'm2', destination: ['person1@example.com'], tags: tags() },
      bounce: {
        bounceType: 'Transient',
        bouncedRecipients: [{ emailAddress: 'person1@example.com', diagnosticCode: '452 mailbox full' }],
      },
    });

    assert.equal(await isSuppressed('person1@example.com'), false);
    const c = await collections();
    assert.equal((await c.subscribers.findOne({ email: 'person1@example.com' }))?.status, 'confirmed');
  });

  it('suppresses after repeated transient bounces across distinct campaigns', async () => {
    const c = await collections();
    for (let i = 0; i < TRANSIENT_BOUNCE_THRESHOLD; i += 1) {
      const campaign = await createCampaign(listId, { subject: `Issue ${i}` });
      await handleSesNotification({
        eventType: 'Bounce',
        mail: {
          messageId: `m-${i}`,
          destination: ['person1@example.com'],
          tags: { campaign_id: [String(campaign._id)], list_id: [String(listId)], type: ['campaign'] },
        },
        bounce: {
          bounceType: 'Transient',
          bouncedRecipients: [{ emailAddress: 'person1@example.com', diagnosticCode: '452 mailbox full' }],
        },
      });
    }

    assert.equal(await isSuppressed('person1@example.com'), true);
    assert.equal((await c.subscribers.findOne({ email: 'person1@example.com' }))?.status, 'bounced');
  });

  it('counts repeats by distinct campaign, not by event', async () => {
    // The same campaign bouncing three times is one failing send, not three.
    for (let i = 0; i < TRANSIENT_BOUNCE_THRESHOLD + 2; i += 1) {
      await handleSesNotification({
        eventType: 'Bounce',
        mail: { messageId: `dup-${i}`, destination: ['person2@example.com'], tags: tags() },
        bounce: {
          bounceType: 'Transient',
          bouncedRecipients: [{ emailAddress: 'person2@example.com' }],
        },
      });
    }

    assert.equal(await isSuppressed('person2@example.com'), false);
  });
});

describe('complaints', () => {
  it('always suppresses, with no threshold', async () => {
    await handleSesNotification({
      eventType: 'Complaint',
      mail: { messageId: 'm3', destination: ['person0@example.com'], tags: tags() },
      complaint: {
        complainedRecipients: [{ emailAddress: 'person0@example.com' }],
        complaintFeedbackType: 'abuse',
      },
    });

    assert.equal(await isSuppressed('person0@example.com'), true);

    const c = await collections();
    const subscriber = await c.subscribers.findOne({ email: 'person0@example.com' });
    assert.equal(subscriber?.status, 'complained');
    assert.equal(subscriber?.unsubscribeSource, 'complaint');
    assert.equal((await c.suppressions.findOne({ email: 'person0@example.com' }))?.reason, 'complaint');
  });
});

describe('idempotency (§8.1: SNS delivers at least once)', () => {
  it('does not double-count a replayed delivery', async () => {
    const notification = {
      eventType: 'Delivery' as const,
      mail: { messageId: 'm4', destination: ['person0@example.com'], tags: tags() },
      delivery: { recipients: ['person0@example.com'] },
    };

    await handleSesNotification(notification);
    await handleSesNotification(notification);
    await handleSesNotification(notification);

    const c = await collections();
    const campaign = await c.campaigns.findOne({ _id: campaignId });
    assert.equal(campaign?.counts.delivered, 1, 'a replayed event inflated the counter');
    assert.equal(await c.events.countDocuments({ campaignId, type: 'delivered' }), 3, 'every event is still recorded');
  });

  it('does not double-count repeated opens from one person', async () => {
    for (let i = 0; i < 5; i += 1) {
      await handleSesNotification({
        eventType: 'Open',
        mail: { messageId: 'm5', destination: ['person0@example.com'], tags: tags() },
        open: { timestamp: new Date().toISOString() },
      });
    }

    const c = await collections();
    assert.equal((await c.campaigns.findOne({ _id: campaignId }))?.counts.opened, 1);
  });

  it('replaying a permanent bounce does not create a second suppression', async () => {
    const notification = {
      eventType: 'Bounce' as const,
      mail: { messageId: 'm6', destination: ['person0@example.com'], tags: tags() },
      bounce: {
        bounceType: 'Permanent',
        bouncedRecipients: [{ emailAddress: 'person0@example.com' }],
      },
    };

    await handleSesNotification(notification);
    await handleSesNotification(notification);

    const c = await collections();
    assert.equal(await c.suppressions.countDocuments({ email: 'person0@example.com' }), 1);
  });
});

describe('test sends are excluded from campaign counts (§6.5)', () => {
  it('does not count a bounce from a test send against the campaign', async () => {
    await handleSesNotification({
      eventType: 'Bounce',
      mail: {
        messageId: 'm7',
        destination: ['seed@example.com'],
        tags: { campaign_id: [String(campaignId)], list_id: [String(listId)], type: ['test'] },
      },
      bounce: {
        bounceType: 'Permanent',
        bouncedRecipients: [{ emailAddress: 'seed@example.com' }],
      },
    });

    const c = await collections();
    assert.equal((await c.campaigns.findOne({ _id: campaignId }))?.counts.bounced, 0);
    // The address is still suppressed — a dead address is dead whoever sent to it.
    assert.equal(await isSuppressed('seed@example.com'), true);
  });
});

describe('rejects', () => {
  it('records a Reject as a configuration problem, not a recipient problem', async () => {
    const result = await handleSesNotification({
      eventType: 'Reject',
      mail: { messageId: 'm8', destination: ['person0@example.com'], tags: tags() },
      reject: { reason: 'Bad message' },
    });

    assert.equal(result.handled, true);
    const c = await collections();
    assert.equal(await c.events.countDocuments({ type: 'reject' }), 1);
    assert.equal(await isSuppressed('person0@example.com'), false);
  });
});
