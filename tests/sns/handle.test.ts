import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import {
  handleSnsNotification,
  resetSubscribeUrlFetcher,
  setSubscribeUrlFetcher,
} from '@/lib/sns/handle';
import {
  campaignsCollection,
  eventsCollection,
  sentLogCollection,
  subscribersCollection,
  suppressionsCollection,
} from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import { isSuppressed } from '@/lib/suppressions';
import { createCampaign, createList, createSubscriber } from '@tests/helpers/factories';
import type { CampaignDoc, ListDoc, SubscriberDoc } from '@/lib/types';

let list: ListDoc;
let campaign: CampaignDoc;
let subscriber: SubscriberDoc;

beforeEach(async () => {
  await ensureIndexes();
  await Promise.all([
    (await subscribersCollection()).deleteMany({}),
    (await suppressionsCollection()).deleteMany({}),
    (await campaignsCollection()).deleteMany({}),
    (await sentLogCollection()).deleteMany({}),
    (await eventsCollection()).deleteMany({}),
  ]);
  list = await createList();
  campaign = await createCampaign(list._id, { status: 'sending' });
  subscriber = await createSubscriber(list._id, { email: 'reader@example.com' });

  // The link that attributes an SES event back to a campaign and recipient.
  await (await sentLogCollection()).insertOne({
    _id: new ObjectId(),
    campaignId: campaign._id,
    subscriberId: subscriber._id,
    sesMessageId: 'ses-message-1',
    sentAt: new Date(),
  });
});

afterEach(() => {
  resetSubscribeUrlFetcher();
});

function notification(message: Record<string, unknown>, messageId = 'sns-1') {
  return {
    Type: 'Notification',
    MessageId: messageId,
    TopicArn: 'arn:aws:sns:us-east-1:123:ses-events',
    Message: JSON.stringify(message),
    Timestamp: new Date().toISOString(),
  };
}

function sesEvent(
  eventType: string,
  extra: Record<string, unknown>,
  destination = ['reader@example.com'],
) {
  return {
    eventType,
    mail: {
      messageId: 'ses-message-1',
      destination,
      timestamp: new Date().toISOString(),
    },
    ...extra,
  };
}

async function statusOf(id: ObjectId) {
  return (await (await subscribersCollection()).findOne({ _id: id }))?.status;
}

async function countsOf(id: ObjectId) {
  return (await (await campaignsCollection()).findOne({ _id: id }))?.counts;
}

describe('SubscriptionConfirmation', () => {
  it('confirms the subscription by fetching the SubscribeURL', async () => {
    const fetched: string[] = [];
    setSubscribeUrlFetcher(async (url) => {
      fetched.push(url);
    });

    const result = await handleSnsNotification({
      Type: 'SubscriptionConfirmation',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription',
      Token: 'abc',
    });

    expect(result).toEqual({ handled: true, action: 'subscription_confirmed' });
    expect(fetched).toHaveLength(1);
  });

  it('refuses to fetch a SubscribeURL that is not an AWS host', async () => {
    // Blindly fetching an attacker-supplied URL is a server-side request
    // forgery primitive.
    let called = false;
    setSubscribeUrlFetcher(async () => {
      called = true;
    });

    const result = await handleSnsNotification({
      Type: 'SubscriptionConfirmation',
      SubscribeURL: 'https://attacker.example/internal',
    });

    expect(result.handled).toBe(false);
    expect(called).toBe(false);
  });
});

describe('Bounce handling', () => {
  it('suppresses a permanent bounce and marks the subscriber bounced', async () => {
    const result = await handleSnsNotification(
      notification(
        sesEvent('Bounce', {
          bounce: {
            bounceType: 'Permanent',
            bouncedRecipients: [
              { emailAddress: 'reader@example.com', diagnosticCode: 'smtp; 550 5.1.1' },
            ],
          },
        }),
      ),
    );

    expect(result).toEqual({ handled: true, action: 'bounce_permanent' });
    expect(await isSuppressed('reader@example.com')).toBe(true);
    expect(await statusOf(subscriber._id)).toBe('bounced');
    expect((await countsOf(campaign._id))?.bounced).toBe(1);
  });

  it('records the SES diagnostic code on the suppression', async () => {
    await handleSnsNotification(
      notification(
        sesEvent('Bounce', {
          bounce: {
            bounceType: 'Permanent',
            bouncedRecipients: [
              { emailAddress: 'reader@example.com', diagnosticCode: 'smtp; 550 no such user' },
            ],
          },
        }),
      ),
    );

    const doc = await (await suppressionsCollection()).findOne({ email: 'reader@example.com' });
    expect(doc?.detail).toContain('550 no such user');
    expect(doc?.reason).toBe('hard_bounce');
    expect(doc?.sourceCampaignId?.toHexString()).toBe(campaign._id.toHexString());
  });

  it('does not suppress a single transient bounce', async () => {
    // §8.2: suppress only after repeated transient failures across distinct
    // campaigns. A full mailbox today is not a dead address.
    const result = await handleSnsNotification(
      notification(
        sesEvent('Bounce', {
          bounce: {
            bounceType: 'Transient',
            bouncedRecipients: [{ emailAddress: 'reader@example.com' }],
          },
        }),
      ),
    );

    expect(result.action).toBe('bounce_transient');
    expect(await isSuppressed('reader@example.com')).toBe(false);
    expect(await statusOf(subscriber._id)).toBe('confirmed');
  });

  it('suppresses after transient bounces across enough distinct campaigns', async () => {
    for (let i = 0; i < 3; i += 1) {
      const other = await createCampaign(list._id, { status: 'sending' });
      await (await sentLogCollection()).insertOne({
        _id: new ObjectId(),
        campaignId: other._id,
        subscriberId: subscriber._id,
        sesMessageId: `ses-transient-${i}`,
        sentAt: new Date(),
      });
      await handleSnsNotification(
        notification(
          {
            ...sesEvent('Bounce', {
              bounce: {
                bounceType: 'Transient',
                bouncedRecipients: [{ emailAddress: 'reader@example.com' }],
              },
            }),
            mail: { messageId: `ses-transient-${i}`, destination: ['reader@example.com'] },
          },
          `sns-transient-${i}`,
        ),
      );
    }

    expect(await isSuppressed('reader@example.com')).toBe(true);
  });
});

describe('Complaint handling', () => {
  it('always suppresses, with no threshold', async () => {
    // §8.2: complaints are always permanent. SES suspends an account at a 0.5%
    // complaint rate, so there is no such thing as an acceptable complaint.
    const result = await handleSnsNotification(
      notification(
        sesEvent('Complaint', {
          complaint: {
            complainedRecipients: [{ emailAddress: 'reader@example.com' }],
            complaintFeedbackType: 'abuse',
          },
        }),
      ),
    );

    expect(result).toEqual({ handled: true, action: 'complaint' });
    expect(await isSuppressed('reader@example.com')).toBe(true);
    expect(await statusOf(subscriber._id)).toBe('complained');
    expect((await countsOf(campaign._id))?.complained).toBe(1);
  });
});

describe('Delivery and Reject', () => {
  it('counts a delivery', async () => {
    const result = await handleSnsNotification(
      notification(sesEvent('Delivery', { delivery: { recipients: ['reader@example.com'] } })),
    );

    expect(result.action).toBe('delivery');
    expect((await countsOf(campaign._id))?.delivered).toBe(1);
  });

  it('flags a reject as a configuration problem', async () => {
    const result = await handleSnsNotification(
      notification(sesEvent('Reject', { reject: { reason: 'Bad content' } })),
    );

    expect(result.action).toBe('reject');
    // A reject indicates a configuration problem, not a recipient problem, so
    // the recipient must not be penalised for it.
    expect(await isSuppressed('reader@example.com')).toBe(false);
    expect(await statusOf(subscriber._id)).toBe('confirmed');
  });
});

describe('idempotency', () => {
  it('does not double-count a redelivered notification', async () => {
    // SNS delivers at least once. All handlers must be idempotent (§8.1).
    const message = notification(
      sesEvent('Delivery', { delivery: { recipients: ['reader@example.com'] } }),
      'sns-duplicate',
    );

    await handleSnsNotification(message);
    await handleSnsNotification(message);
    await handleSnsNotification(message);

    expect((await countsOf(campaign._id))?.delivered).toBe(1);
    expect(await (await eventsCollection()).countDocuments({ type: 'delivered' })).toBe(1);
  });

  it('does not double-count a redelivered complaint', async () => {
    const message = notification(
      sesEvent('Complaint', {
        complaint: { complainedRecipients: [{ emailAddress: 'reader@example.com' }] },
      }),
      'sns-complaint-dup',
    );

    await handleSnsNotification(message);
    await handleSnsNotification(message);

    expect((await countsOf(campaign._id))?.complained).toBe(1);
  });
});

describe('malformed input', () => {
  it('reports unhandled rather than throwing for junk', async () => {
    for (const junk of [null, undefined, 'string', 42, {}, { Type: 'Unknown' }]) {
      const result = await handleSnsNotification(junk);
      expect(result.handled).toBe(false);
    }
  });

  it('reports unhandled when the inner Message is not JSON', async () => {
    const result = await handleSnsNotification({
      Type: 'Notification',
      MessageId: 'x',
      Message: 'not json at all',
    });
    expect(result.handled).toBe(false);
  });

  it('handles an event for an address that is not a known subscriber', async () => {
    const result = await handleSnsNotification(
      notification(
        sesEvent(
          'Bounce',
          {
            bounce: {
              bounceType: 'Permanent',
              bouncedRecipients: [{ emailAddress: 'stranger@example.com' }],
            },
          },
          ['stranger@example.com'],
        ),
      ),
    );

    expect(result.handled).toBe(true);
    // Still suppressed: the address bounced, whether or not we know them.
    expect(await isSuppressed('stranger@example.com')).toBe(true);
  });

  it('accepts the older notificationType field as well as eventType', async () => {
    const result = await handleSnsNotification(
      notification({
        notificationType: 'Complaint',
        mail: { messageId: 'ses-message-1', destination: ['reader@example.com'] },
        complaint: { complainedRecipients: [{ emailAddress: 'reader@example.com' }] },
      }),
    );

    expect(result.action).toBe('complaint');
  });

  it('handles a bounce with several recipients', async () => {
    const second = await createSubscriber(list._id, { email: 'second@example.com' });

    await handleSnsNotification(
      notification(
        sesEvent('Bounce', {
          bounce: {
            bounceType: 'Permanent',
            bouncedRecipients: [
              { emailAddress: 'reader@example.com' },
              { emailAddress: 'second@example.com' },
            ],
          },
        }),
      ),
    );

    expect(await isSuppressed('reader@example.com')).toBe(true);
    expect(await isSuppressed('second@example.com')).toBe(true);
    expect(await statusOf(second._id)).toBe('bounced');
  });
});
