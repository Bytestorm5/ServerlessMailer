import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildRecipientHeaders,
  buildReplacements,
  renderCampaignForSend,
  renderCampaignPreview,
} from '@/lib/render/campaign';
import { verifyClickToken, verifyRecipientToken } from '@/lib/crypto/tokens';
import { ensureIndexes } from '@/lib/db/indexes';
import { createCampaign, createList, createSubscriber } from '@tests/helpers/factories';
import type { CampaignDoc, EditorDoc, ListDoc, SubscriberDoc } from '@/lib/types';

let list: ListDoc;
let subscriber: SubscriberDoc;

const bodyWithEverything: EditorDoc = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Hi {{ first_name | default: "there" }}, welcome.' }],
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Our post',
          marks: [{ type: 'link', attrs: { href: 'https://example.com/post' } }],
        },
      ],
    },
  ],
};

beforeEach(async () => {
  await ensureIndexes();
  list = await createList();
  subscriber = await createSubscriber(list._id, {
    email: 'reader@example.com',
    attributes: { first_name: 'Ada' },
  });
});

async function campaignWith(overrides: Partial<CampaignDoc> = {}) {
  return createCampaign(list._id, { bodySource: bodyWithEverything, ...overrides });
}

describe('renderCampaignForSend', () => {
  it('produces HTML and a non-empty plain-text alternative', async () => {
    // §6.2: HTML-only sends are a deliverability penalty; the text part is
    // not optional.
    const campaign = await campaignWith();
    const rendered = await renderCampaignForSend(campaign, list);

    expect(rendered.subject).toBe(campaign.subject);
    expect(rendered.html).toContain('<html');
    expect(rendered.text.trim().length).toBeGreaterThan(0);
    expect(rendered.text).toContain('welcome');
  });

  it('converts merge fields to bare SES placeholders, keeping fallbacks out of the template', async () => {
    const campaign = await campaignWith();
    const rendered = await renderCampaignForSend(campaign, list);

    expect(rendered.html).toContain('{{first_name}}');
    expect(rendered.html).not.toContain('default:');
    expect(rendered.text).toContain('{{first_name}}');
  });

  it('always includes the physical postal address', async () => {
    const campaign = await campaignWith();
    const rendered = await renderCampaignForSend(campaign, list);

    expect(rendered.html).toContain('1 Example Street');
    expect(rendered.text).toContain('1 Example Street');
  });

  it('always includes an unsubscribe placeholder in both parts', async () => {
    const campaign = await campaignWith();
    const rendered = await renderCampaignForSend(campaign, list);

    expect(rendered.html).toContain('{{unsubscribe_url}}');
    expect(rendered.text).toContain('{{unsubscribe_url}}');
  });

  it('leaves links untouched when click tracking is off', async () => {
    const campaign = await campaignWith({ trackClicks: false });
    const rendered = await renderCampaignForSend(campaign, list);

    expect(rendered.html).toContain('https://example.com/post');
    expect(rendered.html).not.toContain('/api/t/c/');
  });

  it('rewrites links through a signed redirector when click tracking is on', async () => {
    const campaign = await campaignWith({ trackClicks: true });
    const rendered = await renderCampaignForSend(campaign, list);

    const match = rendered.html.match(/\/api\/t\/c\/([A-Za-z0-9._~-]+)/);
    expect(match).not.toBeNull();

    // §12: an unsigned redirector is an open redirect and will be abused.
    const target = verifyClickToken(match![1]);
    expect(target?.url).toBe('https://example.com/post');
    expect(target?.campaignId).toBe(campaign._id.toHexString());
  });

  it('carries the per-recipient token in tracked links so clicks are attributable', async () => {
    const campaign = await campaignWith({ trackClicks: true });
    const rendered = await renderCampaignForSend(campaign, list);

    expect(rendered.html).toContain('{{recipient_token}}');
  });

  it('includes an open pixel only when open tracking is on', async () => {
    const off = await renderCampaignForSend(await campaignWith({ trackOpens: false }), list);
    expect(off.html).not.toContain('/api/t/o/');

    const on = await renderCampaignForSend(await campaignWith({ trackOpens: true }), list);
    expect(on.html).toContain('/api/t/o/');
  });

  it('escapes HTML in subscriber-facing text so a body cannot inject markup', async () => {
    const campaign = await campaignWith({
      bodySource: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '<script>alert(1)</script>' }],
          },
        ],
      },
    });
    const rendered = await renderCampaignForSend(campaign, list);

    expect(rendered.html).not.toContain('<script>alert(1)</script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });
});

describe('renderCampaignPreview', () => {
  it('resolves every placeholder so nothing leaks into the preview', async () => {
    // §6.3: preview renders with a real subscriber's merge data so fallbacks
    // get exercised. A preview showing "{{first_name}}" has told you nothing.
    const campaign = await campaignWith();
    const rendered = await renderCampaignPreview(campaign, list, {
      subscriberId: subscriber._id.toHexString(),
      email: subscriber.email,
      attributes: { first_name: 'Ada' },
      unsubscribeUrl: 'https://mail.example.com/api/unsubscribe?t=tok',
    });

    expect(rendered.html).toContain('Ada');
    expect(rendered.html).not.toContain('{{');
    expect(rendered.text).not.toContain('{{');
  });

  it('exercises the declared fallback when the attribute is missing', async () => {
    const campaign = await campaignWith();
    const rendered = await renderCampaignPreview(campaign, list, {
      subscriberId: subscriber._id.toHexString(),
      email: subscriber.email,
      attributes: {},
      unsubscribeUrl: 'https://mail.example.com/api/unsubscribe?t=tok',
    });

    expect(rendered.html).toContain('Hi there');
    expect(rendered.html).not.toContain('Hi ,');
  });
});

describe('buildReplacements', () => {
  it('resolves subscriber attributes with their declared fallbacks applied', async () => {
    const campaign = await campaignWith();

    const withValue = buildReplacements(campaign, list, subscriber);
    expect(withValue.first_name).toBe('Ada');

    const missing = buildReplacements(campaign, list, {
      ...subscriber,
      attributes: {},
    });
    expect(missing.first_name).toBe('there');
  });

  it('prefers the first-party name fields over legacy attribute values', async () => {
    const campaign = await campaignWith();

    const replacements = buildReplacements(campaign, list, {
      ...subscriber,
      firstName: 'Augusta',
      attributes: { first_name: 'Ada' },
    });
    expect(replacements.first_name).toBe('Augusta');

    const firstPartyOnly = buildReplacements(campaign, list, {
      ...subscriber,
      firstName: 'Augusta',
      attributes: {},
    });
    expect(firstPartyOnly.first_name).toBe('Augusta');
  });

  it('provides the system fields every campaign relies on', async () => {
    const campaign = await campaignWith();
    const replacements = buildReplacements(campaign, list, subscriber);

    expect(replacements.email).toBe('reader@example.com');
    expect(replacements.physical_address).toBe(list.physicalAddress);
    expect(replacements.list_name).toBe(list.name);
    expect(replacements.unsubscribe_url).toContain('/api/unsubscribe?t=');
    expect(replacements.recipient_token).toBeTruthy();
  });

  it('signs the unsubscribe token to this subscriber and campaign', async () => {
    const campaign = await campaignWith();
    const replacements = buildReplacements(campaign, list, subscriber);

    const token = new URL(replacements.unsubscribe_url).searchParams.get('t')!;
    const verified = verifyRecipientToken(token);

    expect(verified).toEqual({
      subscriberId: subscriber._id.toHexString(),
      campaignId: campaign._id.toHexString(),
    });
  });

  it('never emits the literal string "undefined" for a missing attribute', async () => {
    const campaign = await campaignWith();
    const replacements = buildReplacements(campaign, list, { ...subscriber, attributes: {} });

    for (const value of Object.values(replacements)) {
      expect(value).not.toContain('undefined');
      expect(typeof value).toBe('string');
    }
  });
});

describe('buildRecipientHeaders', () => {
  it('sets both bulk-sender unsubscribe headers', async () => {
    // §9.1: both are mandatory under the Google and Yahoo bulk sender
    // requirements at this volume.
    const campaign = await campaignWith();
    const headers = buildRecipientHeaders(campaign, list, subscriber);

    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(headers['List-Unsubscribe']).toMatch(/^<.+>$|^<.+>, <.+>$/);
    expect(headers['List-Unsubscribe']).toContain('/api/unsubscribe?t=');
  });

  it('includes the mailto form when one is configured', async () => {
    const previous = process.env.UNSUBSCRIBE_MAILTO;
    process.env.UNSUBSCRIBE_MAILTO = 'unsubscribe@news.domain-a.com';
    try {
      const campaign = await campaignWith();
      const headers = buildRecipientHeaders(campaign, list, subscriber);
      expect(headers['List-Unsubscribe']).toContain('<mailto:unsubscribe@news.domain-a.com>');
      expect(headers['List-Unsubscribe']).toContain('https://');
    } finally {
      if (previous === undefined) delete process.env.UNSUBSCRIBE_MAILTO;
      else process.env.UNSUBSCRIBE_MAILTO = previous;
    }
  });

  it('produces a token that resolves back to this subscriber and campaign', async () => {
    const campaign = await campaignWith();
    const headers = buildRecipientHeaders(campaign, list, subscriber);

    const url = headers['List-Unsubscribe'].match(/<(https:[^>]+)>/)![1];
    const token = new URL(url).searchParams.get('t')!;

    expect(verifyRecipientToken(token)).toEqual({
      subscriberId: subscriber._id.toHexString(),
      campaignId: campaign._id.toHexString(),
    });
  });
});
