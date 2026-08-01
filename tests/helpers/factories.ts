import { ObjectId } from 'mongodb';
import {
  campaignsCollection,
  listsCollection,
  subscribersCollection,
  suppressionsCollection,
} from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import type {
  CampaignDoc,
  EditorDoc,
  ListDoc,
  SubscriberDoc,
  SubscriberStatus,
  SuppressionDoc,
} from '@/lib/types';

export const emptyCounts = () => ({
  recipients: 0,
  sent: 0,
  failed: 0,
  bounced: 0,
  complained: 0,
  unsubscribed: 0,
  delivered: 0,
  opened: 0,
  clicked: 0,
});

export function sampleDoc(text = 'Hello world, this is a newsletter body.'): EditorDoc {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

/** A body that satisfies the pre-send gate: prose plus an unsubscribe link. */
export function validCampaignDoc(): EditorDoc {
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Weekly update' }] },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Hello {{ first_name | default: "there" }}, here is the news.' }],
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'Read more',
            marks: [{ type: 'link', attrs: { href: 'https://example.com/post' } }],
          },
        ],
      },
      { type: 'paragraph', content: [{ type: 'text', text: '{{ unsubscribe_url }}' }] },
    ],
  };
}

export async function createList(overrides: Partial<ListDoc> = {}): Promise<ListDoc> {
  await ensureIndexes();
  const doc: ListDoc = {
    _id: new ObjectId(),
    name: 'Domain A Weekly',
    sendingDomain: 'news.domain-a.com',
    fromName: 'Domain A',
    fromEmail: 'hello@news.domain-a.com',
    replyTo: 'hello@domain-a.com',
    physicalAddress: '1 Example Street, London, EC1A 1AA, United Kingdom',
    sesConfigurationSet: 'domain-a-config',
    active: true,
    welcomeUrl: 'https://domain-a.com/welcome',
    createdAt: new Date(),
    ...overrides,
  };
  await (await listsCollection()).insertOne(doc);
  return doc;
}

export async function createSubscriber(
  listId: ObjectId,
  overrides: Partial<SubscriberDoc> = {},
): Promise<SubscriberDoc> {
  const email = overrides.email ?? `user-${new ObjectId().toHexString()}@example.com`;
  const status: SubscriberStatus = overrides.status ?? 'confirmed';
  const doc: SubscriberDoc = {
    _id: new ObjectId(),
    listId,
    email,
    emailDomain: email.split('@')[1] ?? '',
    status,
    attributes: {},
    source: 'web_form',
    createdAt: new Date(),
    ...(status === 'confirmed'
      ? {
          confirmedAt: new Date(),
          confirmIp: '203.0.113.7',
          confirmUserAgent: 'Mozilla/5.0 (test)',
        }
      : {}),
    history: [],
    ...overrides,
  };
  await (await subscribersCollection()).insertOne(doc);
  return doc;
}

export async function createSubscribers(
  listId: ObjectId,
  count: number,
  overrides: Partial<SubscriberDoc> = {},
): Promise<SubscriberDoc[]> {
  const out: SubscriberDoc[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(
      await createSubscriber(listId, { email: `bulk-${i}@example.com`, ...overrides }),
    );
  }
  return out;
}

export async function createCampaign(
  listId: ObjectId,
  overrides: Partial<CampaignDoc> = {},
): Promise<CampaignDoc> {
  const doc: CampaignDoc = {
    _id: new ObjectId(),
    listId,
    subject: 'This week from Domain A',
    preheader: 'The short version, up top.',
    bodySource: validCampaignDoc(),
    status: 'draft',
    segmentQuery: {},
    trackOpens: false,
    trackClicks: false,
    counts: emptyCounts(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  await (await campaignsCollection()).insertOne(doc);
  return doc;
}

export async function createSuppression(
  overrides: Partial<SuppressionDoc> & { email: string },
): Promise<SuppressionDoc> {
  const doc: SuppressionDoc = {
    _id: new ObjectId(),
    reason: 'hard_bounce',
    createdAt: new Date(),
    ...overrides,
  };
  await (await suppressionsCollection()).insertOne(doc);
  return doc;
}
