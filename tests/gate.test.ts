import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { after, before, beforeEach, describe, it } from 'node:test';
import { RecordingMailer, createList, createSubscribers, sampleDoc } from './helpers/fixtures';
import { resetCollections, startTestDb, type TestDb } from './helpers/setup';
import { runPreSendGate, collectMergeFields } from '../src/lib/validation';
import { setMailerForTesting } from '../src/lib/mailer';
import { baseSegmentFilter, describeSegment } from '../src/lib/segments';
import { countSegment } from '../src/lib/segments';
import type { ListDoc, TiptapDoc } from '../src/lib/types';

/** The pre-send validation gate (§6.6) and segmentation (§4.2). */

let db: TestDb;
let mailer: RecordingMailer;
let list: ListDoc;

before(async () => {
  db = await startTestDb();
});

after(async () => {
  setMailerForTesting(undefined);
  await db.stop();
});

beforeEach(async () => {
  await resetCollections();
  mailer = new RecordingMailer();
  setMailerForTesting(mailer);
  list = await createList();
  await createSubscribers(list._id, 5);
});

function campaign(overrides: Partial<{ subject: string; preheader: string; bodySource: TiptapDoc }> = {}) {
  return {
    listId: list._id,
    subject: 'Issue #1',
    preheader: '',
    bodySource: sampleDoc(),
    trackOpens: false,
    trackClicks: false,
    segmentQuery: {},
    ...overrides,
  };
}

function check(result: Awaited<ReturnType<typeof runPreSendGate>>, id: string) {
  const found = result.checks.find((c) => c.id === id);
  assert.ok(found, `no check with id ${id}`);
  return found;
}

describe('pre-send gate (§6.6)', () => {
  it('passes a well-formed campaign', async () => {
    const result = await runPreSendGate(campaign(), list, { skipLinkProbe: true });
    assert.equal(result.passed, true, result.checks.filter((c) => !c.passed).map((c) => c.label).join(', '));
    assert.equal(result.recipientCount, 5);
  });

  it('blocks an empty subject line', async () => {
    const result = await runPreSendGate(campaign({ subject: '   ' }), list, { skipLinkProbe: true });
    assert.equal(result.passed, false);
    assert.equal(check(result, 'subject').passed, false);
  });

  it('blocks an empty body', async () => {
    const empty: TiptapDoc = { type: 'doc', content: [{ type: 'paragraph' }] };
    const result = await runPreSendGate(campaign({ bodySource: empty }), list, { skipLinkProbe: true });
    assert.equal(result.passed, false);
    assert.equal(check(result, 'body').passed, false);
  });

  it('blocks an image-only body, which is a spam signal', async () => {
    const imageOnly: TiptapDoc = {
      type: 'doc',
      content: [{ type: 'image', attrs: { src: 'https://example.com/a.png', alt: '' } }],
    };
    const result = await runPreSendGate(campaign({ bodySource: imageOnly }), list, { skipLinkProbe: true });
    assert.equal(result.passed, false);
    assert.match(check(result, 'body').detail ?? '', /image-only|images but no text/i);
  });

  it('blocks a merge field with no fallback and says how to fix it', async () => {
    const body: TiptapDoc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi {{ first_name }}' }] }],
    };
    const result = await runPreSendGate(campaign({ bodySource: body }), list, { skipLinkProbe: true });

    assert.equal(result.passed, false);
    const merge = check(result, 'merge_fallbacks');
    assert.equal(merge.passed, false);
    assert.match(merge.detail ?? '', /default: "there"/);
  });

  it('blocks a merge field that does not exist on the list', async () => {
    const body: TiptapDoc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi {{ nickname | default: "you" }}' }] }],
    };
    const result = await runPreSendGate(campaign({ bodySource: body }), list, { skipLinkProbe: true });

    assert.equal(result.passed, false);
    assert.equal(check(result, 'merge_known').passed, false);
  });

  it('accepts a system merge field without a fallback', async () => {
    const body: TiptapDoc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Sent by {{ list_name }}' }] }],
    };
    const result = await runPreSendGate(campaign({ bodySource: body }), list, { skipLinkProbe: true });
    assert.equal(check(result, 'merge_fallbacks').passed, true);
    assert.equal(check(result, 'merge_known').passed, true);
  });

  it('blocks a relative link', async () => {
    const body: TiptapDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href: '/relative' } }] }],
        },
      ],
    };
    const result = await runPreSendGate(campaign({ bodySource: body }), list, { skipLinkProbe: true });

    assert.equal(result.passed, false);
    assert.equal(check(result, 'links_absolute').passed, false);
  });

  it('blocks when the from-domain is not verified in SES', async () => {
    mailer.identityVerified = false;
    const result = await runPreSendGate(campaign(), list, { skipLinkProbe: true });

    assert.equal(result.passed, false);
    assert.equal(check(result, 'ses_identity').passed, false);
  });

  it('blocks when the list has no physical postal address', async () => {
    const withoutAddress = { ...list, physicalAddress: '' };
    const result = await runPreSendGate(campaign(), withoutAddress, { skipLinkProbe: true });

    assert.equal(result.passed, false);
    assert.equal(check(result, 'physical_address').passed, false);
  });

  it('blocks a segment that matches nobody', async () => {
    const result = await runPreSendGate(
      { ...campaign(), segmentQuery: { attributes: [{ key: 'city', op: 'eq', value: 'Nowhere' }] } },
      list,
      { skipLinkProbe: true },
    );

    assert.equal(result.passed, false);
    assert.equal(check(result, 'recipients').passed, false);
    assert.equal(result.recipientCount, 0);
  });

  it('always asserts the unsubscribe link survived into the rendered email', async () => {
    const result = await runPreSendGate(campaign(), list, { skipLinkProbe: true });
    assert.equal(check(result, 'unsubscribe_placeholder').passed, true);
    assert.equal(check(result, 'address_in_body').passed, true);
  });
});

describe('merge field collection', () => {
  it('finds fields in the subject, preheader and body', () => {
    const found = collectMergeFields({
      subject: 'Hi {{ first_name | default: "there" }}',
      preheader: 'From {{ list_name }}',
      bodySource: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Your city is {{ city }}' }] }],
      },
    });

    assert.deepEqual(
      found.map((f) => `${f.where}:${f.field}`),
      ['subject:first_name', 'preheader:list_name', 'body:city'],
    );
  });
});

describe('segments (§4.2)', () => {
  const listId = new ObjectId();

  it('always constrains to confirmed subscribers on the list', () => {
    const filter = baseSegmentFilter(listId, {});
    assert.equal(filter.status, 'confirmed');
    assert.equal(String(filter.listId), String(listId));
  });

  it('builds date, source and attribute clauses', () => {
    const filter = baseSegmentFilter(listId, {
      signupAfter: '2026-01-01',
      signupBefore: '2026-06-30',
      sources: ['web_form'],
      attributes: [
        { key: 'city', op: 'eq', value: 'London' },
        { key: 'plan', op: 'exists' },
      ],
    }) as Record<string, unknown>;

    assert.deepEqual(filter.source, { $in: ['web_form'] });
    assert.equal(filter['attributes.city'], 'London');
    assert.deepEqual(filter['attributes.plan'], { $exists: true, $nin: ['', null] });
    const createdAt = filter.createdAt as { $gte: Date; $lte: Date };
    assert.ok(createdAt.$gte instanceof Date);
    assert.ok(createdAt.$lte instanceof Date);
  });

  it('ignores an attribute key that is not a plain identifier', () => {
    // Guards against a crafted key reaching into the document with dots or $.
    const filter = baseSegmentFilter(listId, {
      attributes: [{ key: 'a.$where', op: 'eq', value: 'x' }],
    }) as Record<string, unknown>;

    assert.equal(Object.keys(filter).some((key) => key.includes('$where')), false);
  });

  it('ignores an unparseable date rather than matching everything', () => {
    const filter = baseSegmentFilter(listId, { signupAfter: 'not-a-date' }) as Record<string, unknown>;
    assert.equal(filter.createdAt, undefined);
  });

  it('counts what the filter selects', async () => {
    const { collections } = await import('../src/lib/db');
    const c = await collections();
    await c.subscribers.updateOne({ email: 'person0@example.com' }, { $set: { 'attributes.city': 'London' } });

    assert.equal(await countSegment(list._id, {}), 5);
    assert.equal(await countSegment(list._id, { attributes: [{ key: 'city', op: 'eq', value: 'London' }] }), 1);
  });

  it('describes itself in words for the confirmation modal', () => {
    const description = describeSegment({
      sources: ['import'],
      attributes: [{ key: 'city', op: 'eq', value: 'London' }],
      openedInLastNCampaigns: 3,
    });

    assert.match(description, /confirmed subscribers/);
    assert.match(description, /import/);
    assert.match(description, /city = "London"/);
    assert.match(description, /last 3 campaigns/);
  });
});
