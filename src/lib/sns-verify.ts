import { X509Certificate, createVerify } from 'node:crypto';

/**
 * SNS message signature verification (§8.1).
 *
 * A shared-secret URL is not sufficient. This endpoint is otherwise trivially
 * spoofable, and spoofing it means an attacker can suppress the entire list —
 * which is both a total outage of the product and unrecoverable, because you
 * cannot tell the forged suppressions from the real ones afterwards.
 */

export interface SnsMessage {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL?: string;
  SigningCertUrl?: string;
  SubscribeURL?: string;
  Token?: string;
  UnsubscribeURL?: string;
}

const SIGNABLE_KEYS: Record<string, string[]> = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
  UnsubscribeConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
};

/**
 * The certificate must come from AWS. Without this check an attacker signs a
 * message with their own key and points `SigningCertURL` at their own server,
 * and every signature verifies perfectly.
 */
export function isValidSigningCertUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (!url.pathname.endsWith('.pem')) return false;
  const host = url.hostname.toLowerCase();
  // `sns.<region>.amazonaws.com`, and the China partition equivalents.
  return /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(host);
}

export function buildStringToSign(message: SnsMessage): string | null {
  const keys = SIGNABLE_KEYS[message.Type];
  if (!keys) return null;

  let out = '';
  for (const key of keys) {
    const value = (message as unknown as Record<string, string | undefined>)[key];
    // Optional fields (Subject) are omitted entirely when absent, not blanked.
    if (value === undefined || value === null) continue;
    out += `${key}\n${value}\n`;
  }
  return out;
}

const certCache = new Map<string, { pem: string; fetchedAt: number }>();
const CERT_CACHE_TTL_MS = 60 * 60 * 1000;

async function fetchCertificate(url: string): Promise<string> {
  const cached = certCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < CERT_CACHE_TTL_MS) return cached.pem;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Certificate fetch failed: HTTP ${response.status}`);
    const pem = await response.text();
    certCache.set(url, { pem, fetchedAt: Date.now() });
    return pem;
  } finally {
    clearTimeout(timer);
  }
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export interface VerifyOptions {
  /** Test seam: supply the certificate instead of fetching it. */
  fetchCert?: (url: string) => Promise<string>;
  /** Rejects replayed messages. SNS timestamps are ISO-8601 UTC. */
  maxAgeMs?: number;
  now?: number;
}

export async function verifySnsMessage(
  message: SnsMessage,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const certUrl = message.SigningCertURL ?? message.SigningCertUrl;
  if (!certUrl) return { ok: false, reason: 'Missing SigningCertURL' };
  if (!isValidSigningCertUrl(certUrl)) return { ok: false, reason: 'SigningCertURL is not an AWS SNS endpoint' };
  if (!message.Signature) return { ok: false, reason: 'Missing Signature' };

  const stringToSign = buildStringToSign(message);
  if (stringToSign === null) return { ok: false, reason: `Unsupported message type: ${message.Type}` };

  const maxAgeMs = options.maxAgeMs ?? 60 * 60 * 1000;
  const timestamp = Date.parse(message.Timestamp);
  if (Number.isNaN(timestamp)) return { ok: false, reason: 'Invalid Timestamp' };
  if (Math.abs((options.now ?? Date.now()) - timestamp) > maxAgeMs) {
    return { ok: false, reason: 'Message timestamp outside the accepted window' };
  }

  const algorithm =
    message.SignatureVersion === '2' ? 'RSA-SHA256' : message.SignatureVersion === '1' ? 'RSA-SHA1' : null;
  if (!algorithm) return { ok: false, reason: `Unsupported SignatureVersion: ${message.SignatureVersion}` };

  let pem: string;
  try {
    pem = await (options.fetchCert ?? fetchCertificate)(certUrl);
  } catch (error) {
    return { ok: false, reason: `Certificate fetch failed: ${String(error)}` };
  }

  let publicKey;
  try {
    publicKey = new X509Certificate(pem).publicKey;
  } catch (error) {
    return { ok: false, reason: `Certificate parse failed: ${String(error)}` };
  }

  try {
    const verifier = createVerify(algorithm);
    verifier.update(stringToSign, 'utf8');
    verifier.end();
    const valid = verifier.verify(publicKey, message.Signature, 'base64');
    return valid ? { ok: true } : { ok: false, reason: 'Signature does not match' };
  } catch (error) {
    return { ok: false, reason: `Verification error: ${String(error)}` };
  }
}

/** Confirms a subscription by fetching the `SubscribeURL` (§8.1). */
export async function confirmSubscription(subscribeUrl: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(subscribeUrl);
  } catch {
    return false;
  }
  // The same host restriction as the certificate: this is an outbound request
  // made on the say-so of an inbound payload.
  if (url.protocol !== 'https:' || !/^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(url.hostname.toLowerCase())) {
    return false;
  }
  const response = await fetch(subscribeUrl);
  return response.ok;
}
