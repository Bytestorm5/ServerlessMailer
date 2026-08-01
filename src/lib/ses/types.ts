/**
 * The SES seam.
 *
 * Everything that sends mail depends on this interface, never on the AWS SDK
 * directly. That is what lets the send pipeline be tested exhaustively —
 * including throttling, partial batch failure and mid-batch crashes — without
 * a network, and it is what guarantees a test send exercises the real render
 * path (§6.5).
 */

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

export interface BulkDestination {
  email: string;
  /** Values substituted into the template placeholders for this recipient. */
  replacements: Record<string, string>;
  /** Per-recipient headers, notably List-Unsubscribe (§9.1). */
  headers: Record<string, string>;
}

export interface SendBulkParams {
  fromName: string;
  fromEmail: string;
  replyTo: string;
  configurationSet?: string;
  /**
   * Template with `{{placeholder}}` markers already resolved per destination by
   * the caller; the adapter performs the substitution so a single API call can
   * serve up to 50 personalised messages.
   */
  content: EmailContent;
  destinations: BulkDestination[];
}

export interface BulkResultEntry {
  email: string;
  status: 'success' | 'failed';
  messageId?: string;
  error?: string;
}

export interface SendSimpleParams {
  fromName: string;
  fromEmail: string;
  replyTo?: string;
  to: string;
  configurationSet?: string;
  content: EmailContent;
  headers?: Record<string, string>;
}

export interface SesAdapter {
  sendBulk(params: SendBulkParams): Promise<BulkResultEntry[]>;
  sendSimple(params: SendSimpleParams): Promise<{ messageId: string }>;
  /** Backs the "from-domain verified in SES" pre-send check (§6.6). */
  isIdentityVerified(domainOrEmail: string): Promise<boolean>;
}

/**
 * Thrown when SES signals `Throttling` / `TooManyRequestsException`. The
 * pipeline reacts by releasing the batch and exiting the run early (§7.5).
 */
export class SesThrottlingError extends Error {
  readonly throttled = true;
  constructor(message = 'SES throttling') {
    super(message);
    this.name = 'SesThrottlingError';
  }
}

export function isThrottlingError(err: unknown): boolean {
  if (err instanceof SesThrottlingError) return true;
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { name?: string; code?: string; message?: string };
  const marker = `${candidate.name ?? ''} ${candidate.code ?? ''} ${candidate.message ?? ''}`;
  return /throttl|TooManyRequests|Maximum sending rate exceeded|rate exceeded/i.test(marker);
}
