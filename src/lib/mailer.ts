import {
  SESv2Client,
  SendEmailCommand,
  SendBulkEmailCommand,
  GetEmailIdentityCommand,
  type BulkEmailEntry,
  type MessageHeader,
  type MessageTag,
} from '@aws-sdk/client-sesv2';
import { env } from './env';
import { applyTemplateData } from './merge';
import { log, redactEmail } from './logger';

/**
 * Mail transport.
 *
 * Two drivers behind one interface. `console` is the default so that a
 * misconfigured preview deployment cannot mail 19,000 people; `ses` has to be
 * turned on deliberately.
 */

export interface TransactionalMessage {
  to: string;
  fromName: string;
  fromEmail: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  configurationSet?: string;
  tags?: Record<string, string>;
}

export interface BulkDestination {
  to: string;
  /** Per-recipient template data — merge values plus the unsubscribe URL. */
  replacementData: Record<string, string>;
  /** Per-recipient headers; this is how each recipient gets their own
   * `List-Unsubscribe` token inside a single bulk call. */
  headers?: Record<string, string>;
  tags?: Record<string, string>;
}

export interface BulkSendParams {
  fromName: string;
  fromEmail: string;
  replyTo?: string;
  configurationSet?: string;
  subjectTemplate: string;
  htmlTemplate: string;
  textTemplate: string;
  defaultData: Record<string, string>;
  destinations: BulkDestination[];
  tags?: Record<string, string>;
}

export type BulkEntryOutcome =
  | { ok: true; messageId: string | null }
  | { ok: false; error: string };

export interface BulkSendResult {
  outcomes: BulkEntryOutcome[];
}

export class ThrottlingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThrottlingError';
  }
}

export interface Mailer {
  sendTransactional(message: TransactionalMessage): Promise<{ messageId: string | null }>;
  sendBulk(params: BulkSendParams): Promise<BulkSendResult>;
  /** Used by the pre-send gate: is the from-domain verified in SES? (§6.6) */
  isIdentityVerified(domainOrEmail: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// SES
// ---------------------------------------------------------------------------

/** SES tag names and values accept only these characters. */
function sanitizeTagValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 256) || 'none';
}

function toMessageTags(tags?: Record<string, string>): MessageTag[] | undefined {
  if (!tags) return undefined;
  return Object.entries(tags).map(([Name, Value]) => ({
    Name: sanitizeTagValue(Name),
    Value: sanitizeTagValue(Value),
  }));
}

function toMessageHeaders(headers?: Record<string, string>): MessageHeader[] | undefined {
  if (!headers) return undefined;
  return Object.entries(headers).map(([Name, Value]) => ({ Name, Value }));
}

function formatFrom(name: string, email: string): string {
  // Quote the display name and strip characters that could break the header.
  const clean = name.replace(/["\\\r\n]/g, '').trim();
  return clean ? `"${clean}" <${email}>` : email;
}

/**
 * SES signals "slow down" through a handful of exception names and, in bulk
 * responses, through a per-entry status. Treating any of them as anything
 * other than back-pressure is how an account ends up throttled harder.
 */
export function isThrottlingError(error: unknown): boolean {
  if (error instanceof ThrottlingError) return true;
  const name = (error as { name?: string })?.name ?? '';
  const message = (error as { message?: string })?.message ?? '';
  return (
    name === 'Throttling' ||
    name === 'ThrottlingException' ||
    name === 'TooManyRequestsException' ||
    name === 'LimitExceededException' ||
    /throttl|rate exceeded|maximum sending rate/i.test(message)
  );
}

const THROTTLING_ENTRY_STATUSES = new Set([
  'ACCOUNT_THROTTLED',
  'ACCOUNT_DAILY_QUOTA_EXCEEDED',
  'ACCOUNT_SENDING_PAUSED',
  'CONFIGURATION_SET_SENDING_PAUSED',
  'ACCOUNT_SUSPENDED',
]);

export function isThrottlingStatus(status: string | undefined): boolean {
  return status !== undefined && THROTTLING_ENTRY_STATUSES.has(status);
}

let cachedClient: SESv2Client | undefined;

function sesClient(): SESv2Client {
  if (!cachedClient) {
    const accessKeyId = env.sesAccessKeyId;
    const secretAccessKey = env.sesSecretAccessKey;
    cachedClient = new SESv2Client({
      region: env.sesRegion,
      // Fall through to the ambient credential chain when explicit keys are
      // absent, so an IAM role works without further configuration.
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    });
  }
  return cachedClient;
}

class SesMailer implements Mailer {
  async sendTransactional(message: TransactionalMessage): Promise<{ messageId: string | null }> {
    const command = new SendEmailCommand({
      FromEmailAddress: formatFrom(message.fromName, message.fromEmail),
      Destination: { ToAddresses: [message.to] },
      ...(message.replyTo ? { ReplyToAddresses: [message.replyTo] } : {}),
      ...(message.configurationSet ? { ConfigurationSetName: message.configurationSet } : {}),
      EmailTags: toMessageTags(message.tags),
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: message.html, Charset: 'UTF-8' },
            Text: { Data: message.text, Charset: 'UTF-8' },
          },
          Headers: toMessageHeaders(message.headers),
        },
      },
    });

    try {
      const response = await sesClient().send(command);
      return { messageId: response.MessageId ?? null };
    } catch (error) {
      if (isThrottlingError(error)) throw new ThrottlingError((error as Error).message);
      throw error;
    }
  }

  async sendBulk(params: BulkSendParams): Promise<BulkSendResult> {
    const entries: BulkEmailEntry[] = params.destinations.map((destination) => ({
      Destination: { ToAddresses: [destination.to] },
      ReplacementEmailContent: {
        ReplacementTemplate: { ReplacementTemplateData: JSON.stringify(destination.replacementData) },
      },
      ReplacementHeaders: toMessageHeaders(destination.headers),
      ReplacementTags: toMessageTags(destination.tags),
    }));

    const command = new SendBulkEmailCommand({
      FromEmailAddress: formatFrom(params.fromName, params.fromEmail),
      ...(params.replyTo ? { ReplyToAddresses: [params.replyTo] } : {}),
      ...(params.configurationSet ? { ConfigurationSetName: params.configurationSet } : {}),
      DefaultEmailTags: toMessageTags(params.tags),
      DefaultContent: {
        Template: {
          TemplateContent: {
            Subject: params.subjectTemplate,
            Html: params.htmlTemplate,
            Text: params.textTemplate,
          },
          TemplateData: JSON.stringify(params.defaultData),
        },
      },
      BulkEmailEntries: entries,
    });

    let response;
    try {
      response = await sesClient().send(command);
    } catch (error) {
      if (isThrottlingError(error)) throw new ThrottlingError((error as Error).message);
      throw error;
    }

    const results = response.BulkEmailEntryResults ?? [];
    const outcomes: BulkEntryOutcome[] = params.destinations.map((_destination, index) => {
      const result = results[index];
      if (!result) return { ok: false, error: 'No result returned by SES for this destination' };
      if (result.Status === 'SUCCESS') return { ok: true, messageId: result.MessageId ?? null };
      if (isThrottlingStatus(result.Status)) {
        // One throttled entry means the account is over quota — surfacing it
        // as a per-address failure would burn the recipient's only attempt.
        throw new ThrottlingError(`SES returned ${result.Status}`);
      }
      return { ok: false, error: `${result.Status ?? 'UNKNOWN'}: ${result.Error ?? 'no detail'}` };
    });

    return { outcomes };
  }

  async isIdentityVerified(domainOrEmail: string): Promise<boolean> {
    const identity = domainOrEmail.includes('@') ? (domainOrEmail.split('@')[1] as string) : domainOrEmail;
    const check = async (value: string): Promise<boolean> => {
      try {
        const response = await sesClient().send(new GetEmailIdentityCommand({ EmailIdentity: value }));
        return response.VerifiedForSendingStatus === true;
      } catch {
        return false;
      }
    };
    if (await check(identity)) return true;
    // SES also accepts a verified individual address, and a verified parent
    // domain covers its subdomains.
    if (domainOrEmail.includes('@') && (await check(domainOrEmail))) return true;
    const parts = identity.split('.');
    for (let i = 1; i < parts.length - 1; i += 1) {
      if (await check(parts.slice(i).join('.'))) return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Console driver — local development and preview environments
// ---------------------------------------------------------------------------

class ConsoleMailer implements Mailer {
  async sendTransactional(message: TransactionalMessage): Promise<{ messageId: string | null }> {
    log.info('[console-mailer] transactional', {
      to: redactEmail(message.to),
      subject: message.subject,
      headers: message.headers,
    });
    // The body goes to stdout unredacted for local inspection; this driver is
    // never enabled in production.
    console.log('--- text body ---\n' + message.text + '\n--- end ---');
    return { messageId: `console-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` };
  }

  async sendBulk(params: BulkSendParams): Promise<BulkSendResult> {
    log.info('[console-mailer] bulk', {
      destinations: params.destinations.length,
      subject: params.subjectTemplate,
    });
    for (const destination of params.destinations) {
      const data = { ...params.defaultData, ...destination.replacementData };
      console.log(
        `--- to ${redactEmail(destination.to)} | ${applyTemplateData(params.subjectTemplate, data)} ---`,
      );
    }
    return {
      outcomes: params.destinations.map(() => ({
        ok: true as const,
        messageId: `console-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      })),
    };
  }

  async isIdentityVerified(): Promise<boolean> {
    return true;
  }
}

let cachedMailer: Mailer | undefined;

export function getMailer(): Mailer {
  if (!cachedMailer) {
    cachedMailer = env.mailerDriver === 'ses' ? new SesMailer() : new ConsoleMailer();
  }
  return cachedMailer;
}

/** Test seam — lets the suite install a recording mailer. */
export function setMailerForTesting(mailer: Mailer | undefined): void {
  cachedMailer = mailer;
}
