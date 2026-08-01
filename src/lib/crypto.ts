import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

export function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

export function fromBase64url(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

export function hmacHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function hmacBase64url(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

/** Constant-time comparison. Length differences short-circuit, which is fine —
 * token length is not a secret. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

// ---------------------------------------------------------------------------
// Signed payloads
//
// Format: `<base64url(payload)>.<base64url(hmac)>`. Used for unsubscribe and
// tracking tokens, both of which must survive for years and must not be
// enumerable (§9.2, §12).
// ---------------------------------------------------------------------------

export function signPayload(secret: string, payload: string): string {
  const encoded = base64url(payload);
  return `${encoded}.${hmacBase64url(secret, encoded)}`;
}

export function verifyPayload(secret: string, token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = hmacBase64url(secret, encoded);
  if (!safeEqual(signature, expected)) return null;
  try {
    return fromBase64url(encoded).toString('utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Password hashing (admin UI only — there are no subscriber logins)
// ---------------------------------------------------------------------------

const SCRYPT_KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, SCRYPT_KEYLEN)) as Buffer;
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = fromBase64url(parts[1] as string);
  const expected = fromBase64url(parts[2] as string);
  const derived = (await scrypt(password, salt, expected.length)) as Buffer;
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
