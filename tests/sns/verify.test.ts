import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  buildStringToSign,
  isValidSigningCertUrl,
  setCertFetcher,
  verifySnsMessage,
  type CertFetcher,
  type SnsMessage,
} from '@/lib/sns/verify';

/**
 * Spec §8.1 / contract §22.
 *
 * Nothing here is mocked at the crypto layer: every signature is a real RSA
 * signature produced by a real key, and every rejection is a real verification
 * failure. Mocking `node:crypto` would make these tests prove nothing, and an
 * attacker who can forge one of these messages can suppress the entire list.
 */

// ---------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------

const legit = generateKeyPairSync('rsa', { modulusLength: 2048 });
const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });

const legitPublicPem = legit.publicKey.export({ type: 'spki', format: 'pem' }) as string;
const attackerPublicPem = attacker.publicKey.export({
  type: 'spki',
  format: 'pem',
}) as string;

/**
 * A real self-signed X.509 certificate (and its key), because that is what SNS
 * actually serves from `SigningCertURL` — a certificate, not a bare public key.
 */
const CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDLzCCAhegAwIBAgIUSWwScpzGypWmuTBHgE9zfhzO7QIwDQYJKoZIhvcNAQEL
BQAwJjEkMCIGA1UEAwwbc25zLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tMCAXDTI2
MDgwMTAyMDAxNFoYDzIxMjYwNzA4MDIwMDE0WjAmMSQwIgYDVQQDDBtzbnMudXMt
ZWFzdC0xLmFtYXpvbmF3cy5jb20wggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK
AoIBAQDXZaHOZS0CKkS4KGHYkEdYVpKZSlnwjM7ZK6tDUsNO1+V68nzt7QPhYYVq
qAz3Z4l2LtKMmNX4kfCzCrWI4x7Mi75K2fWOj5TK80q9zHdbBe78vU4DHMceAWGs
MD70+SXI7SB3o3Bjbx+yNfj9WDFepHhlBU0V0ocMXozzevqE+UmMh49Fpk1aBDUS
G1g3dDgwi2AX+tpce0ULw4uqHvrT95tGtkFAUItUMOACk3zhnrqWRt3fbBytoQbn
QNfVm1gulErttMkharHLhnn4toTIkdnBYFt8L4PAoEJ9t1IDOUkL1XXk25LW+Vj7
NIeazAs1pxs9Nnk4lEW0S8fM6ZtjAgMBAAGjUzBRMB0GA1UdDgQWBBRGQ5mxL2ms
4LroyOI1Cg2+r39DLTAfBgNVHSMEGDAWgBRGQ5mxL2ms4LroyOI1Cg2+r39DLTAP
BgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQA7dtY9Ai7qN619anvE
Yzga1m9Kgiu7gA2c208h8autIFz+30mRbCEa+8wTrcTBFEEcIvn4BQ5wgR0VIdDl
esw8Hrski2rHUkQ31lgFdanugEbCJMrl6L3Qp+JslaJXGabV0PcKB6xJTjieOXdI
tbjBG3z3On04iW/skGBRHR5hte6FuZB6u+yG02bxf+7zMsVjLSGfOXvQwq01jGZZ
tohJfFIxHfnjeeX6o63AZBizzGr5e8drRCZ0X9ISEwKeQ5LZrAgBW6tfydBF03f+
8qTi3ecghvyiNcgs3ShwL0kOZRYAsA3lEMgW4e/AZLxCqYMnlCqKPDxw7ZJROaHo
G9CA
-----END CERTIFICATE-----
`;

const CERT_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDXZaHOZS0CKkS4
KGHYkEdYVpKZSlnwjM7ZK6tDUsNO1+V68nzt7QPhYYVqqAz3Z4l2LtKMmNX4kfCz
CrWI4x7Mi75K2fWOj5TK80q9zHdbBe78vU4DHMceAWGsMD70+SXI7SB3o3Bjbx+y
Nfj9WDFepHhlBU0V0ocMXozzevqE+UmMh49Fpk1aBDUSG1g3dDgwi2AX+tpce0UL
w4uqHvrT95tGtkFAUItUMOACk3zhnrqWRt3fbBytoQbnQNfVm1gulErttMkharHL
hnn4toTIkdnBYFt8L4PAoEJ9t1IDOUkL1XXk25LW+Vj7NIeazAs1pxs9Nnk4lEW0
S8fM6ZtjAgMBAAECggEAQYEoaIavXeGx3Vl2jDAwakaFtbV9TaDcxQG5RzOTrtYM
dUvqP0cdr3yDYPCzZMfpb3YE1Poj1EC5tRFULMl5U9ZJrCTFvzGeG+xKNhdI0vcm
e1kssNifG1prNDzF4KUmXwjyH0AmjS69smokixM3jGMzM/GdRD4ukM3uSpuDNU21
SFG39PRee24yBT3m6bsVIAojcfV1yjBE2E+89z6VWqVMBP4xwU1/qe4uacO8zk1S
wjQdme1nZIFH/7qez1rv5QD04tqinMuhPe8eLObkMCkudAP6UZsOhRSdVWqDbM4H
ALAinss2ujjGmoNyNpsYYNp/3Tm1g2T2p8fawvruEQKBgQD+46ygeOe5ziel4/vP
F6t838XPfLb4WNotZCyW9wufZp/h9P3cD4WH77C6UQbYEC8o5fWDqGv/1FOf/gx/
XUBkkA8B+qqnRiCS4GTuE958i/KSMeFI5WDTIwDTNl0V8kAaSapoc0NzH76ZE7i8
6Wb2F5Yf/jfGJPpxPlQMfmP2UQKBgQDYVeeP3ORzFywUwJkVGnDYGUk0C/wG22sb
IMpjfbswtzxlEu7XKuGYNHufG7Bop0Cbu59nw/ApdqP2QceQWd2IjbPXfRzajpJk
AKXJeIl8b2RsiAJDb6iVrcKmO+3cLVDPrFzVmJ5NSGzaNNIKY4ogajrsO/Zv9kbi
ku0Bf5RlcwKBgQC16V3JxaB0Tnqjfbu4iIcef0JZHAQl6JwF60mbkMNdx0tyY3xO
c1F0vA9gWfXNfHd78+suRKSXmDz6ocDfoXkUjG/5lKH48ibLTJUcCVgvgV3lEu5b
LUHWTlQHafQzdopjeJHDLAhGgLBx5c5iHR4boqfFO5UouDl5Wud3ZzkGkQKBgAuM
0pcouP24D/9vpPyuc7Xl67Weqi8Hiflhz8xuCw93yP6wexX70R2aN7tv9AQyYc2u
v7z/hhQApJJiQrBfS+edgSuRH3g/wmsaab+O8vA01kzBGjXVgU+0fj731iQ6OyVL
U42H33PK2RzxUwGA/P/sDAdO0EJ8CJ7SL1s0H40nAoGAKA4cWXfOm2N5Y9+eUN+Y
Db1r9lrc41KdYMzf+dXat8aiVCsSuIrNSYQlI1SRejL+GJkOJwGie/+ft8JiB3ck
baX+srU86RyXD1HuGkQ6dd4qaLzXrlniKzVhVNgMzlxjhjrurX+PtSQZXi+QN/Vg
gvq0DDM9CCYRPMNDdiY6h7A=
-----END PRIVATE KEY-----
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CERT_URL = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem';
const TOPIC = 'arn:aws:sns:us-east-1:123456789012:ses-events';

function signWith(
  stringToSign: string,
  version: '1' | '2',
  key: KeyObject | string = legit.privateKey,
): string {
  const algorithm = version === '1' ? 'RSA-SHA1' : 'RSA-SHA256';
  return createSign(algorithm).update(stringToSign, 'utf8').sign(key, 'base64');
}

/** Builds a message and signs it for real over its own canonical string. */
function signedMessage(
  version: '1' | '2',
  overrides: Partial<SnsMessage> = {},
  key: KeyObject | string = legit.privateKey,
): SnsMessage {
  const unsigned: SnsMessage = {
    Type: 'Notification',
    MessageId: '9f1a5e6c-0000-4a0c-9d6e-000000000001',
    TopicArn: TOPIC,
    Message: JSON.stringify({ eventType: 'Complaint' }),
    Timestamp: '2026-08-01T09:30:00.000Z',
    SignatureVersion: version,
    Signature: '',
    SigningCertURL: CERT_URL,
    ...overrides,
  };
  return { ...unsigned, Signature: signWith(buildStringToSign(unsigned), version, key) };
}

function trackedFetcher(impl: (url: string) => string | Promise<string>): {
  fetcher: CertFetcher;
  calls: string[];
} {
  const calls: string[] = [];
  const fetcher: CertFetcher = async (url) => {
    calls.push(url);
    return impl(url);
  };
  return { fetcher, calls };
}

/** The common case: the seam hands back the public key that actually signed. */
function useLegitCert(): string[] {
  const { fetcher, calls } = trackedFetcher(() => legitPublicPem);
  setCertFetcher(fetcher);
  return calls;
}

afterEach(() => {
  setCertFetcher(undefined);
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// isValidSigningCertUrl
// ---------------------------------------------------------------------------

describe('isValidSigningCertUrl — accepts genuine AWS URLs', () => {
  const good = [
    ['a regional SNS host', CERT_URL],
    ['another region', 'https://sns.eu-west-2.amazonaws.com/SimpleNotificationService-1.pem'],
    ['the apex host itself', 'https://amazonaws.com/x.pem'],
    ['a deep subdomain', 'https://a.b.c.sns.us-east-1.amazonaws.com/x.pem'],
    ['an uppercase host', 'https://SNS.US-EAST-1.AMAZONAWS.COM/x.pem'],
    ['a china-partition style host', 'https://sns.cn-north-1.amazonaws.com/x.pem'],
    ['a query string on a genuine host', `${CERT_URL}?v=1`],
  ] as const;

  for (const [why, url] of good) {
    it(`accepts ${why}`, () => {
      expect(isValidSigningCertUrl(url)).toBe(true);
    });
  }
});

describe('isValidSigningCertUrl — rejects forged URLs', () => {
  // The five named attacks from the contract, each with its own test.
  it('rejects http:// — the certificate must not be fetched over plaintext', () => {
    expect(isValidSigningCertUrl('http://sns.us-east-1.amazonaws.com/x.pem')).toBe(false);
  });

  it('rejects the suffix trick https://evil-amazonaws.com/x.pem', () => {
    expect(isValidSigningCertUrl('https://evil-amazonaws.com/x.pem')).toBe(false);
  });

  it('rejects the domain-prefix trick https://amazonaws.com.attacker.io/x.pem', () => {
    expect(isValidSigningCertUrl('https://amazonaws.com.attacker.io/x.pem')).toBe(false);
  });

  it('rejects the query-string trick https://attacker.io/?x=amazonaws.com', () => {
    expect(isValidSigningCertUrl('https://attacker.io/?x=amazonaws.com')).toBe(false);
  });

  it('rejects the userinfo trick https://sns.amazonaws.com@attacker.io/x.pem', () => {
    expect(isValidSigningCertUrl('https://sns.amazonaws.com@attacker.io/x.pem')).toBe(false);
  });

  const bad = [
    ['a bare hostname suffix without a dot boundary', 'https://notamazonaws.com/x.pem'],
    ['a fragment carrying the real host', 'https://attacker.io/x.pem#amazonaws.com'],
    ['a path carrying the real host', 'https://attacker.io/amazonaws.com/x.pem'],
    ['credentials in front of a genuine host', 'https://user:pass@sns.amazonaws.com/x.pem'],
    ['a username-only userinfo', 'https://amazonaws.com@attacker.io/x.pem'],
    ['a trailing-dot FQDN', 'https://sns.amazonaws.com./x.pem'],
    ['a protocol-relative URL', '//sns.us-east-1.amazonaws.com/x.pem'],
    ['a scheme-relative path', '/SimpleNotificationService.pem'],
    ['ftp', 'ftp://sns.us-east-1.amazonaws.com/x.pem'],
    ['file', 'file:///etc/passwd'],
    ['data', 'data:text/plain;base64,aGk='],
    ['javascript', 'javascript:alert(1)'],
    ['an unparseable string', 'not a url at all'],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a raw IP host', 'https://203.0.113.10/x.pem'],
    ['an IPv6 host', 'https://[::1]/x.pem'],
    ['localhost', 'https://localhost/x.pem'],
    ['an internal metadata address', 'https://169.254.169.254/latest/meta-data/'],
    ['a lookalike TLD', 'https://sns.us-east-1.amazonaws.com.co/x.pem'],
    ['a hyphenated lookalike', 'https://sns-us-east-1-amazonaws-com.attacker.io/x.pem'],
  ] as const;

  for (const [why, url] of bad) {
    it(`rejects ${why}`, () => {
      expect(isValidSigningCertUrl(url)).toBe(false);
    });
  }

  it('rejects non-string input from untyped callers', () => {
    for (const value of [undefined, null, 0, {}, [], true]) {
      expect(isValidSigningCertUrl(value as unknown as string)).toBe(false);
    }
  });

  it('rejects an absurdly long URL rather than parsing it', () => {
    expect(
      isValidSigningCertUrl(`https://sns.amazonaws.com/${'a'.repeat(100_000)}.pem`),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildStringToSign
// ---------------------------------------------------------------------------

describe('buildStringToSign', () => {
  const notification: SnsMessage = {
    Type: 'Notification',
    MessageId: 'mid-1',
    TopicArn: TOPIC,
    Message: 'hello',
    Timestamp: '2026-08-01T09:30:00.000Z',
    SignatureVersion: '1',
    Signature: 'ignored',
    SigningCertURL: CERT_URL,
  };

  it('renders a Notification with the AWS key order and no Subject', () => {
    expect(buildStringToSign(notification)).toBe(
      'Message\nhello\n' +
        'MessageId\nmid-1\n' +
        'Timestamp\n2026-08-01T09:30:00.000Z\n' +
        `TopicArn\n${TOPIC}\n` +
        'Type\nNotification\n',
    );
  });

  it('inserts Subject between MessageId and Timestamp when present', () => {
    expect(buildStringToSign({ ...notification, Subject: 'Daily' })).toBe(
      'Message\nhello\n' +
        'MessageId\nmid-1\n' +
        'Subject\nDaily\n' +
        'Timestamp\n2026-08-01T09:30:00.000Z\n' +
        `TopicArn\n${TOPIC}\n` +
        'Type\nNotification\n',
    );
  });

  it('includes an empty Subject, because present-but-empty is still present', () => {
    expect(buildStringToSign({ ...notification, Subject: '' })).toContain('Subject\n\n');
  });

  it('omits Subject when it is explicitly undefined or null', () => {
    expect(buildStringToSign({ ...notification, Subject: undefined })).not.toContain('Subject');
    expect(
      buildStringToSign({ ...notification, Subject: null as unknown as string }),
    ).not.toContain('Subject');
  });

  it('ignores SubscribeURL and Token on a Notification', () => {
    const built = buildStringToSign({
      ...notification,
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/confirm',
      Token: 'tok',
    });
    expect(built).not.toContain('SubscribeURL');
    expect(built).not.toContain('Token');
  });

  it('renders a SubscriptionConfirmation with SubscribeURL and Token', () => {
    const confirmation: SnsMessage = {
      ...notification,
      Type: 'SubscriptionConfirmation',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription',
      Token: 'tok-1',
    };
    expect(buildStringToSign(confirmation)).toBe(
      'Message\nhello\n' +
        'MessageId\nmid-1\n' +
        'SubscribeURL\nhttps://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription\n' +
        'Timestamp\n2026-08-01T09:30:00.000Z\n' +
        'Token\ntok-1\n' +
        `TopicArn\n${TOPIC}\n` +
        'Type\nSubscriptionConfirmation\n',
    );
  });

  it('renders an UnsubscribeConfirmation with the same key set', () => {
    const built = buildStringToSign({
      ...notification,
      Type: 'UnsubscribeConfirmation',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription',
      Token: 'tok-1',
    });
    expect(built).toContain('SubscribeURL\n');
    expect(built).toContain('Token\ntok-1\n');
    expect(built.endsWith('Type\nUnsubscribeConfirmation\n')).toBe(true);
  });

  it('never signs Subject on a subscription-family message', () => {
    const built = buildStringToSign({
      ...notification,
      Type: 'SubscriptionConfirmation',
      Subject: 'should not be signed',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/x',
      Token: 'tok-1',
    });
    expect(built).not.toContain('Subject');
  });

  it('omits absent subscription fields rather than emitting undefined', () => {
    const built = buildStringToSign({ ...notification, Type: 'SubscriptionConfirmation' });
    expect(built).not.toContain('undefined');
    expect(built).not.toContain('SubscribeURL');
    expect(built).not.toContain('Token');
  });

  it('returns an empty string for an unknown Type — nothing to sign, nothing to trust', () => {
    expect(buildStringToSign({ ...notification, Type: 'Lambda' })).toBe('');
    expect(buildStringToSign({ ...notification, Type: '' })).toBe('');
    expect(buildStringToSign({ ...notification, Type: 'notification' })).toBe('');
  });

  it('passes values through verbatim, including embedded newlines', () => {
    const built = buildStringToSign({ ...notification, Message: 'line1\nline2' });
    expect(built.startsWith('Message\nline1\nline2\nMessageId\n')).toBe(true);
  });

  it('always ends with a newline and never starts with a stray separator', () => {
    const built = buildStringToSign(notification);
    expect(built.endsWith('\n')).toBe(true);
    expect(built.startsWith('Message\n')).toBe(true);
  });

  it('never throws on malformed input', () => {
    expect(buildStringToSign(null as unknown as SnsMessage)).toBe('');
    expect(buildStringToSign(undefined as unknown as SnsMessage)).toBe('');
    expect(buildStringToSign('nope' as unknown as SnsMessage)).toBe('');
    expect(buildStringToSign({} as SnsMessage)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// verifySnsMessage — the genuine article
// ---------------------------------------------------------------------------

describe('verifySnsMessage — genuine messages', () => {
  it('accepts a SignatureVersion 1 (RSA-SHA1) notification', async () => {
    useLegitCert();
    await expect(verifySnsMessage(signedMessage('1'))).resolves.toBe(true);
  });

  it('accepts a SignatureVersion 2 (RSA-SHA256) notification', async () => {
    useLegitCert();
    await expect(verifySnsMessage(signedMessage('2'))).resolves.toBe(true);
  });

  it('accepts a notification carrying a Subject', async () => {
    useLegitCert();
    await expect(verifySnsMessage(signedMessage('2', { Subject: 'Bounce' }))).resolves.toBe(
      true,
    );
  });

  it('accepts a SubscriptionConfirmation', async () => {
    useLegitCert();
    const message = signedMessage('1', {
      Type: 'SubscriptionConfirmation',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t',
      Token: 't',
    });
    await expect(verifySnsMessage(message)).resolves.toBe(true);
  });

  it('accepts an UnsubscribeConfirmation', async () => {
    useLegitCert();
    const message = signedMessage('2', {
      Type: 'UnsubscribeConfirmation',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t',
      Token: 't',
    });
    await expect(verifySnsMessage(message)).resolves.toBe(true);
  });

  it('accepts a real X.509 certificate, not just a bare public key', async () => {
    const { fetcher } = trackedFetcher(() => CERT_PEM);
    setCertFetcher(fetcher);
    await expect(verifySnsMessage(signedMessage('2', {}, CERT_KEY_PEM))).resolves.toBe(true);
  });

  it('tolerates a certificate served with CRLF line endings and trailing whitespace', async () => {
    const { fetcher } = trackedFetcher(() => `${CERT_PEM.replace(/\n/g, '\r\n')}\r\n  `);
    setCertFetcher(fetcher);
    await expect(verifySnsMessage(signedMessage('1', {}, CERT_KEY_PEM))).resolves.toBe(true);
  });

  it('fetches exactly the URL named in the message', async () => {
    const calls = useLegitCert();
    await verifySnsMessage(signedMessage('2'));
    expect(calls).toEqual([CERT_URL]);
  });
});

// ---------------------------------------------------------------------------
// verifySnsMessage — tampering
// ---------------------------------------------------------------------------

describe('verifySnsMessage — a single mutated character fails', () => {
  /** Flips one character so the value is a genuine near-miss, not garbage. */
  function tweak(value: string): string {
    const swapped = value[0] === 'X' ? 'Y' : 'X';
    return swapped + value.slice(1);
  }

  const fields: (keyof SnsMessage)[] = ['Message', 'Signature', 'Timestamp', 'TopicArn'];

  for (const field of fields) {
    it(`rejects a message whose ${field} was altered after signing`, async () => {
      useLegitCert();
      const genuine = signedMessage('2');
      await expect(verifySnsMessage(genuine)).resolves.toBe(true);

      const forged = { ...genuine, [field]: tweak(genuine[field] as string) };
      await expect(verifySnsMessage(forged)).resolves.toBe(false);
    });
  }

  it('rejects an altered MessageId', async () => {
    useLegitCert();
    const genuine = signedMessage('1');
    await expect(
      verifySnsMessage({ ...genuine, MessageId: `${genuine.MessageId}0` }),
    ).resolves.toBe(false);
  });

  it('rejects a Subject added after signing', async () => {
    useLegitCert();
    const genuine = signedMessage('2');
    await expect(verifySnsMessage({ ...genuine, Subject: 'injected' })).resolves.toBe(false);
  });

  it('rejects a Subject removed after signing', async () => {
    useLegitCert();
    const genuine = signedMessage('2', { Subject: 'real' });
    const { Subject: _dropped, ...withoutSubject } = genuine;
    await expect(verifySnsMessage(withoutSubject as SnsMessage)).resolves.toBe(false);
  });

  it('rejects a SubscribeURL swapped for an attacker URL', async () => {
    // This one matters twice over: handle.ts fetches SubscribeURL.
    useLegitCert();
    const genuine = signedMessage('2', {
      Type: 'SubscriptionConfirmation',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription',
      Token: 't',
    });
    await expect(verifySnsMessage(genuine)).resolves.toBe(true);
    await expect(
      verifySnsMessage({ ...genuine, SubscribeURL: 'https://attacker.io/steal' }),
    ).resolves.toBe(false);
  });

  it('rejects a Type swapped between message families', async () => {
    useLegitCert();
    const genuine = signedMessage('2');
    await expect(
      verifySnsMessage({ ...genuine, Type: 'SubscriptionConfirmation' }),
    ).resolves.toBe(false);
  });

  it('rejects a signature lifted from a different genuine message', async () => {
    useLegitCert();
    const a = signedMessage('2', { MessageId: 'aaa' });
    const b = signedMessage('2', { MessageId: 'bbb' });
    await expect(verifySnsMessage({ ...a, Signature: b.Signature })).resolves.toBe(false);
    await expect(verifySnsMessage({ ...b, Signature: a.Signature })).resolves.toBe(false);
  });

  it('rejects a whole-body forgery signed with the attacker key', async () => {
    useLegitCert();
    const forged = signedMessage('2', {}, attacker.privateKey);
    await expect(verifySnsMessage(forged)).resolves.toBe(false);
  });

  it('rejects a genuine message when a substituted certificate is served', async () => {
    // Swapping the certificate does not help an attacker either: the fetched
    // key must be the one that actually signed. (What the host check buys is
    // that only AWS can serve bytes from an `amazonaws.com` URL over TLS —
    // that plus this signature check is the whole trust chain.)
    const { fetcher } = trackedFetcher(() => attackerPublicPem);
    setCertFetcher(fetcher);
    await expect(verifySnsMessage(signedMessage('2'))).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifySnsMessage — signature versions
// ---------------------------------------------------------------------------

describe('verifySnsMessage — SignatureVersion', () => {
  const rejected = ['3', '0', '', '1.0', 'v2', ' 1', '01', 'SHA256'];

  for (const version of rejected) {
    it(`rejects SignatureVersion ${JSON.stringify(version)}`, async () => {
      const calls = useLegitCert();
      const message = signedMessage('2');
      await expect(
        verifySnsMessage({ ...message, SignatureVersion: version }),
      ).resolves.toBe(false);
      expect(calls).toEqual([]);
    });
  }

  it('rejects a non-string SignatureVersion', async () => {
    useLegitCert();
    const message = signedMessage('2');
    await expect(
      verifySnsMessage({ ...message, SignatureVersion: 2 as unknown as string }),
    ).resolves.toBe(false);
  });

  it('rejects a SHA256 signature declared as version 1', async () => {
    useLegitCert();
    const message = signedMessage('2');
    await expect(verifySnsMessage({ ...message, SignatureVersion: '1' })).resolves.toBe(false);
  });

  it('rejects a SHA1 signature declared as version 2', async () => {
    useLegitCert();
    const message = signedMessage('1');
    await expect(verifySnsMessage({ ...message, SignatureVersion: '2' })).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifySnsMessage — certificate URL and fetching
// ---------------------------------------------------------------------------

describe('verifySnsMessage — certificate sourcing', () => {
  const hostileUrls = [
    'http://sns.us-east-1.amazonaws.com/x.pem',
    'https://evil-amazonaws.com/x.pem',
    'https://amazonaws.com.attacker.io/x.pem',
    'https://attacker.io/?x=amazonaws.com',
    'https://sns.amazonaws.com@attacker.io/x.pem',
    'file:///etc/passwd',
    'https://169.254.169.254/latest/meta-data/',
  ];

  for (const url of hostileUrls) {
    it(`refuses ${url} and never fetches it`, async () => {
      // Fetching an attacker-controlled URL from inside the deployment is an
      // SSRF primitive even when the signature would fail afterwards.
      const calls = useLegitCert();
      await expect(
        verifySnsMessage(signedMessage('2', { SigningCertURL: url })),
      ).resolves.toBe(false);
      expect(calls).toEqual([]);
    });
  }

  it('returns false when the fetcher rejects', async () => {
    const { fetcher } = trackedFetcher(() => Promise.reject(new Error('ECONNREFUSED')));
    setCertFetcher(fetcher);
    await expect(verifySnsMessage(signedMessage('2'))).resolves.toBe(false);
  });

  it('returns false when the fetcher throws synchronously', async () => {
    setCertFetcher((() => {
      throw new Error('boom');
    }) as unknown as CertFetcher);
    await expect(verifySnsMessage(signedMessage('2'))).resolves.toBe(false);
  });

  it('returns false when the fetcher rejects with a non-Error value', async () => {
    setCertFetcher(async () => {
      throw 'nope';
    });
    await expect(verifySnsMessage(signedMessage('2'))).resolves.toBe(false);
  });

  const badBodies: [string, string][] = [
    ['an empty body', ''],
    ['whitespace', '   \n  '],
    ['an HTML error page', '<html><body>404 Not Found</body></html>'],
    ['a truncated PEM', legitPublicPem.slice(0, 60)],
    ['PEM markers with garbage inside', '-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----'],
    ['a private key instead of a certificate', CERT_KEY_PEM],
  ];

  for (const [why, body] of badBodies) {
    it(`returns false for ${why}`, async () => {
      const { fetcher } = trackedFetcher(() => body);
      setCertFetcher(fetcher);
      await expect(verifySnsMessage(signedMessage('2'))).resolves.toBe(false);
    });
  }

  it('returns false when the fetcher resolves to a non-string', async () => {
    setCertFetcher((async () => null) as unknown as CertFetcher);
    await expect(verifySnsMessage(signedMessage('2'))).resolves.toBe(false);
    setCertFetcher((async () => ({ pem: legitPublicPem })) as unknown as CertFetcher);
    await expect(verifySnsMessage(signedMessage('2'))).resolves.toBe(false);
  });

  it('returns false for a valid PEM that is not an RSA key', async () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const { fetcher } = trackedFetcher(
      () => ec.publicKey.export({ type: 'spki', format: 'pem' }) as string,
    );
    setCertFetcher(fetcher);
    await expect(verifySnsMessage(signedMessage('2'))).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifySnsMessage — malformed messages
// ---------------------------------------------------------------------------

describe('verifySnsMessage — malformed input never throws', () => {
  const required: (keyof SnsMessage)[] = [
    'Type',
    'MessageId',
    'TopicArn',
    'Message',
    'Timestamp',
    'SignatureVersion',
    'Signature',
    'SigningCertURL',
  ];

  for (const field of required) {
    it(`rejects a message missing ${field}`, async () => {
      useLegitCert();
      const message = signedMessage('2');
      const { [field]: _removed, ...rest } = message;
      await expect(verifySnsMessage(rest as SnsMessage)).resolves.toBe(false);
    });

    it(`rejects a message whose ${field} is not a string`, async () => {
      useLegitCert();
      const message = signedMessage('2');
      await expect(
        verifySnsMessage({ ...message, [field]: 42 } as unknown as SnsMessage),
      ).resolves.toBe(false);
      await expect(
        verifySnsMessage({ ...message, [field]: null } as unknown as SnsMessage),
      ).resolves.toBe(false);
    });

    it(`rejects a message whose ${field} is empty`, async () => {
      useLegitCert();
      await expect(verifySnsMessage({ ...signedMessage('2'), [field]: '' })).resolves.toBe(
        false,
      );
    });
  }

  it('rejects null, undefined and non-objects', async () => {
    useLegitCert();
    for (const value of [null, undefined, 'Notification', 42, true, []]) {
      await expect(verifySnsMessage(value as unknown as SnsMessage)).resolves.toBe(false);
    }
  });

  it('rejects an unknown Type even when everything else is genuine', async () => {
    useLegitCert();
    const genuine = signedMessage('2');
    for (const type of ['Lambda', 'notification', 'Notification ', 'Bounce']) {
      await expect(verifySnsMessage({ ...genuine, Type: type })).resolves.toBe(false);
    }
  });

  const badSignatures: [string, string][] = [
    ['non-base64 characters', '!!!not base64!!!'],
    ['a truncated signature', 'AAAA'],
    ['a base64 string of the wrong length', 'QUJD'],
    ['whitespace-padded base64', ' QUJDRA== '],
    ['an oversized signature', 'A'.repeat(200_000)],
  ];

  for (const [why, signature] of badSignatures) {
    it(`rejects ${why}`, async () => {
      useLegitCert();
      await expect(
        verifySnsMessage({ ...signedMessage('2'), Signature: signature }),
      ).resolves.toBe(false);
    });
  }

  it('rejects a message whose property access throws', async () => {
    useLegitCert();
    const hostile = new Proxy({} as SnsMessage, {
      get() {
        throw new Error('hostile getter');
      },
    });
    await expect(verifySnsMessage(hostile)).resolves.toBe(false);
  });

  it('rejects a message that throws a non-Error value', async () => {
    useLegitCert();
    const hostile = new Proxy({} as SnsMessage, {
      get() {
        throw 'hostile string';
      },
    });
    await expect(verifySnsMessage(hostile)).resolves.toBe(false);
  });

  it('never writes an email address to the logs', async () => {
    const spies = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
    setCertFetcher(async () => {
      throw new Error('cert fetch failed for victim@example.com');
    });
    await expect(
      verifySnsMessage(
        signedMessage('2', {
          Message: JSON.stringify({ complaint: { recipients: ['victim@example.com'] } }),
        }),
      ),
    ).resolves.toBe(false);

    const written = [
      ...spies.log.mock.calls,
      ...spies.warn.mock.calls,
      ...spies.error.mock.calls,
    ]
      .flat()
      .join(' ');
    expect(written).not.toContain('victim@example.com');
  });
});

// ---------------------------------------------------------------------------
// The certificate seam
// ---------------------------------------------------------------------------

describe('the certificate fetcher seam', () => {
  it('caches a certificate per URL instead of refetching it', async () => {
    const calls = useLegitCert();
    await expect(verifySnsMessage(signedMessage('2', { MessageId: 'a' }))).resolves.toBe(true);
    await expect(verifySnsMessage(signedMessage('1', { MessageId: 'b' }))).resolves.toBe(true);
    expect(calls).toEqual([CERT_URL]);
  });

  it('fetches separately for a different certificate URL', async () => {
    const other = 'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-other.pem';
    const calls = useLegitCert();
    await verifySnsMessage(signedMessage('2'));
    await verifySnsMessage(signedMessage('2', { SigningCertURL: other }));
    expect(calls).toEqual([CERT_URL, other]);
  });

  it('does not cache a failed fetch', async () => {
    let attempt = 0;
    setCertFetcher(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('transient');
      return legitPublicPem;
    });
    await expect(verifySnsMessage(signedMessage('2'))).resolves.toBe(false);
    await expect(verifySnsMessage(signedMessage('2'))).resolves.toBe(true);
    expect(attempt).toBe(2);
  });

  it('clears the cache when the fetcher is swapped', async () => {
    useLegitCert();
    await expect(verifySnsMessage(signedMessage('2'))).resolves.toBe(true);

    setCertFetcher(async () => attackerPublicPem);
    await expect(verifySnsMessage(signedMessage('2'))).resolves.toBe(false);

    setCertFetcher(async () => legitPublicPem);
    await expect(verifySnsMessage(signedMessage('2'))).resolves.toBe(true);
  });

  it('evicts the oldest entry rather than growing without bound', async () => {
    // The URL is attacker-influenced even after the host check, so the cache
    // must not be a memory-growth primitive.
    const calls = useLegitCert();
    const genuine = signedMessage('2');
    const urlFor = (i: number) => `https://sns.us-east-1.amazonaws.com/cert-${i}.pem`;

    for (let i = 0; i < 20; i += 1) {
      await expect(
        verifySnsMessage({ ...genuine, SigningCertURL: urlFor(i) }),
      ).resolves.toBe(true);
    }
    expect(calls).toHaveLength(20);

    // The first URL has aged out and is fetched again; a recent one has not.
    await verifySnsMessage({ ...genuine, SigningCertURL: urlFor(0) });
    expect(calls).toHaveLength(21);
    await verifySnsMessage({ ...genuine, SigningCertURL: urlFor(19) });
    expect(calls).toHaveLength(21);
  });

  it('does not sign over SigningCertURL — the host check is what constrains it', async () => {
    // AWS does not include the certificate URL in the canonical string, so a
    // man-in-the-middle can rewrite it freely on an otherwise genuine message.
    // That is precisely why isValidSigningCertUrl has to stand on its own.
    const genuine = signedMessage('2');
    expect(buildStringToSign(genuine)).not.toContain('SigningCertURL');

    const calls = useLegitCert();
    const rehosted = {
      ...genuine,
      SigningCertURL: 'https://sns.ap-south-1.amazonaws.com/other.pem',
    };
    await expect(verifySnsMessage(rehosted)).resolves.toBe(true);
    expect(calls).toEqual(['https://sns.ap-south-1.amazonaws.com/other.pem']);

    setCertFetcher(async () => attackerPublicPem);
    await expect(
      verifySnsMessage({ ...genuine, SigningCertURL: 'https://attacker.io/other.pem' }),
    ).resolves.toBe(false);
  });

  describe('the default network fetcher', () => {
    it('fetches over HTTPS without following redirects', async () => {
      // A redirect off an amazonaws.com host would launder the host check, so
      // the default fetcher must refuse to follow one.
      const fetchMock = vi.fn(async () => new Response(legitPublicPem, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      setCertFetcher(undefined);

      await expect(verifySnsMessage(signedMessage('2'))).resolves.toBe(true);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(CERT_URL);
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('treats a non-2xx certificate response as a failure', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('Not Found', { status: 404 })),
      );
      setCertFetcher(undefined);
      await expect(verifySnsMessage(signedMessage('2'))).resolves.toBe(false);
    });

    it('treats a network error as a failure', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError('fetch failed');
        }),
      );
      setCertFetcher(undefined);
      await expect(verifySnsMessage(signedMessage('2'))).resolves.toBe(false);
    });
  });

  it('restores the network fetcher when set to undefined', async () => {
    const unreachable = 'https://sns-no-such-host.amazonaws.com/SimpleNotificationService.pem';
    const calls = useLegitCert();
    const message = signedMessage('2', { SigningCertURL: unreachable });
    await expect(verifySnsMessage(message)).resolves.toBe(true);

    setCertFetcher(undefined);
    // The real fetcher cannot reach that host, and a failure is a rejection.
    await expect(verifySnsMessage(message)).resolves.toBe(false);
    expect(calls).toEqual([unreachable]);
  }, 30_000);
});
