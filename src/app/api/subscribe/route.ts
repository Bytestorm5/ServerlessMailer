import { ObjectId } from 'mongodb';
import { config } from '@/lib/config';
import { generateConfirmToken } from '@/lib/crypto/tokens';
import { listsCollection } from '@/lib/db/collections';
import { buildConfirmationEmail } from '@/lib/email/confirmation';
import { hasMxRecord } from '@/lib/email/mx';
import { normalizeAndValidate } from '@/lib/email/normalize';
import { logger } from '@/lib/logging';
import { consumeRateLimit } from '@/lib/ratelimit';
import { clientIp } from '@/lib/request-context';
import { getSesAdapter } from '@/lib/ses/registry';
import { subscriberMergeData } from '@/lib/subscriber-name';
import { setConfirmToken, upsertPendingSubscriber } from '@/lib/subscribers';
import { isSuppressed } from '@/lib/suppressions';
import { getTemplateHtml } from '@/lib/templates';
import { verifyTurnstile } from '@/lib/turnstile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Signup (spec §5.1).
 *
 * The single most important property of this endpoint is that its response is
 * **identical** whether the address is new, already pending, already confirmed,
 * or suppressed. Any variation is an email enumeration oracle, so every path
 * below funnels into the same `genericSuccess()`.
 */

const HOUR_MS = 60 * 60 * 1000;

/** The name of the hidden field bots fill in and humans never see. */
const HONEYPOT_FIELDS = ['website', 'url', 'company'];

function genericSuccess(): Response {
  return Response.json(
    { ok: true, message: 'Check your inbox for a confirmation link.' },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}

function badRequest(message: string): Response {
  return Response.json({ ok: false, message }, { status: 400, headers: { 'cache-control': 'no-store' } });
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      return (await request.json()) as Record<string, unknown>;
    }
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const params = new URLSearchParams(await request.text());
      return Object.fromEntries(params.entries());
    }
    // Best effort for a client that forgot the header.
    return JSON.parse(await request.text()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * First-party name fields. Accepted both camelCased (JSON clients) and
 * snake_cased (plain form posts, matching the merge-field spelling); a
 * `first_name`/`last_name` key inside `attributes` still works too and is
 * routed to the same place by the upsert.
 */
function readName(body: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === 'string' && value.trim() !== '') return value.slice(0, 512);
  }
  return undefined;
}

function readAttributes(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // Only inert keys and scalar values; attributes end up in merge fields.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) continue;
    if (typeof value === 'string') out[key] = value.slice(0, 512);
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
  }
  return out;
}

export async function POST(request: Request): Promise<Response> {
  const body = await readBody(request);
  if (!body) return badRequest('Malformed request body.');

  const ip = clientIp(request) ?? 'unknown';

  // 1. Rate limit by IP before doing any work at all.
  const ipLimit = await consumeRateLimit(
    `subscribe:ip:${ip}`,
    config.signupRateLimitPerIpPerHour(),
    HOUR_MS,
  );
  if (!ipLimit.allowed) {
    return Response.json(
      { ok: false, message: 'Too many requests. Please try again later.' },
      { status: 429, headers: { 'cache-control': 'no-store' } },
    );
  }

  // 2. Honeypot. A bot that fills this in gets the same success response a
  //    human would, so it learns nothing and does not retry.
  for (const field of HONEYPOT_FIELDS) {
    const value = body[field];
    if (typeof value === 'string' && value.trim() !== '') {
      logger.info('signup rejected by honeypot');
      return genericSuccess();
    }
  }

  if (!(await verifyTurnstile(body.turnstileToken as string | undefined, ip))) {
    return badRequest('Verification failed. Please try again.');
  }

  // 3. Normalize and validate, including an MX lookup on the domain.
  const rawEmail = typeof body.email === 'string' ? body.email : '';
  const check = normalizeAndValidate(rawEmail);
  if (!check.ok) return badRequest('Please enter a valid email address.');

  const listIdRaw = typeof body.listId === 'string' ? body.listId : '';
  if (!ObjectId.isValid(listIdRaw)) return badRequest('Unknown list.');
  const list = await (await listsCollection()).findOne({
    _id: new ObjectId(listIdRaw),
    active: true,
  });
  if (!list) return badRequest('Unknown list.');

  if (!(await hasMxRecord(check.domain))) {
    // Accepting an address whose domain cannot receive mail guarantees a hard
    // bounce later, which is precisely what damages the bounce rate.
    return badRequest('That email domain cannot receive mail.');
  }

  // 4. Check suppressions. Return the same success response as any other
  //    submission and do nothing. Never disclose suppression state.
  if (await isSuppressed(check.email)) {
    logger.info('signup ignored for suppressed address', { domain: check.domain });
    return genericSuccess();
  }

  // 5. Upsert as pending.
  const { subscriber, alreadyConfirmed } = await upsertPendingSubscriber({
    listId: list._id,
    email: check.email,
    firstName: readName(body, 'firstName', 'first_name'),
    lastName: readName(body, 'lastName', 'last_name'),
    attributes: readAttributes(body.attributes),
    source: 'web_form',
  });

  if (alreadyConfirmed) {
    // Nothing to do, and nothing to reveal.
    return genericSuccess();
  }
  if (subscriber.status !== 'pending') {
    // Bounced or complained: upsert deliberately left them alone.
    return genericSuccess();
  }

  // Resend of a confirmation email is rate-limited to exactly once per hour per
  // address (§5.1), independently of the IP limit above. The limit is hard-coded
  // to 1 rather than configurable: a knob that permits three confirmation emails
  // an hour is a way to use this endpoint to mailbomb somebody.
  const resendLimit = await consumeRateLimit(
    `subscribe:email:${check.email}`,
    1,
    config.confirmResendIntervalMs(),
  );
  if (!resendLimit.allowed) return genericSuccess();

  // 6. Generate the token. Only its HMAC hash is stored.
  const { token, tokenHash, expiresAt } = generateConfirmToken();
  await setConfirmToken(subscriber._id, tokenHash, expiresAt);

  // 7. Send immediately via SES — transactional, not through the campaign cron.
  try {
    const ses = await getSesAdapter();
    await ses.sendSimple({
      fromName: list.fromName,
      fromEmail: list.fromEmail,
      replyTo: list.replyTo,
      to: check.email,
      configurationSet: list.sesConfigurationSet,
      content: await buildConfirmationEmail({
        list,
        token,
        templateHtml: await getTemplateHtml(list._id, 'confirmation'),
        attributes: subscriberMergeData(subscriber),
        email: check.email,
      }),
    });
  } catch (err) {
    // The pending record is deliberately left in place so a later resend can
    // recover the signup rather than losing it.
    logger.error('confirmation email failed to send', {
      domain: check.domain,
      error: (err as Error).message,
    });
  }

  // 8. Generic success.
  return genericSuccess();
}
