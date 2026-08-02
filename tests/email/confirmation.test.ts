import { beforeAll, describe, expect, it } from 'vitest';
import { buildConfirmationEmail, confirmationUrl } from '@/lib/email/confirmation';
import type { ListDoc } from '@/lib/types';
import { ObjectId } from 'mongodb';

const list: ListDoc = {
  _id: new ObjectId(),
  name: 'Domain A Weekly',
  sendingDomain: 'news.domain-a.com',
  fromName: 'Domain A',
  fromEmail: 'hello@news.domain-a.com',
  replyTo: 'hello@domain-a.com',
  physicalAddress: '1 Example Street, London, EC1A 1AA',
  sesConfigurationSet: 'domain-a-config',
  active: true,
  createdAt: new Date(),
};

describe('confirmationUrl', () => {
  it('builds an absolute URL carrying the raw token', () => {
    const url = confirmationUrl('abc123');
    expect(url).toBe('https://mail.example.com/api/confirm?token=abc123');
  });

  it('percent-encodes a token containing URL-significant characters', () => {
    expect(confirmationUrl('a+b/c=d')).toContain('token=a%2Bb%2Fc%3Dd');
  });
});

describe('buildConfirmationEmail — the built-in layout', () => {
  let email: Awaited<ReturnType<typeof buildConfirmationEmail>>;

  beforeAll(async () => {
    email = await buildConfirmationEmail({ list, token: 'tok-123' });
  });

  it('has a clear, transactional subject naming the list', () => {
    expect(email.subject).toMatch(/confirm/i);
    expect(email.subject).toContain('Domain A Weekly');
  });

  it('includes exactly one call to action', () => {
    // §5.4: one clear call to action. A second link competes with it and
    // measurably lowers confirmation rates.
    const links = email.html.match(/<a\s[^>]*href=/gi) ?? [];
    expect(links).toHaveLength(1);
    expect(email.html).toContain(confirmationUrl('tok-123'));
  });

  it('has a plain-text alternative containing the same link', () => {
    expect(email.text).toContain(confirmationUrl('tok-123'));
    expect(email.text.length).toBeGreaterThan(0);
  });

  it('contains no images and no tracking', () => {
    // §5.4: no marketing content, no images, no tracking. Its deliverability
    // requirements differ from a newsletter's and its job is singular.
    expect(email.html).not.toMatch(/<img/i);
    expect(email.html).not.toContain('/api/t/o/');
    expect(email.html).not.toContain('/api/t/c/');
  });

  it('carries no unsubscribe link, because it is not a bulk message', () => {
    expect(email.html).not.toMatch(/unsubscribe/i);
  });

  it('tells the reader what to do if they did not sign up', () => {
    expect(email.text).toMatch(/did ?n[o']t|ignore/i);
  });

  it('escapes the list name so it cannot inject markup', async () => {
    const evil = await buildConfirmationEmail({
      list: { ...list, name: '<script>alert(1)</script>' },
      token: 'tok',
    });
    expect(evil.html).not.toContain('<script>alert(1)</script>');
    expect(evil.html).toContain('&lt;script&gt;');
  });

  it('escapes the token inside the href attribute', async () => {
    const built = await buildConfirmationEmail({ list, token: 'a"b' });
    expect(built.html).not.toContain('href="https://mail.example.com/api/confirm?token=a"b"');
    expect(built.html).toContain('a%22b');
  });
});

describe('buildConfirmationEmail — through a confirmation template', () => {
  const TEMPLATE = [
    '<!doctype html><html><body>',
    '<p>Assalamu alaikum {{ first_name | default: "friend" }},</p>',
    '<p>Confirm your subscription to {{list_name}}.</p>',
    '<a href="{{confirm_url}}">CONFIRM SUBSCRIPTION</a>',
    '<p>{{physical_address}}</p>',
    '</body></html>',
  ].join('');

  async function build(overrides: Record<string, unknown> = {}) {
    return buildConfirmationEmail({
      list,
      token: 'tok-123',
      templateHtml: TEMPLATE,
      ...overrides,
    });
  }

  it('renders the operator’s markup instead of the built-in email', async () => {
    const email = await build();

    expect(email.html).toContain('Assalamu alaikum');
    expect(email.html).toContain('Domain A Weekly');
    expect(email.html).not.toContain('Please confirm you want to receive');
  });

  it('resolves the confirmation link, because there is no SES template here', async () => {
    // A campaign leaves `{{…}}` for SES to substitute per destination. This is
    // one sendSimple per subscriber, so a surviving placeholder is a dead link.
    const email = await build();

    expect(email.html).toContain(confirmationUrl('tok-123'));
    expect(email.html).not.toContain('{{');
  });

  it('resolves subscriber attributes, and falls back when there are none', async () => {
    expect((await build({ attributes: { first_name: 'Ada' } })).html).toContain(
      'Assalamu alaikum Ada,',
    );
    expect((await build()).html).toContain('Assalamu alaikum friend,');
  });

  it('derives the plain-text part from what was actually rendered', async () => {
    // Written separately, the text part would keep saying whatever the built-in
    // copy said after the operator rewrote the HTML.
    const email = await build();

    expect(email.text).toContain('Assalamu alaikum friend');
    expect(email.text).toContain(`CONFIRM SUBSCRIPTION (${confirmationUrl('tok-123')})`);
  });

  it('keeps the subject app-owned', async () => {
    expect((await build()).subject).toBe('Confirm your subscription to Domain A Weekly');
  });

  it('appends the postal address a template left out', async () => {
    const email = await build({
      templateHtml: '<html><body><a href="{{confirm_url}}">Confirm</a></body></html>',
    });

    expect(email.html).toContain('1 Example Street');
  });

  it('appends the confirmation link a template left out, rather than sending a dead email', async () => {
    const email = await build({ templateHtml: '<html><body><p>Hello.</p></body></html>' });

    expect(email.html).toContain(confirmationUrl('tok-123'));
  });

  it('strips active content from the template', async () => {
    const email = await build({
      templateHtml: `<html><body><script>alert(1)</script><a href="{{confirm_url}}">Go</a></body></html>`,
    });

    expect(email.html).not.toContain('alert(1)');
    expect(email.html).toContain(confirmationUrl('tok-123'));
  });

  it('carries no unsubscribe link, because there is nothing to unsubscribe from yet', async () => {
    expect((await build()).html).not.toMatch(/unsubscribe/i);
  });
});
