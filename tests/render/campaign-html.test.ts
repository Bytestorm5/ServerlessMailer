import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildReplacements,
  campaignBodyMode,
  campaignTemplateText,
  renderCampaignForSend,
  renderCampaignPreview,
} from '@/lib/render/campaign';
import { verifyClickToken } from '@/lib/crypto/tokens';
import { ensureIndexes } from '@/lib/db/indexes';
import { DEFAULT_TEMPLATE_HTML } from '@/lib/render/template';
import { createCampaign, createList, createSubscriber } from '@tests/helpers/factories';
import type { CampaignDoc, ListDoc, RecipientContext, SubscriberDoc } from '@/lib/types';

/**
 * The two render paths that templates and HTML bodies add (§6.2a).
 *
 * The invariants are the ones the MJML path already had, and they do not become
 * negotiable because the operator wrote the markup: merge fields survive to
 * SES, click tracking rewrites the body but never the unsubscribe link, and the
 * text alternative is never empty.
 */

const TEMPLATE = [
  '<!DOCTYPE html><html><head><style>.body p { color: #222; }</style></head>',
  '<body><div class="wrap"><h1>{{list_name}}</h1>',
  '<div class="body">{{content}}</div>',
  '<footer><p>{{physical_address}}</p><a href="{{unsubscribe_url}}">Unsubscribe</a></footer>',
  '</div></body></html>',
].join('');

const FRAGMENT = [
  '<h2>Weekly update</h2>',
  '<p>Hi {{ first_name | default: "there" }}, here is the news.</p>',
  '<p><a href="https://example.com/post">Read more</a></p>',
].join('');

let list: ListDoc;
let subscriber: SubscriberDoc;

beforeEach(async () => {
  await ensureIndexes();
  list = await createList();
  subscriber = await createSubscriber(list._id, {
    email: 'reader@example.com',
    attributes: { first_name: 'Ada' },
  });
});

function previewContext(): RecipientContext {
  return {
    subscriberId: subscriber._id.toHexString(),
    email: subscriber.email,
    attributes: subscriber.attributes,
    unsubscribeUrl: 'https://mail.example.com/api/unsubscribe?t=tok',
    trackingToken: 'tok',
  };
}

async function htmlCampaign(overrides: Partial<CampaignDoc> = {}) {
  return createCampaign(list._id, {
    bodyMode: 'html',
    bodyHtmlSource: FRAGMENT,
    ...overrides,
  });
}

describe('campaignBodyMode', () => {
  it('treats a campaign written before HTML mode existed as rich', async () => {
    const campaign = await createCampaign(list._id);
    expect(campaignBodyMode(campaign)).toBe('rich');
    expect(campaignBodyMode({ ...campaign, bodyMode: 'html' })).toBe('html');
  });
});

describe('rich body through a custom template', () => {
  it('renders the body into the template slot instead of the MJML layout', async () => {
    const campaign = await createCampaign(list._id);
    const rendered = await renderCampaignForSend(campaign, list, TEMPLATE);

    expect(rendered.html).toContain('class="wrap"');
    expect(rendered.html).toContain('Weekly update');
    // The MJML shell is gone; this is the operator's document now.
    expect(rendered.html).not.toContain('mj-');
  });

  it('falls back to the MJML layout when the list has no template', async () => {
    const campaign = await createCampaign(list._id);
    const rendered = await renderCampaignForSend(campaign, list, null);

    expect(rendered.html).toContain('<html');
    expect(rendered.html).not.toContain('class="wrap"');
  });

  it('still carries the unsubscribe placeholder and the postal address', async () => {
    const campaign = await createCampaign(list._id);
    const rendered = await renderCampaignForSend(campaign, list, TEMPLATE);

    expect(rendered.html).toContain('{{unsubscribe_url}}');
    expect(rendered.html).toContain(list.physicalAddress.slice(0, 24));
    expect(rendered.text).toContain('{{unsubscribe_url}}');
  });
});

describe('pasted HTML body', () => {
  it('renders a fragment through the list template', async () => {
    const campaign = await htmlCampaign();
    const rendered = await renderCampaignForSend(campaign, list, TEMPLATE);

    expect(rendered.html).toContain('class="wrap"');
    expect(rendered.html).toContain('<h2>Weekly update</h2>');
  });

  it('renders a fragment through the default template when the list has none', async () => {
    // A fragment with no document around it is not an email, so there is
    // always a template — the built-in one when the list has not chosen.
    const campaign = await htmlCampaign();
    const rendered = await renderCampaignForSend(campaign, list, null);

    expect(rendered.html).toContain('<!DOCTYPE html>');
    expect(rendered.html).toContain('Weekly update');
    expect(rendered.html).toContain(list.name);
  });

  it('treats a whole document as the email and skips the template', async () => {
    const campaign = await htmlCampaign({
      bodyHtmlSource:
        '<!DOCTYPE html><html><body><table><tr><td>Designed elsewhere.</td></tr></table></body></html>',
    });
    const rendered = await renderCampaignForSend(campaign, list, TEMPLATE);

    expect(rendered.html).toContain('Designed elsewhere.');
    expect(rendered.html).not.toContain('class="wrap"');
    // The chrome guarantees are not part of the template — they are the law.
    expect(rendered.html).toContain('{{unsubscribe_url}}');
    expect(rendered.html).toContain(list.physicalAddress.slice(0, 24));
  });

  it('reduces merge fields to bare SES placeholders', async () => {
    const campaign = await htmlCampaign();
    const rendered = await renderCampaignForSend(campaign, list, TEMPLATE);

    expect(rendered.html).toContain('{{first_name}}');
    expect(rendered.html).not.toContain('default:');
  });

  it('generates a plain-text alternative from the markup', async () => {
    const campaign = await htmlCampaign();
    const rendered = await renderCampaignForSend(campaign, list, TEMPLATE);

    expect(rendered.text).toContain('Weekly update');
    expect(rendered.text).toContain('Read more (https://example.com/post)');
    expect(rendered.text).toContain(list.physicalAddress);
  });

  it('strips active content before it reaches an inbox', async () => {
    const campaign = await htmlCampaign({
      bodyHtmlSource: '<p onclick="alert(1)">Hi</p><script>alert(2)</script>',
    });
    const rendered = await renderCampaignForSend(campaign, list, TEMPLATE);

    expect(rendered.html).toContain('Hi');
    expect(rendered.html).not.toContain('alert(');
  });
});

describe('click tracking on a pasted HTML body', () => {
  it('signs each body link and leaves the unsubscribe link alone', async () => {
    const campaign = await htmlCampaign({
      trackClicks: true,
      bodyHtmlSource:
        '<p><a href="https://example.com/post">Read</a></p>' +
        '<p><a href="{{unsubscribe_url}}">Out</a></p>' +
        '<p><a href="mailto:hi@example.com">Mail</a></p>',
    });
    const rendered = await renderCampaignForSend(campaign, list, TEMPLATE);

    const match = /\/api\/t\/c\/([A-Za-z0-9._~-]+)\?r=\{\{recipient_token\}\}/.exec(rendered.html);
    expect(match).not.toBeNull();

    const verified = verifyClickToken(match![1]);
    expect(verified).toMatchObject({
      campaignId: campaign._id.toHexString(),
      url: 'https://example.com/post',
      linkIndex: 0,
    });

    // One-click unsubscribe must not be routed through a redirector, and
    // mailto: is not a redirect target at all.
    expect(rendered.html).toContain('href="{{unsubscribe_url}}"');
    expect(rendered.html).toContain('mailto:hi@example.com');
  });

  it('does not rewrite anything when tracking is off', async () => {
    const campaign = await htmlCampaign({ trackClicks: false });
    const rendered = await renderCampaignForSend(campaign, list, TEMPLATE);

    expect(rendered.html).toContain('https://example.com/post');
    expect(rendered.html).not.toContain('/api/t/c/');
  });

  it('signs an entity-encoded href as the URL a client would follow', async () => {
    const campaign = await htmlCampaign({
      trackClicks: true,
      bodyHtmlSource: '<a href="https://example.com/p?a=1&amp;b=2">Read</a>',
    });
    const rendered = await renderCampaignForSend(campaign, list, TEMPLATE);
    const match = /\/api\/t\/c\/([A-Za-z0-9._~-]+)\?/.exec(rendered.html);

    expect(verifyClickToken(match![1])).toMatchObject({
      url: 'https://example.com/p?a=1&b=2',
    });
  });
});

describe('previewing a pasted HTML body', () => {
  it('resolves merge fields and the unsubscribe link', async () => {
    const campaign = await htmlCampaign();
    const rendered = await renderCampaignPreview(campaign, list, previewContext(), TEMPLATE);

    expect(rendered.html).toContain('Hi Ada');
    expect(rendered.html).toContain('https://mail.example.com/api/unsubscribe?t=tok');
    expect(rendered.html).not.toContain('{{');
  });

  it('resolves the recipient token in a tracked link', async () => {
    const campaign = await htmlCampaign({ trackClicks: true });
    const rendered = await renderCampaignPreview(campaign, list, previewContext(), TEMPLATE);

    expect(rendered.html).toContain('?r=tok');
    expect(rendered.html).not.toContain('{{recipient_token}}');
  });

  it('falls back to the declared default for a subscriber with no value', async () => {
    const campaign = await htmlCampaign();
    const rendered = await renderCampaignPreview(
      campaign,
      list,
      { ...previewContext(), attributes: {} },
      TEMPLATE,
    );

    expect(rendered.html).toContain('Hi there');
  });
});

describe('merge fields declared in the template shell', () => {
  const greeting = TEMPLATE.replace(
    '{{content}}',
    '<p>Hello {{ first_name | default: "there" }}</p>{{content}}',
  );

  it('are collected from the template as well as the body', async () => {
    const campaign = await createCampaign(list._id);
    const text = campaignTemplateText(campaign, greeting);

    expect(text).toContain('first_name');
    // The template-only placeholders are not merge fields and must not reach
    // the scanner, which would report them as unknown and block every send.
    expect(text).not.toContain('{{content}}');
  });

  it('are resolved per recipient from the copy frozen onto the campaign', async () => {
    // The frozen copy, not the list's current template: editing the template
    // mid-send must not change what SES substitutes into an already-frozen body.
    const campaign = await createCampaign(list._id, { templateSource: greeting });
    const replacements = buildReplacements(campaign, list, subscriber);

    expect(replacements.first_name).toBe('Ada');
    expect(replacements.unsubscribe_url).toContain('/api/unsubscribe?t=');
  });

  it('fall back for a subscriber with no value, rather than rendering blank', async () => {
    const campaign = await createCampaign(list._id, { templateSource: greeting });
    const anonymous = await createSubscriber(list._id, { email: 'anon@example.com' });

    expect(buildReplacements(campaign, list, anonymous).first_name).toBe('there');
  });
});

describe('the default template as a starting point', () => {
  it('renders a campaign end to end', async () => {
    const campaign = await createCampaign(list._id);
    const rendered = await renderCampaignForSend(campaign, list, DEFAULT_TEMPLATE_HTML);

    expect(rendered.html).toContain(list.name);
    expect(rendered.html).toContain('{{unsubscribe_url}}');
    expect(rendered.html).toContain(list.physicalAddress.slice(0, 24));
    expect(rendered.text).toContain('Weekly update');
  });
});
