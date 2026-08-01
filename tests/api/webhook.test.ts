import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectId } from 'mongodb';
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

// The signature verification itself is exercised exhaustively in
// tests/sns/verify.test.ts against real RSA signatures. Here the concern is the
// route's wiring: that a message which fails verification never reaches the
// handler, and that one which passes does.
const verifySnsMessage = vi.hoisted(() => vi.fn());
vi.mock('@/lib/sns/verify', () => ({ verifySnsMessage }));

const { POST } = await import('@/app/api/webhooks/ses/route');

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
  await (await sentLogCollection()).insertOne({
    _id: new ObjectId(),
    campaignId: campaign._id,
    subscriberId: subscriber._id,
    sesMessageId: 'ses-1',
    sentAt: new Date(),
  });
  verifySnsMessage.mockResolvedValue(true);
});

afterEach(() => {
  verifySnsMessage.mockReset();
});

function post(body: unknown) {
  return POST(
    new Request('https://mail.example.com/api/webhooks/ses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

const complaint = {
  Type: 'Notification',
  MessageId: 'sns-1',
  Message: JSON.stringify({
    eventType: 'Complaint',
    mail: { messageId: 'ses-1', destination: ['reader@example.com'] },
    complaint: { complainedRecipients: [{ emailAddress: 'reader@example.com' }] },
  }),
};

describe('POST /api/webhooks/ses — signature verification', () => {
  it('processes a verified notification', async () => {
    const response = await post(complaint);

    expect(response.status).toBe(200);
    expect(await isSuppressed('reader@example.com')).toBe(true);
  });

  it('refuses an unverified message with 403 and does no work', async () => {
    // Spoofing this endpoint means an attacker can suppress the entire list.
    verifySnsMessage.mockResolvedValue(false);

    const response = await post(complaint);

    expect(response.status).toBe(403);
    expect(await isSuppressed('reader@example.com')).toBe(false);
    expect(await (await suppressionsCollection()).countDocuments()).toBe(0);
  });

  it('does not use 500 for an unverified message, so SNS will not retry it', async () => {
    verifySnsMessage.mockResolvedValue(false);
    const response = await post(complaint);
    expect(response.status).not.toBe(500);
  });

  it('verifies before touching the handler at all', async () => {
    verifySnsMessage.mockResolvedValue(false);
    await post(complaint);
    expect(verifySnsMessage).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/webhooks/ses — payloads', () => {
  it('rejects a body that is not JSON', async () => {
    expect((await post('{not json')).status).toBe(400);
  });

  it('rejects a JSON body that is not an object', async () => {
    expect((await post('"a string"')).status).toBe(400);
  });

  it('acknowledges a verified but non-actionable message', async () => {
    // Acknowledging stops SNS retrying something we understand and can ignore.
    const response = await post({ Type: 'Notification', MessageId: 'x', Message: 'not json' });

    expect(response.status).toBe(200);
    expect((await response.json()).handled).toBe(false);
  });

  it('is idempotent across redelivery', async () => {
    await post(complaint);
    await post(complaint);
    await post(complaint);

    const doc = await (await campaignsCollection()).findOne({ _id: campaign._id });
    expect(doc?.counts.complained).toBe(1);
    expect(await (await suppressionsCollection()).countDocuments()).toBe(1);
  });

  it('returns 500 so SNS retries when the handler throws', async () => {
    const handleModule = await import('@/lib/sns/handle');
    vi.spyOn(handleModule, 'handleSnsNotification').mockRejectedValue(new Error('db down'));

    const response = await post(complaint);
    expect(response.status).toBe(500);
  });
});
