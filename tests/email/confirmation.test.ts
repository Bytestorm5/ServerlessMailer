import { describe, expect, it } from 'vitest';
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

describe('buildConfirmationEmail', () => {
  const email = buildConfirmationEmail(list, 'tok-123');

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

  it('escapes the list name so it cannot inject markup', () => {
    const evil = buildConfirmationEmail(
      { ...list, name: '<script>alert(1)</script>' },
      'tok',
    );
    expect(evil.html).not.toContain('<script>alert(1)</script>');
    expect(evil.html).toContain('&lt;script&gt;');
  });

  it('escapes the token inside the href attribute', () => {
    const built = buildConfirmationEmail(list, 'a"b');
    expect(built.html).not.toContain('href="https://mail.example.com/api/confirm?token=a"b"');
    expect(built.html).toContain('a%22b');
  });
});
