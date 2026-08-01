import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setupEnv } from './helpers/setup';
import { isSyntacticallyValid, normalizeEmail, emailDomain } from '../src/lib/email-address';
import { csvEscape, csvRow } from '../src/lib/export';
import { redactEmail, log } from '../src/lib/logger';
import { verifyCronRequest } from '../src/lib/api';
import {
  isSafeRedirectTarget,
  signClickToken,
  signOpenToken,
  verifyClickToken,
  verifyOpenToken,
} from '../src/lib/tracking';
import { createSessionToken, verifySessionToken } from '../src/lib/session';
import { hashPassword, verifyPassword, safeEqual } from '../src/lib/crypto';

setupEnv();

/** §12 controls, plus the input handling they depend on. */

describe('address validation (§5.1)', () => {
  it('normalizes without folding distinct addresses together', () => {
    assert.equal(normalizeEmail('  Ada@Example.COM '), 'ada@example.com');
    // Plus-tagged addresses are two consenting people, not one.
    assert.notEqual(normalizeEmail('a+one@example.com'), normalizeEmail('a+two@example.com'));
    assert.equal(emailDomain('ada@example.com'), 'example.com');
  });

  it('accepts ordinary addresses', () => {
    for (const email of [
      'ada@example.com',
      'ada.lovelace@sub.example.co.uk',
      'a+tag@example.com',
      "o'brien@example.com".replace("'", ''),
      'a_b-c@example-domain.com',
    ]) {
      assert.equal(isSyntacticallyValid(email), true, `should accept ${email}`);
    }
  });

  it('rejects malformed addresses and header-injection attempts', () => {
    for (const email of [
      '',
      'not-an-email',
      'a@',
      '@example.com',
      'a@@example.com',
      'a..b@example.com',
      'a@example',
      'a@exam ple.com',
      'a@example.com\nBcc: victim@example.com',
      'a@example.com\r\nSubject: spam',
      `${'a'.repeat(65)}@example.com`,
    ]) {
      assert.equal(isSyntacticallyValid(email), false, `should reject ${JSON.stringify(email)}`);
    }
  });
});

describe('cron authentication (§12)', () => {
  const request = (header?: string) =>
    new Request('https://mail.test/api/cron/send', header ? { headers: { authorization: header } } : undefined);

  it('accepts the configured secret', () => {
    assert.equal(verifyCronRequest(request('Bearer test-cron-secret')), true);
  });

  it('rejects everything else', () => {
    assert.equal(verifyCronRequest(request()), false);
    assert.equal(verifyCronRequest(request('Bearer wrong')), false);
    assert.equal(verifyCronRequest(request('test-cron-secret')), false);
    assert.equal(verifyCronRequest(request('Bearer test-cron-secre')), false);
    assert.equal(verifyCronRequest(request('Bearer test-cron-secretX')), false);
  });
});

describe('tracking tokens (§12, §13)', () => {
  const campaignId = '507f1f77bcf86cd799439011';
  const subscriberId = '507f191e810c19729de860ea';

  it('round-trips an open token', () => {
    const token = signOpenToken(campaignId, subscriberId);
    const payload = verifyOpenToken(token);
    assert.equal(payload?.campaignId, campaignId);
    assert.equal(payload?.subscriberId, subscriberId);
  });

  it('round-trips a click token, including the destination', () => {
    const url = 'https://example.com/article?utm=1';
    const token = signClickToken(campaignId, subscriberId, url);
    const payload = verifyClickToken(token);
    assert.equal(payload?.url, url);
    assert.equal(payload?.campaignId, campaignId);
  });

  it('refuses to emit a redirect target that was not signed', () => {
    const token = signClickToken(campaignId, subscriberId, 'https://example.com/ok');
    // Tampering with the payload invalidates the signature, so the attacker
    // cannot swap the destination.
    const [encoded, signature] = token.split('.');
    const swapped = Buffer.from(`c:${campaignId}:${subscriberId}\nhttps://evil.example.com`, 'utf8').toString(
      'base64url',
    );
    assert.equal(verifyClickToken(`${swapped}.${signature}`), null);
    assert.ok(encoded);
  });

  it('rejects a signed token whose target is not http(s)', () => {
    const token = signClickToken(campaignId, subscriberId, 'javascript:alert(1)');
    assert.equal(verifyClickToken(token), null, 'a signed javascript: target must still be refused');
  });

  it('validates redirect targets independently of the signature', () => {
    assert.equal(isSafeRedirectTarget('https://example.com'), true);
    assert.equal(isSafeRedirectTarget('http://example.com'), true);
    assert.equal(isSafeRedirectTarget('javascript:alert(1)'), false);
    assert.equal(isSafeRedirectTarget('data:text/html,<script>'), false);
    assert.equal(isSafeRedirectTarget('//evil.example.com'), false);
    assert.equal(isSafeRedirectTarget(''), false);
  });

  it('rejects a token signed for a different purpose', () => {
    const openToken = signOpenToken(campaignId, subscriberId);
    assert.equal(verifyClickToken(openToken), null);
  });
});

describe('admin sessions', () => {
  it('round-trips and rejects tampering', async () => {
    const token = await createSessionToken('admin@test.com', 'secret');
    assert.equal((await verifySessionToken(token, 'secret'))?.email, 'admin@test.com');
    assert.equal(await verifySessionToken(token, 'other-secret'), null);
    assert.equal(await verifySessionToken(`${token}x`, 'secret'), null);
    assert.equal(await verifySessionToken(undefined, 'secret'), null);
  });

  it('rejects an expired session', async () => {
    const token = await createSessionToken('admin@test.com', 'secret', Date.now() - 24 * 60 * 60 * 1000);
    assert.equal(await verifySessionToken(token, 'secret'), null);
  });
});

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('correct horse battery staple', hash), true);
    assert.equal(await verifyPassword('wrong', hash), false);
  });

  it('salts, so two hashes of one password differ', async () => {
    assert.notEqual(await hashPassword('same'), await hashPassword('same'));
  });

  it('rejects a malformed stored hash instead of throwing', async () => {
    assert.equal(await verifyPassword('x', 'garbage'), false);
    assert.equal(await verifyPassword('x', ''), false);
  });

  it('compares in constant time without throwing on length mismatch', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
  });
});

describe('PII in logs (§12)', () => {
  it('redacts an address to a domain and a digest', () => {
    const redacted = redactEmail('ada@example.com');
    assert.ok(!redacted.includes('ada@'), 'the local part leaked');
    assert.ok(redacted.includes('example.com'), 'the domain is useful and not PII on its own');
    assert.equal(redactEmail('ada@example.com'), redacted, 'redaction must be stable for correlation');
  });

  it('redacts addresses embedded in log fields', () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      log.info('subscriber updated', { note: 'contacted ada@example.com about it', count: 1 });
    } finally {
      console.log = original;
    }

    assert.equal(lines.length, 1);
    assert.ok(!lines[0]!.includes('ada@example.com'), 'an address reached the logs');
    assert.ok(lines[0]!.includes('example.com'));
    assert.ok(lines[0]!.includes('"count":1'));
  });
});

describe('CSV export (§4.4)', () => {
  it('quotes and escapes correctly', () => {
    assert.equal(csvEscape('plain'), 'plain');
    assert.equal(csvEscape('has,comma'), '"has,comma"');
    assert.equal(csvEscape('has"quote'), '"has""quote"');
    assert.equal(csvEscape('has\nnewline'), '"has\nnewline"');
    assert.equal(csvEscape(null), '');
    assert.equal(csvEscape(undefined), '');
  });

  it('neutralises spreadsheet formula injection', () => {
    // A subscriber attribute is attacker-controlled; opening the export in
    // Excel must not execute it.
    assert.equal(csvEscape('=1+1'), "'=1+1");
    assert.equal(csvEscape('+44 7700 900000'), "'+44 7700 900000");
    assert.equal(csvEscape('@SUM(A1)'), "'@SUM(A1)");
    assert.equal(csvEscape('-2+3'), "'-2+3");
  });

  it('writes one row per line', () => {
    assert.equal(csvRow(['a', 'b']), 'a,b\n');
  });
});
