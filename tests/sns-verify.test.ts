import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createSign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  buildStringToSign,
  isValidSigningCertUrl,
  verifySnsMessage,
  type SnsMessage,
} from '../src/lib/sns-verify';

/**
 * SNS signature verification (§8.1).
 *
 * The threat this defends against is specific: an attacker who can post
 * accepted messages to the webhook can suppress the entire subscriber list.
 * These tests use a real RSA key pair and a real X.509 certificate, because a
 * mocked verifier would prove nothing about the thing that matters.
 */

let dir: string;
let certPem: string;
let privateKeyPem: string;
let otherKeyPem: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'sns-test-'));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', join(dir, 'key.pem'),
    '-out', join(dir, 'cert.pem'),
    '-days', '1', '-nodes', '-subj', '/CN=sns.eu-west-1.amazonaws.com',
  ], { stdio: 'ignore' });

  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', join(dir, 'other-key.pem'),
    '-out', join(dir, 'other-cert.pem'),
    '-days', '1', '-nodes', '-subj', '/CN=attacker.example.com',
  ], { stdio: 'ignore' });

  certPem = readFileSync(join(dir, 'cert.pem'), 'utf8');
  privateKeyPem = readFileSync(join(dir, 'key.pem'), 'utf8');
  otherKeyPem = readFileSync(join(dir, 'other-key.pem'), 'utf8');
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CERT_URL = 'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc123.pem';

function buildMessage(overrides: Partial<SnsMessage> = {}, signWith = () => privateKeyPem): SnsMessage {
  const base: SnsMessage = {
    Type: 'Notification',
    MessageId: 'test-message-id',
    TopicArn: 'arn:aws:sns:eu-west-1:123456789012:ses-events',
    Message: JSON.stringify({ eventType: 'Bounce' }),
    Timestamp: new Date().toISOString(),
    SignatureVersion: '1',
    Signature: '',
    SigningCertURL: CERT_URL,
    ...overrides,
  };

  const stringToSign = buildStringToSign(base);
  const signer = createSign(base.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1');
  signer.update(stringToSign ?? '', 'utf8');
  signer.end();
  base.Signature = signer.sign(signWith(), 'base64');
  return base;
}

describe('certificate URL validation', () => {
  it('accepts a genuine SNS certificate URL', () => {
    assert.equal(isValidSigningCertUrl(CERT_URL), true);
    assert.equal(
      isValidSigningCertUrl('https://sns.us-east-1.amazonaws.com/SimpleNotificationService-x.pem'),
      true,
    );
  });

  it('rejects the URLs an attacker would supply', () => {
    const hostile = [
      'https://evil.com/cert.pem',
      // The check must be anchored: a suffix match would accept this.
      'https://sns.eu-west-1.amazonaws.com.evil.com/cert.pem',
      'http://sns.eu-west-1.amazonaws.com/cert.pem',
      'https://s3.amazonaws.com/mybucket/cert.pem',
      'https://sns.eu-west-1.amazonaws.com/cert.txt',
      'not a url',
      '',
    ];
    for (const url of hostile) {
      assert.equal(isValidSigningCertUrl(url), false, `should have rejected: ${url}`);
    }
  });
});

describe('string to sign', () => {
  it('includes the documented fields in order for a Notification', () => {
    const message = {
      Type: 'Notification',
      MessageId: 'id',
      TopicArn: 'arn',
      Message: 'body',
      Timestamp: 'ts',
      SignatureVersion: '1',
      Signature: '',
    } as SnsMessage;

    assert.equal(buildStringToSign(message), 'Message\nbody\nMessageId\nid\nTimestamp\nts\nTopicArn\narn\nType\nNotification\n');
  });

  it('omits an absent Subject entirely rather than blanking it', () => {
    const withSubject = buildStringToSign({
      Type: 'Notification',
      MessageId: 'id',
      TopicArn: 'arn',
      Subject: 'hello',
      Message: 'body',
      Timestamp: 'ts',
      SignatureVersion: '1',
      Signature: '',
    } as SnsMessage);

    assert.ok(withSubject?.includes('Subject\nhello\n'));
  });

  it('refuses to build one for an unknown message type', () => {
    assert.equal(buildStringToSign({ Type: 'Nonsense' } as SnsMessage), null);
  });
});

describe('signature verification', () => {
  const fetchCert = async () => certPem;

  it('accepts a correctly signed SignatureVersion 1 message', async () => {
    const result = await verifySnsMessage(buildMessage(), { fetchCert });
    assert.equal(result.ok, true);
  });

  it('accepts a correctly signed SignatureVersion 2 message', async () => {
    const result = await verifySnsMessage(buildMessage({ SignatureVersion: '2' }), { fetchCert });
    assert.equal(result.ok, true);
  });

  it('rejects a message signed with a different key', async () => {
    const forged = buildMessage({}, () => otherKeyPem);
    const result = await verifySnsMessage(forged, { fetchCert });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : '', /Signature does not match/);
  });

  it('rejects a message whose body was altered after signing', async () => {
    const message = buildMessage();
    message.Message = JSON.stringify({ eventType: 'Bounce', injected: true });

    const result = await verifySnsMessage(message, { fetchCert });
    assert.equal(result.ok, false);
  });

  it('rejects a message pointing at a non-AWS certificate', async () => {
    const message = buildMessage({ SigningCertURL: 'https://evil.example.com/cert.pem' });
    const result = await verifySnsMessage(message, { fetchCert });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : '', /not an AWS SNS endpoint/);
  });

  it('rejects a replayed message outside the timestamp window', async () => {
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const result = await verifySnsMessage(buildMessage({ Timestamp: old }), { fetchCert });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : '', /timestamp/i);
  });

  it('rejects an unsupported signature version', async () => {
    const message = buildMessage();
    message.SignatureVersion = '3';
    const result = await verifySnsMessage(message, { fetchCert });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : '', /SignatureVersion/);
  });

  it('rejects a message with no signature at all', async () => {
    const message = buildMessage();
    message.Signature = '';
    const result = await verifySnsMessage(message, { fetchCert });
    assert.equal(result.ok, false);
  });
});
