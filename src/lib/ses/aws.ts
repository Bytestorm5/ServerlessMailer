/**
 * The AWS SES v2 adapter — the *only* module in the codebase permitted to
 * import the AWS SDK (§CONTRACTS ground rules, §28).
 *
 * Everything above this file speaks `SesAdapter`, which is what lets the send
 * pipeline be tested exhaustively without a network. The responsibilities kept
 * here are deliberately narrow:
 *
 *  - translate `SendBulkParams` into a `SendBulkEmailCommand` that uses an
 *    **inline** template (no stored SES template to drift out of sync with the
 *    frozen campaign body, §7.1);
 *  - map the positional `BulkEmailEntryResults` back onto the destinations,
 *    degrading to per-destination failures rather than throwing when SES
 *    returns fewer results than we sent;
 *  - translate SES throttling into `SesThrottlingError`, which is the exact
 *    type the pipeline keys off to release the batch and back off (§7.5).
 *    Getting this wrong turns an SES rate problem into an SES rate incident.
 */

import {
  GetEmailIdentityCommand,
  SESv2Client,
  SendBulkEmailCommand,
  SendEmailCommand,
} from '@aws-sdk/client-sesv2';
import type {
  BulkEmailEntry,
  MessageHeader,
  SendBulkEmailCommandOutput,
  SendEmailCommandOutput,
  GetEmailIdentityCommandOutput,
} from '@aws-sdk/client-sesv2';

import { config } from '@/lib/config';
import { logger } from '@/lib/logging';
import { SesThrottlingError, isThrottlingError } from '@/lib/ses/types';
import type {
  BulkResultEntry,
  SendBulkParams,
  SendSimpleParams,
  SesAdapter,
} from '@/lib/ses/types';

const CHARSET = 'UTF-8';

/**
 * RFC 5322 `atext` plus `.` — a display name made only of these can be written
 * bare. Anything else (a comma, a colon, an angle bracket, a quote) has to be
 * quoted or it changes the meaning of the header.
 */
const SAFE_DISPLAY_NAME = /^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~.]+$/;

/** `ftext`: printable US-ASCII except colon. A name outside this is unsendable. */
const VALID_HEADER_NAME = /^[\x21-\x39\x3b-\x7e]+$/;

function stripNewlines(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}

/**
 * Builds `Name <email>`. The display name is the one place where attacker- or
 * operator-supplied text lands directly in a header, so newlines are folded out
 * before anything else happens.
 */
function formatFromAddress(fromName: string, fromEmail: string): string {
  const email = stripNewlines(fromEmail).trim();
  const name = stripNewlines(fromName).trim();
  if (!name) return email;
  if (SAFE_DISPLAY_NAME.test(name)) return `${name} <${email}>`;
  const quoted = name.replace(/([\\"])/g, '\\$1');
  return `"${quoted}" <${email}>`;
}

/**
 * Converts a header map into SES `MessageHeader[]`, dropping anything that
 * cannot be represented safely. Fail closed: a header we would have to mangle
 * is a header we do not send.
 */
function toMessageHeaders(headers: Record<string, string> | undefined): MessageHeader[] {
  if (!headers) return [];
  const out: MessageHeader[] = [];
  let dropped = 0;
  for (const [name, rawValue] of Object.entries(headers)) {
    if (!VALID_HEADER_NAME.test(name)) {
      dropped += 1;
      continue;
    }
    const value = stripNewlines(String(rawValue ?? '')).trim();
    if (!value) {
      dropped += 1;
      continue;
    }
    out.push({ Name: name, Value: value });
  }
  if (dropped > 0) {
    // Names only — values can contain a mailto: unsubscribe address (§12).
    logger.warn('dropped unrepresentable email headers', { dropped });
  }
  return out;
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  if (candidate.$metadata?.httpStatusCode === 404) return true;
  return /notfound/i.test(`${candidate.name ?? ''} ${candidate.code ?? ''}`);
}

/**
 * Every SDK call funnels through here so there is exactly one place where
 * throttling is recognised and re-typed.
 */
function rethrow(err: unknown, operation: string): never {
  if (isThrottlingError(err)) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('SES throttled', { operation });
    throw new SesThrottlingError(message);
  }
  throw err;
}

export function createAwsSesAdapter(client?: SESv2Client): SesAdapter {
  let injected = client;

  // Constructed lazily: `getSesAdapter()` memoises this adapter at import time
  // in serverless cold starts, and building a client there would resolve
  // credentials for a request that may never send mail.
  function resolveClient(): SESv2Client {
    if (!injected) {
      injected = new SESv2Client({ region: config.awsRegion() });
    }
    return injected;
  }

  async function sendBulk(params: SendBulkParams): Promise<BulkResultEntry[]> {
    const { destinations } = params;
    if (destinations.length === 0) return [];

    const entries: BulkEmailEntry[] = destinations.map((destination) => {
      const headers = toMessageHeaders(destination.headers);
      const entry: BulkEmailEntry = {
        Destination: { ToAddresses: [destination.email] },
        ReplacementEmailContent: {
          ReplacementTemplate: {
            ReplacementTemplateData: JSON.stringify(destination.replacements ?? {}),
          },
        },
      };
      // §9.1: this is how the per-recipient List-Unsubscribe header is delivered.
      if (headers.length > 0) entry.ReplacementHeaders = headers;
      return entry;
    });

    const command = new SendBulkEmailCommand({
      FromEmailAddress: formatFromAddress(params.fromName, params.fromEmail),
      ...(params.replyTo ? { ReplyToAddresses: [params.replyTo] } : {}),
      ...(params.configurationSet ? { ConfigurationSetName: params.configurationSet } : {}),
      DefaultContent: {
        Template: {
          // Inline content: no stored SES template to drift from the frozen body.
          TemplateContent: {
            Subject: params.content.subject,
            Html: params.content.html,
            Text: params.content.text,
          },
          TemplateData: '{}',
        },
      },
      BulkEmailEntries: entries,
    });

    let response: SendBulkEmailCommandOutput | undefined;
    try {
      response = await resolveClient().send(command);
    } catch (err) {
      rethrow(err, 'SendBulkEmail');
    }

    const results = response?.BulkEmailEntryResults ?? [];
    if (results.length < destinations.length) {
      // Reported as per-destination failures, never thrown: one truncated
      // response must not cost the whole batch its successful sends.
      logger.warn('SES returned fewer bulk results than destinations', {
        destinations: destinations.length,
        results: results.length,
      });
    }

    return destinations.map((destination, index) => {
      const result = results[index];
      if (!result) {
        return {
          email: destination.email,
          status: 'failed',
          error: 'No result returned by SES for this destination',
        };
      }
      if (result.Status === 'SUCCESS') {
        return {
          email: destination.email,
          status: 'success',
          ...(result.MessageId ? { messageId: result.MessageId } : {}),
        };
      }
      return {
        email: destination.email,
        status: 'failed',
        error: result.Error ?? result.Status ?? 'Unknown SES failure',
      };
    });
  }

  async function sendSimple(params: SendSimpleParams): Promise<{ messageId: string }> {
    const headers = toMessageHeaders(params.headers);

    const command = new SendEmailCommand({
      FromEmailAddress: formatFromAddress(params.fromName, params.fromEmail),
      Destination: { ToAddresses: [params.to] },
      ...(params.replyTo ? { ReplyToAddresses: [params.replyTo] } : {}),
      ...(params.configurationSet ? { ConfigurationSetName: params.configurationSet } : {}),
      Content: {
        Simple: {
          Subject: { Data: params.content.subject, Charset: CHARSET },
          Body: {
            // multipart/alternative — an HTML-only send is a deliverability
            // penalty (§6.2), so both parts always go.
            Html: { Data: params.content.html, Charset: CHARSET },
            Text: { Data: params.content.text, Charset: CHARSET },
          },
          ...(headers.length > 0 ? { Headers: headers } : {}),
        },
      },
    });

    let response: SendEmailCommandOutput | undefined;
    try {
      response = await resolveClient().send(command);
    } catch (err) {
      rethrow(err, 'SendEmail');
    }

    return { messageId: response?.MessageId ?? '' };
  }

  async function getIdentity(identity: string): Promise<GetEmailIdentityCommandOutput | null> {
    try {
      return await resolveClient().send(
        new GetEmailIdentityCommand({ EmailIdentity: identity }),
      );
    } catch (err) {
      // A missing identity is an answer ("not verified"), not a failure.
      if (isNotFoundError(err)) return null;
      rethrow(err, 'GetEmailIdentity');
    }
  }

  async function isIdentityVerified(domainOrEmail: string): Promise<boolean> {
    const identity = stripNewlines(domainOrEmail).trim().toLowerCase();
    if (!identity) return false;

    const direct = await getIdentity(identity);
    if (direct) return direct.VerifiedForSendingStatus === true;

    // An address identity may not exist while its domain identity does — that
    // is the normal Easy DKIM setup (§10.1), and it is what makes the address
    // sendable.
    const at = identity.indexOf('@');
    const domain = at >= 0 ? identity.slice(at + 1) : '';
    if (!domain) return false;

    const byDomain = await getIdentity(domain);
    return byDomain?.VerifiedForSendingStatus === true;
  }

  return { sendBulk, sendSimple, isIdentityVerified };
}
