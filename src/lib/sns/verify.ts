import { X509Certificate, createPublicKey, createVerify, type KeyObject } from 'node:crypto';
import { logger } from '@/lib/logging';

/**
 * SNS message signature verification (spec §8.1, contract §22).
 *
 * This is the only thing standing between the open internet and the
 * suppression list. Anyone can POST to `/api/webhooks/ses`; a forged
 * `Notification` claiming a complaint for every address on the list would
 * suppress the entire list, permanently and silently. So every branch below
 * fails closed: unknown shape, unknown version, unknown host, unfetchable
 * certificate, unparseable certificate, bad signature — all `false`, never an
 * exception, never a partial trust.
 *
 * The verification itself is real asymmetric crypto against the certificate AWS
 * publishes. Nothing here is a shared secret, and nothing here trusts a field
 * of the message to describe itself.
 */

export interface SnsMessage {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
}

export type CertFetcher = (url: string) => Promise<string>;

/** Generous, but bounded: a 4096-bit RSA signature is 684 base64 characters. */
const MAX_SIGNATURE_LENGTH = 4096;
const MAX_URL_LENGTH = 2048;
const CERT_FETCH_TIMEOUT_MS = 5_000;
const MAX_CACHED_CERTS = 16;

/** Only these two exist. Anything else is not an SNS message we will trust. */
const SIGNATURE_ALGORITHMS: Readonly<Record<string, string>> = {
  '1': 'RSA-SHA1',
  '2': 'RSA-SHA256',
};

/**
 * The canonical key sets AWS signs over, in AWS's order (which is alphabetical,
 * and must not be re-derived from the message — the *order* is part of the
 * contract, and so is the fact that `Subject` is signed only for a
 * Notification).
 */
const NOTIFICATION_KEYS = [
  'Message',
  'MessageId',
  'Subject',
  'Timestamp',
  'TopicArn',
  'Type',
] as const;

const SUBSCRIPTION_KEYS = [
  'Message',
  'MessageId',
  'SubscribeURL',
  'Timestamp',
  'Token',
  'TopicArn',
  'Type',
] as const;

const REQUIRED_FIELDS = [
  'Type',
  'MessageId',
  'TopicArn',
  'Message',
  'Timestamp',
  'SignatureVersion',
  'Signature',
  'SigningCertURL',
] as const;

// ---------------------------------------------------------------------------
// The certificate seam
// ---------------------------------------------------------------------------

const defaultCertFetcher: CertFetcher = async (url) => {
  const response = await fetch(url, {
    // A redirect off an `amazonaws.com` host would defeat the host check
    // entirely, so a redirect is an error rather than something to follow.
    redirect: 'error',
    signal: AbortSignal.timeout(CERT_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`certificate fetch returned ${response.status}`);
  }
  return await response.text();
};

let certFetcher: CertFetcher = defaultCertFetcher;

/**
 * Certificates are immutable per URL (AWS rotates by publishing a new URL), so
 * caching the parsed key saves a network round trip on every single webhook
 * without weakening anything. Bounded, because the URL is attacker-influenced —
 * it is host-checked, but an attacker could still name many distinct paths.
 */
const keyCache = new Map<string, KeyObject>();

export function setCertFetcher(f: CertFetcher | undefined): void {
  certFetcher = f ?? defaultCertFetcher;
  // Swapping the seam must not leave a key fetched by the previous one behind.
  keyCache.clear();
}

function cacheKey(url: string, key: KeyObject): void {
  if (keyCache.size >= MAX_CACHED_CERTS) {
    const oldest = keyCache.keys().next().value;
    if (oldest !== undefined) keyCache.delete(oldest);
  }
  keyCache.set(url, key);
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

const CERT_HOST = 'amazonaws.com';
const CERT_HOST_SUFFIX = '.amazonaws.com';

/**
 * The certificate may only come from AWS, over TLS.
 *
 * The host must match on a dot boundary: `evil-amazonaws.com` and
 * `amazonaws.com.attacker.io` are both hosts an attacker can register, and a
 * naive `includes('amazonaws.com')` accepts both — along with
 * `https://attacker.io/?x=amazonaws.com`. Userinfo is rejected outright:
 * `https://sns.amazonaws.com@attacker.io/x.pem` reads as an AWS URL to a human
 * and resolves to `attacker.io`.
 */
export function isValidSigningCertUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;
  // Anything before an `@` is a spoofing device; AWS never sends credentials.
  if (parsed.username !== '' || parsed.password !== '') return false;

  const host = parsed.hostname.toLowerCase();
  return host === CERT_HOST || host.endsWith(CERT_HOST_SUFFIX);
}

// ---------------------------------------------------------------------------
// Canonical string
// ---------------------------------------------------------------------------

function signableKeysFor(type: unknown): readonly string[] | null {
  if (type === 'Notification') return NOTIFICATION_KEYS;
  if (type === 'SubscriptionConfirmation' || type === 'UnsubscribeConfirmation') {
    return SUBSCRIPTION_KEYS;
  }
  return null;
}

/**
 * Builds the exact byte sequence AWS signed: `key\nvalue\n` for each signable
 * key that is present, in AWS's order. An absent optional key contributes
 * nothing at all — which is why adding or removing `Subject` after signing
 * invalidates the signature.
 *
 * Returns `''` for a message type we do not know how to canonicalise. There is
 * nothing to verify against, so there is nothing to trust.
 */
export function buildStringToSign(message: SnsMessage): string {
  if (!message || typeof message !== 'object') return '';

  const keys = signableKeysFor((message as { Type?: unknown }).Type);
  if (!keys) return '';

  const record = message as unknown as Record<string, unknown>;
  let out = '';
  for (const key of keys) {
    const value = record[key];
    // Only strings are signable. A non-string here means a malformed message,
    // and `verifySnsMessage` rejects it before the signature ever matters.
    if (typeof value !== 'string') continue;
    out += `${key}\n${value}\n`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** Strict base64: Node would silently ignore stray characters otherwise. */
function isBase64(value: string): boolean {
  if (value.length === 0 || value.length > MAX_SIGNATURE_LENGTH) return false;
  if (value.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

async function loadPublicKey(url: string): Promise<KeyObject | null> {
  const cached = keyCache.get(url);
  if (cached) return cached;

  let pem: unknown;
  try {
    pem = await certFetcher(url);
  } catch (err) {
    // Never cached: a transient network failure must not blind the endpoint
    // until the next cold start.
    logger.warn('SNS signing certificate could not be fetched', {
      error: err instanceof Error ? err.message : 'unknown error',
    });
    return null;
  }

  if (typeof pem !== 'string' || pem.trim() === '') return null;

  let key: KeyObject;
  try {
    key = pem.includes('BEGIN CERTIFICATE')
      ? new X509Certificate(pem).publicKey
      : createPublicKey(pem);
  } catch {
    logger.warn('SNS signing certificate could not be parsed');
    return null;
  }

  // SNS signs with RSA. Refusing everything else keeps a surprising key type
  // from reaching the verifier.
  if (key.asymmetricKeyType !== 'rsa') return null;

  cacheKey(url, key);
  return key;
}

/**
 * Returns true only for a message that AWS demonstrably signed. Never throws:
 * the caller is an HTTP route, and an exception there would be a 500 that SNS
 * retries forever.
 */
export async function verifySnsMessage(message: SnsMessage): Promise<boolean> {
  try {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false;

    for (const field of REQUIRED_FIELDS) {
      const value = (message as unknown as Record<string, unknown>)[field];
      if (typeof value !== 'string' || value.length === 0) {
        logger.warn('SNS message rejected: malformed envelope', { field });
        return false;
      }
    }

    const algorithm = SIGNATURE_ALGORITHMS[message.SignatureVersion];
    if (!algorithm) {
      logger.warn('SNS message rejected: unsupported signature version');
      return false;
    }

    // Ordered deliberately: the canonical string and the host check are free,
    // and fetching an attacker-named URL is itself the attack (SSRF), so
    // nothing leaves the process until the URL has been vouched for.
    const stringToSign = buildStringToSign(message);
    if (stringToSign === '') {
      logger.warn('SNS message rejected: unsupported message type');
      return false;
    }

    if (!isValidSigningCertUrl(message.SigningCertURL)) {
      logger.warn('SNS message rejected: signing certificate URL is not an AWS HTTPS URL');
      return false;
    }

    if (!isBase64(message.Signature)) {
      logger.warn('SNS message rejected: signature is not base64');
      return false;
    }

    const key = await loadPublicKey(message.SigningCertURL);
    if (!key) return false;

    const verifier = createVerify(algorithm);
    verifier.update(stringToSign, 'utf8');
    const valid = verifier.verify(key, message.Signature, 'base64');
    if (!valid) {
      logger.warn('SNS message rejected: signature does not match');
    }
    return valid;
  } catch (err) {
    // Fail closed on anything unforeseen, including a hostile object shape.
    logger.warn('SNS message rejected: verification error', {
      error: err instanceof Error ? err.message : 'unknown error',
    });
    return false;
  }
}
