import { ObjectId } from 'mongodb';
import { env } from './env';
import { signPayload, verifyPayload } from './crypto';

/**
 * Open and click tracking tokens (§13).
 *
 * Click targets are signed, and the signature *is* the allowlist: the only
 * URLs the redirector will emit are the ones frozen onto the campaign at send
 * time and signed with the tracking secret. An unsigned redirector is an open
 * redirect and will be abused (§12).
 */

export interface OpenTokenPayload {
  campaignId: string;
  subscriberId: string;
}

export interface ClickTokenPayload extends OpenTokenPayload {
  url: string;
}

export function signOpenToken(campaignId: ObjectId | string, subscriberId: ObjectId | string): string {
  return signPayload(env.trackingSecret, `o:${String(campaignId)}:${String(subscriberId)}`);
}

export function verifyOpenToken(token: string): OpenTokenPayload | null {
  const payload = verifyPayload(env.trackingSecret, token);
  if (!payload) return null;
  const parts = payload.split(':');
  if (parts.length !== 3 || parts[0] !== 'o') return null;
  if (!ObjectId.isValid(parts[1] as string) || !ObjectId.isValid(parts[2] as string)) return null;
  return { campaignId: parts[1] as string, subscriberId: parts[2] as string };
}

export function signClickToken(
  campaignId: ObjectId | string,
  subscriberId: ObjectId | string,
  url: string,
): string {
  // The URL goes into the signed payload verbatim; `\n` cannot appear in a
  // valid URL, which makes it a safe field separator.
  return signPayload(env.trackingSecret, `c:${String(campaignId)}:${String(subscriberId)}\n${url}`);
}

export function verifyClickToken(token: string): ClickTokenPayload | null {
  const payload = verifyPayload(env.trackingSecret, token);
  if (!payload) return null;
  const newline = payload.indexOf('\n');
  if (newline < 0) return null;
  const head = payload.slice(0, newline);
  const url = payload.slice(newline + 1);
  const parts = head.split(':');
  if (parts.length !== 3 || parts[0] !== 'c') return null;
  if (!ObjectId.isValid(parts[1] as string) || !ObjectId.isValid(parts[2] as string)) return null;
  if (!isSafeRedirectTarget(url)) return null;
  return { campaignId: parts[1] as string, subscriberId: parts[2] as string, url };
}

/**
 * Second gate on the redirect target. A valid signature already proves we
 * produced the URL, but a scheme check costs nothing and stops a signed
 * `javascript:` target from ever being emitted if one is somehow frozen onto
 * a campaign.
 */
export function isSafeRedirectTarget(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function openPixelUrl(token: string): string {
  return `${env.appBaseUrl}/api/t/o/${token}`;
}

export function clickUrl(token: string): string {
  return `${env.appBaseUrl}/api/t/c/${token}`;
}

/** Template variable for the Nth tracked link in a frozen body. */
export function clickVariable(index: number): string {
  return `c${index}`;
}

export const OPEN_PIXEL_VARIABLE = 'open_pixel_url';
