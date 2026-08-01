/**
 * Admin sessions.
 *
 * Signed with WebCrypto rather than `node:crypto` so the same verification code
 * runs in middleware (Edge runtime) and in route handlers (Node runtime).
 * There is exactly one session shape and one verifier.
 */

export const SESSION_COOKIE = 'sm_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface SessionPayload {
  email: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function createSessionToken(email: string, secret: string, now = Date.now()): Promise<string> {
  const payload: SessionPayload = { email, exp: now + SESSION_TTL_MS };
  const encoded = base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(encoded));
  return `${encoded}.${base64urlEncode(new Uint8Array(signature))}`;
}

export async function verifySessionToken(
  token: string | undefined,
  secret: string,
  now = Date.now(),
): Promise<{ email: string } | null> {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      base64urlDecode(signature) as unknown as ArrayBuffer,
      new TextEncoder().encode(encoded),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(encoded))) as SessionPayload;
    if (typeof payload.exp !== 'number' || payload.exp < now) return null;
    if (typeof payload.email !== 'string' || payload.email.length === 0) return null;
    return { email: payload.email };
  } catch {
    return null;
  }
}
