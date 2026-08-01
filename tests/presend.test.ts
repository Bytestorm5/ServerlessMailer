import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { validateCampaignForSend } from '@/lib/presend';
import { campaignsCollection, listsCollection, subscribersCollection } from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import { resetSesAdapter, setSesAdapter } from '@/lib/ses/registry';
import { createCampaign, createList, createSubscriber, validCampaignDoc } from '@tests/helpers/factories';
import { FakeSes } from '@tests/helpers/fake-ses';
import type { CampaignDoc, EditorDoc, ListDoc } from '@/lib/types';

let list: ListDoc;
let ses: FakeSes;

beforeEach(async () => {
  await ensureIndexes();
  await Promise.all([
    (await campaignsCollection()).deleteMany({}),
    (await subscribersCollection()).deleteMany({}),
    (await listsCollection()).deleteMany({}),
  ]);
  list = await createList();
  ses = new FakeSes();
  ses.verifiedIdentities.add('news.domain-a.com');
  setSesAdapter(ses);
  // A recipient, so recipient_count passes unless a test says otherwise.
  await createSubscriber(list._id, { email: 'reader@example.com' });
});

afterEach(() => {
  resetSesAdapter();
});

async function gate(overrides: Partial<CampaignDoc> = {}) {
  const campaign = await createCampaign(list._id, {
    bodySource: validCampaignDoc(),
    ...overrides,
  });
  return validateCampaignForSend(campaign._id);
}

function checkFor(result: Awaited<ReturnType<typeof validateCampaignForSend>>, id: string) {
  const check = result.checks.find((c) => c.id === id);
  if (!check) throw new Error(`no check with id "${id}" — got ${result.checks.map((c) => c.id).join(', ')}`);
  return check;
}

describe('a campaign that should pass', () => {
  it('passes every check', async () => {
    const result = await gate();

    expect(result.passed).toBe(true);
    expect(result.recipientCount).toBe(1);
    expect(result.checks.every((check) => check.passed)).toBe(true);
  });

  it('covers every check the spec lists', async () => {
    // §6.6 is a fixed table; a check silently disappearing would be a hole.
    const result = await gate();
    const ids = result.checks.map((check) => check.id);

    expect(ids).toEqual(
      expect.arrayContaining([
        'subject',
        'body_non_empty',
        'physical_address',
        'unsubscribe_placeholder',
        'merge_fallbacks',
        'links_absolute',
        'from_domain_verified',
        'recipient_count',
      ]),
    );
  });
});

describe('each check fails independently', () => {
  it('fails on a missing campaign', async () => {
    const result = await validateCampaignForSend(new ObjectId());
    expect(result.passed).toBe(false);
    expect(checkFor(result, 'campaign_exists').passed).toBe(false);
  });

  it('fails when the sending list has gone', async () => {
    const campaign = await createCampaign(list._id, { bodySource: validCampaignDoc() });
    await (await listsCollection()).deleteOne({ _id: list._id });

    const result = await validateCampaignForSend(campaign._id);
    expect(checkFor(result, 'list_exists').passed).toBe(false);
  });

  it.each([['empty', ''], ['whitespace only', '   ']])(
    'fails on a %s subject line',
    async (_label, subject) => {
      const result = await gate({ subject });
      expect(result.passed).toBe(false);
      expect(checkFor(result, 'subject').passed).toBe(false);
    },
  );

  it('fails on an empty body', async () => {
    const result = await gate({ bodySource: { type: 'doc', content: [] } });
    expect(checkFor(result, 'body_non_empty').passed).toBe(false);
    expect(checkFor(result, 'body_non_empty').detail).toMatch(/empty/i);
  });

  it('fails on an image-only body', async () => {
    // §6.6: image-only bodies are a spam signal.
    const imageOnly: EditorDoc = {
      type: 'doc',
      content: [{ type: 'image', attrs: { src: 'https://cdn.example.com/a.png' } }],
    };
    const result = await gate({ bodySource: imageOnly });

    expect(checkFor(result, 'body_non_empty').passed).toBe(false);
    expect(checkFor(result, 'body_non_empty').detail).toMatch(/spam/i);
  });

  it('fails on a body using an unsupported node', async () => {
    const result = await gate({
      bodySource: {
        type: 'doc',
        content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'rm -rf /' }] }],
      },
    });
    expect(checkFor(result, 'body_valid').passed).toBe(false);
  });

  it('fails when the list has no physical postal address', async () => {
    const bare = await createList({ name: 'No address', physicalAddress: '   ' });
    await createSubscriber(bare._id, { email: 'x@example.com' });
    const campaign = await createCampaign(bare._id, { bodySource: validCampaignDoc() });

    const result = await validateCampaignForSend(campaign._id);
    expect(checkFor(result, 'physical_address').passed).toBe(false);
    expect(checkFor(result, 'physical_address').detail).toMatch(/legally required/i);
  });

  it('fails when a merge field has no fallback', async () => {
    // Prevents "Hi ," reaching 19,000 people.
    const result = await gate({
      bodySource: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Hi {{ first_name }},' }] },
          { type: 'paragraph', content: [{ type: 'text', text: '{{ unsubscribe_url }}' }] },
        ],
      },
    });

    expect(result.passed).toBe(false);
    expect(checkFor(result, 'merge_fallbacks').passed).toBe(false);
    expect(checkFor(result, 'merge_fallbacks').detail).toContain('first_name');
  });

  it('does not require a fallback on a system field', async () => {
    const result = await gate({
      bodySource: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Address: {{ physical_address }}' }] },
          { type: 'paragraph', content: [{ type: 'text', text: '{{ unsubscribe_url }}' }] },
        ],
      },
    });

    expect(checkFor(result, 'merge_fallbacks').passed).toBe(true);
  });

  it('fails on a merge field nobody has heard of', async () => {
    const result = await gate({
      bodySource: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Hi {{ favourite_colour | default: "blue" }}' }],
          },
        ],
      },
    });

    expect(checkFor(result, 'merge_fields_known').passed).toBe(false);
    expect(checkFor(result, 'merge_fields_known').detail).toContain('favourite_colour');
  });

  it('fails on a relative link', async () => {
    // A relative URL resolves against the mailbox provider's domain and is
    // simply broken.
    const result = await gate({
      bodySource: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'read more',
                marks: [{ type: 'link', attrs: { href: '/blog/post' } }],
              },
            ],
          },
        ],
      },
    });

    expect(checkFor(result, 'links_absolute').passed).toBe(false);
    expect(checkFor(result, 'links_absolute').detail).toContain('/blog/post');
  });

  it('fails when the from-domain is not verified in SES', async () => {
    ses.verifiedIdentities.clear();

    const result = await gate();
    expect(result.passed).toBe(false);
    expect(checkFor(result, 'from_domain_verified').passed).toBe(false);
  });

  it('fails when the SES identity check itself errors', async () => {
    // An unreachable SES is not permission to send.
    setSesAdapter({
      ...ses,
      isIdentityVerified: async () => {
        throw new Error('SES unreachable');
      },
    });

    const result = await gate();
    expect(checkFor(result, 'from_domain_verified').passed).toBe(false);
    expect(checkFor(result, 'from_domain_verified').detail).toContain('SES unreachable');
  });

  it('fails when the segment matches nobody', async () => {
    await (await subscribersCollection()).deleteMany({});

    const result = await gate();
    expect(result.recipientCount).toBe(0);
    expect(checkFor(result, 'recipient_count').passed).toBe(false);
    expect(checkFor(result, 'recipient_count').detail).toMatch(/nobody/i);
  });

  it('counts only confirmed subscribers as recipients', async () => {
    await createSubscriber(list._id, { email: 'pending@example.com', status: 'pending' });
    await createSubscriber(list._id, { email: 'gone@example.com', status: 'unsubscribed' });

    const result = await gate();
    expect(result.recipientCount).toBe(1);
  });
});

describe('the rendered-output checks', () => {
  it('confirms the unsubscribe link and postal address survive rendering', async () => {
    // Checked against the rendered output, not the source, so a regression in
    // the email template that dropped either is caught before the send rather
    // than by a regulator afterwards.
    const result = await gate();

    expect(checkFor(result, 'renders').passed).toBe(true);
    expect(checkFor(result, 'unsubscribe_placeholder').passed).toBe(true);
    expect(checkFor(result, 'physical_address_rendered').passed).toBe(true);
  });
});

describe('the gate offers no way through', () => {
  it('reports passed=false whenever any single check fails', async () => {
    const result = await gate({ subject: '' });

    expect(result.checks.filter((c) => !c.passed)).toHaveLength(1);
    expect(result.passed).toBe(false);
  });

  it('takes no argument that could disable a check', () => {
    // §6.6: hard block, no override. The signature is (campaignId, now?) and
    // nothing else, so there is no bypass to pass in.
    expect(validateCampaignForSend.length).toBeLessThanOrEqual(2);
  });
});
