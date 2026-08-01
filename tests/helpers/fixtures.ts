import { ObjectId } from 'mongodb';
import type {
  BulkSendParams,
  BulkSendResult,
  Mailer,
  TransactionalMessage,
} from '../../src/lib/mailer';
import type { CampaignDoc, ListDoc, SubscriberDoc, TiptapDoc } from '../../src/lib/types';

/** A mailer that records what it was asked to send and can be told to fail. */
export class RecordingMailer implements Mailer {
  bulkCalls: BulkSendParams[] = [];
  transactionalCalls: TransactionalMessage[] = [];
  /** Set to throw on the next bulk send — used for the throttling path. */
  throwOnBulk: Error | null = null;
  /** Indexes within a batch that should come back as per-destination failures. */
  failIndexes = new Set<number>();
  identityVerified = true;

  get destinationCount(): number {
    return this.bulkCalls.reduce((total, call) => total + call.destinations.length, 0);
  }

  get recipients(): string[] {
    return this.bulkCalls.flatMap((call) => call.destinations.map((d) => d.to));
  }

  async sendTransactional(message: TransactionalMessage): Promise<{ messageId: string | null }> {
    this.transactionalCalls.push(message);
    return { messageId: `test-${this.transactionalCalls.length}` };
  }

  async sendBulk(params: BulkSendParams): Promise<BulkSendResult> {
    if (this.throwOnBulk) {
      const error = this.throwOnBulk;
      this.throwOnBulk = null;
      throw error;
    }
    this.bulkCalls.push(params);
    return {
      outcomes: params.destinations.map((_destination, index) =>
        this.failIndexes.has(index)
          ? { ok: false as const, error: 'MESSAGE_REJECTED: test failure' }
          : { ok: true as const, messageId: new ObjectId().toHexString() },
      ),
    };
  }

  async isIdentityVerified(): Promise<boolean> {
    return this.identityVerified;
  }

  reset(): void {
    this.bulkCalls = [];
    this.transactionalCalls = [];
    this.throwOnBulk = null;
    this.failIndexes = new Set();
  }
}

export function sampleDoc(text = 'Hello {{ first_name | default: "there" }}, welcome.'): TiptapDoc {
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'This week' }] },
      { type: 'paragraph', content: [{ type: 'text', text }] },
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
    ],
  };
}

export async function createList(overrides: Partial<ListDoc> = {}): Promise<ListDoc> {
  const { collections } = await import('../../src/lib/db');
  const c = await collections();
  const now = new Date();
  const doc = {
    name: 'Test Weekly',
    sendingDomain: 'news.test.com',
    fromName: 'Test',
    fromEmail: 'hello@news.test.com',
    replyTo: 'hello@test.com',
    physicalAddress: 'Test Ltd, 1 Test Street, Testville',
    sesConfigurationSet: 'test-set',
    active: true,
    welcomeUrl: '',
    mergeFields: ['city'],
    seedEmails: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Omit<ListDoc, '_id'>;
  const result = await c.lists.insertOne(doc as ListDoc);
  return { ...doc, _id: result.insertedId } as ListDoc;
}

export async function createSubscribers(
  listId: ObjectId,
  count: number,
  overrides: Partial<SubscriberDoc> = {},
): Promise<SubscriberDoc[]> {
  const { collections } = await import('../../src/lib/db');
  const c = await collections();
  const now = new Date();
  const docs: Omit<SubscriberDoc, '_id'>[] = [];
  for (let i = 0; i < count; i += 1) {
    docs.push({
      listId,
      email: `person${i}@example.com`,
      emailDomain: 'example.com',
      status: 'confirmed',
      attributes: { first_name: i % 3 === 0 ? '' : `Person${i}`, city: 'Testville' },
      source: 'web_form',
      createdAt: now,
      updatedAt: now,
      confirmedAt: now,
      confirmIp: '203.0.113.1',
      confirmUserAgent: 'test-agent',
      ...overrides,
    });
  }
  const result = await c.subscribers.insertMany(docs as SubscriberDoc[]);
  return docs.map((doc, index) => ({ ...doc, _id: result.insertedIds[index] }) as SubscriberDoc);
}

export async function createCampaign(
  listId: ObjectId,
  overrides: Partial<CampaignDoc> = {},
): Promise<CampaignDoc> {
  const { collections } = await import('../../src/lib/db');
  const { EMPTY_COUNTS } = await import('../../src/lib/campaigns');
  const c = await collections();
  const now = new Date();
  const doc = {
    listId,
    name: 'Test campaign',
    subject: 'Issue #1',
    preheader: 'The first one',
    bodySource: sampleDoc(),
    bodyHtml: null,
    bodyText: null,
    subjectTemplate: null,
    mergePlan: null,
    trackedLinks: null,
    status: 'draft',
    segmentQuery: {},
    scheduledFor: null,
    frozenAt: null,
    startedAt: null,
    completedAt: null,
    pausedAt: null,
    pauseReason: null,
    trackOpens: false,
    trackClicks: false,
    counts: { ...EMPTY_COUNTS },
    createdAt: now,
    updatedAt: now,
    lastEditedAt: now,
    ...overrides,
  } as Omit<CampaignDoc, '_id'>;
  const result = await c.campaigns.insertOne(doc as CampaignDoc);
  return { ...doc, _id: result.insertedId } as CampaignDoc;
}
