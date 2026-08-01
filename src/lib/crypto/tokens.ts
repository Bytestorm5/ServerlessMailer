/**
 * Cryptographic tokens.
 *
 * Three unrelated token families live here because they share one wire format
 * and one verification discipline:
 *
 *  - **Confirmation tokens** (§5.1, §5.2) — 32 random bytes handed to the
 *    subscriber once. Only the HMAC is persisted, so a database leak cannot be
 *    turned into a list of working confirmation links.
 *  - **Recipient tokens** (§9.2) — identify `(subscriber, campaign)` and are
 *    signed with `UNSUBSCRIBE_SECRET`. They deliberately never expire: an
 *    unsubscribe link in a three-year-old email must still work, because a
 *    broken unsubscribe becomes a spam complaint, and complaints are measured
 *    against the account-level thresholds in §8.3.
 *  - **Click tokens** (§12, §13) — carry the redirect target, signed with
 *    `TRACKING_SECRET`. An unsigned redirector is an open redirect.
 *
 * Two rules hold everywhere in this file:
 *
 *  1. Every `verify*` function returns `null` for *any* malformed input and
 *     never throws. These functions sit behind public, unauthenticated HTTP
 *     endpoints; an exception there is a 500 on the most availability-critical
 *     route in the system (§9).
 *  2. Verification never compares a decoded field. It re-derives the canonical
 *     token from the parsed values and compares the whole token in constant
 *     time. That single rule kills a whole family of bugs at once: non-canonical
 *     base64, signature splicing between payloads, reordered JSON keys, and
 *     smuggled extra fields all fail because they do not reproduce byte-for-byte.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { config } from '@/lib/config';

const TOKEN_SEPARATOR = '.';
const CONFIRM_TOKEN_BYTES = 32;
const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* primitives                                                          */
/* ------------------------------------------------------------------ */

export function hmacHex(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

function hmacBase64Url(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('base64url');
}

/**
 * Length-independent constant-time string comparison.
 *
 * `timingSafeEqual` throws when the two buffers differ in length, and an
 * attacker fully controls the length of a submitted token — so the raw call
 * would be both a crash and a length oracle. Hashing each side to a fixed
 * 32-byte digest first removes both problems: the comparison is always over
 * equal-length buffers, and the digest of a wrong guess reveals nothing about
 * how close the guess was.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aDigest = createHash('sha256').update(a, 'utf8').digest();
  const bDigest = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(aDigest, bDigest);
}

function encodeSegment(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeSegment(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

/**
 * Splits `payload.signature`. Returns `null` unless there are exactly two
 * non-empty parts — base64url contains no `.`, so a well-formed token has
 * exactly one separator.
 */
function splitToken(token: string): [string, string] | null {
  if (typeof token !== 'string' || token === '') return null;
  const parts = token.split(TOKEN_SEPARATOR);
  if (parts.length !== 2) return null;
  const [payload, signature] = parts as [string, string];
  if (payload === '' || signature === '') return null;
  return [payload, signature];
}

/* ------------------------------------------------------------------ */
/* double opt-in (§5.1, §5.2)                                          */
/* ------------------------------------------------------------------ */

/**
 * Mints a confirmation token. The raw `token` goes into exactly one email and
 * is never persisted anywhere; only `tokenHash` is stored (§5.1 step 6).
 */
export function generateConfirmToken(now: Date = new Date()): {
  token: string;
  tokenHash: string;
  expiresAt: Date;
} {
  const token = randomBytes(CONFIRM_TOKEN_BYTES).toString('base64url');
  return {
    token,
    tokenHash: hashConfirmToken(token),
    expiresAt: new Date(now.getTime() + config.pendingExpiryDays() * DAY_MS),
  };
}

export function hashConfirmToken(token: string): string {
  return hmacHex(token, config.confirmTokenSecret());
}

/* ------------------------------------------------------------------ */
/* recipient tokens (§9.2)                                             */
/* ------------------------------------------------------------------ */

export interface RecipientTokenPayload {
  subscriberId: string;
  campaignId: string;
}

function signRecipient(subscriberId: string, campaignId: string, secret: string): string {
  const payload = `${subscriberId}${TOKEN_SEPARATOR}${campaignId}`;
  // The separator is inside the signed payload, so ("ab", "c") and ("a", "bc")
  // produce different signatures — no boundary-shifting forgery.
  return `${encodeSegment(payload)}${TOKEN_SEPARATOR}${hmacBase64Url(payload, secret)}`;
}

export function buildRecipientToken(subscriberId: string, campaignId: string): string {
  return signRecipient(subscriberId, campaignId, config.unsubscribeSecret());
}

export function verifyRecipientToken(token: string): RecipientTokenPayload | null {
  // Read outside the guard: a missing secret is a deployment fault, not
  // malformed input, and must not be silently swallowed into "invalid token".
  const secret = config.unsubscribeSecret();
  try {
    const parts = splitToken(token);
    if (!parts) return null;

    const payload = decodeSegment(parts[0]);
    const separator = payload.indexOf(TOKEN_SEPARATOR);
    // Exactly one separator, with a non-empty id on each side. Anything else is
    // ambiguous, and an ambiguous identity is resolved by refusing it.
    if (separator <= 0 || separator !== payload.lastIndexOf(TOKEN_SEPARATOR)) return null;
    if (separator === payload.length - 1) return null;

    const subscriberId = payload.slice(0, separator);
    const campaignId = payload.slice(separator + 1);

    if (!constantTimeEqual(signRecipient(subscriberId, campaignId, secret), token)) return null;
    return { subscriberId, campaignId };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* click tracking (§12, §13)                                           */
/* ------------------------------------------------------------------ */

export interface ClickTarget {
  campaignId: string;
  linkIndex: number;
  url: string;
}

/** Fixed key order — the canonical form is the only accepted encoding. */
function clickPayload(target: ClickTarget): string {
  return JSON.stringify({
    campaignId: target.campaignId,
    linkIndex: target.linkIndex,
    url: target.url,
  });
}

function signClick(target: ClickTarget, secret: string): string {
  const payload = clickPayload(target);
  return `${encodeSegment(payload)}${TOKEN_SEPARATOR}${hmacBase64Url(payload, secret)}`;
}

export function buildClickToken(target: ClickTarget): string {
  return signClick(target, config.trackingSecret());
}

export function verifyClickToken(token: string): ClickTarget | null {
  const secret = config.trackingSecret();
  try {
    const parts = splitToken(token);
    if (!parts) return null;

    const parsed: unknown = JSON.parse(decodeSegment(parts[0]));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

    const { campaignId, linkIndex, url } = parsed as Record<string, unknown>;
    if (typeof campaignId !== 'string' || campaignId === '') return null;
    if (typeof url !== 'string' || url === '') return null;
    if (typeof linkIndex !== 'number' || !Number.isFinite(linkIndex)) return null;

    const target: ClickTarget = { campaignId, linkIndex, url };
    // Re-signing the canonical form rejects reordered keys and smuggled extra
    // fields as well as an outright bad signature.
    if (!constantTimeEqual(signClick(target, secret), token)) return null;
    return target;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* redirect allowlist (§12)                                            */
/* ------------------------------------------------------------------ */

/**
 * Control characters and spaces. `new URL()` strips tabs and newlines while
 * parsing, which is exactly how `java\nscript:` slips past scheme checks, so
 * they are rejected before parsing rather than after.
 */
const FORBIDDEN_URL_CHARS = /[\u0000-\u0020\u007f]/;

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * DEVIATION — deliberately confined to this one function.
 *
 * `docs/CONTRACTS.md` §1 requires the `TRACKING_URL_ALLOWLIST` control, but the
 * frozen `src/lib/config.ts` has no accessor for it and this module may not
 * modify that file. Dropping the control was not an option — it is the thing
 * standing between the redirector and an open redirect — so the environment
 * read lives here, in one place, instead of being scattered.
 *
 * To retire the deviation, add to `config`:
 *
 *     trackingUrlAllowlist: () => process.env.TRACKING_URL_ALLOWLIST || undefined,
 *
 * and replace this body with `config.trackingUrlAllowlist()`.
 */
function readTrackingUrlAllowlist(): string | undefined {
  return process.env.TRACKING_URL_ALLOWLIST || undefined;
}

/** Lowercase and drop the root-zone dot, so `example.com.` matches `example.com`. */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '');
}

function isIpLiteral(host: string): boolean {
  return IPV4_LITERAL.test(host) || host.startsWith('[');
}

/**
 * Accepts `example.com`, `.example.com`, `*.example.com`, `https://example.com/`
 * and `example.com:443`, and normalises unicode hosts to punycode so that an
 * allowlist written in unicode matches the host `URL` actually produces.
 */
function normalizeAllowlistEntry(entry: string): string {
  const trimmed = entry.trim();
  const stripped = trimmed
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/^\*\./, '')
    .replace(/^\./, '');
  const host = stripped === '' ? '' : parseAllowlistHost(stripped);
  // An entry that normalises to nothing is kept verbatim rather than dropped.
  // Dropping it would shrink the allowlist, and an allowlist that shrinks to
  // empty stops being an allowlist at all — see `allowlistHosts`.
  return host === '' ? trimmed.toLowerCase() : host;
}

function parseAllowlistHost(value: string): string {
  try {
    return normalizeHost(new URL(`https://${value}`).hostname);
  } catch {
    return normalizeHost(value);
  }
}

/**
 * `null` means "no allowlist configured"; a list means "these hosts only".
 *
 * The distinction is the difference between a wide-open redirector and a closed
 * one. `TRACKING_URL_ALLOWLIST=".."` is a configured allowlist containing one
 * unusable entry, so it must deny everything — it must never collapse into the
 * unconfigured case. Only a value that is genuinely empty (unset, blank, or
 * nothing but separators) counts as unconfigured.
 */
function allowlistHosts(): string[] | null {
  const raw = readTrackingUrlAllowlist();
  if (raw === undefined) return null;
  const entries = raw.split(',').filter((entry) => entry.trim() !== '');
  if (entries.length === 0) return null;
  return entries.map(normalizeAllowlistEntry);
}

/**
 * Suffix matching on a dot boundary. Plain `endsWith` would let
 * `evil-example.com` through an `example.com` allowlist, which is the whole
 * point of the control. IP literals match exactly — `0.1` must not act as a
 * wildcard for `127.0.0.1`.
 */
function hostMatches(host: string, entry: string): boolean {
  if (host === entry) return true;
  if (isIpLiteral(host) || isIpLiteral(entry)) return false;
  return host.endsWith(`.${entry}`);
}

export function isAllowedRedirectTarget(url: string): boolean {
  if (typeof url !== 'string' || url === '') return false;
  if (FORBIDDEN_URL_CHARS.test(url)) return false;
  // Backslashes are normalised to slashes by browsers but not by every parser;
  // `\\evil.test` and `/\evil.test` are protocol-relative in practice.
  if (url.includes('\\')) return false;
  if (url.startsWith('//')) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  // `https://example.com@evil.test/` reads as example.com to a human and
  // resolves to evil.test. Refuse credentials outright.
  if (parsed.username !== '' || parsed.password !== '') return false;

  // `https://./`, `https://../` and `https://a../` all parse, and a host made
  // of bare dots would sail through dot-boundary suffix matching. Reject
  // anything that is not a plausible host before it gets near the allowlist.
  const host = normalizeHost(parsed.hostname);
  if (host === '' || host.startsWith('.') || host.endsWith('.')) return false;

  const allowed = allowlistHosts();
  if (allowed === null) return true;
  return allowed.some((entry) => hostMatches(host, entry));
}
