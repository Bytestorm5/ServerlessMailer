import type { ObjectId } from 'mongodb';

/* ------------------------------------------------------------------ lists */

/** One document per newsletter (i.e. per sending domain). Spec §3.1. */
export interface ListDoc {
  _id: ObjectId;
  name: string;
  sendingDomain: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  /** Legally required in every campaign email. */
  physicalAddress: string;
  sesConfigurationSet: string;
  active: boolean;
  /** Where a confirmed subscriber is sent after clicking the confirm link. */
  welcomeUrl?: string;
  createdAt: Date;
}

/* ------------------------------------------------------------ subscribers */

export const SUBSCRIBER_STATUSES = [
  'pending',
  'confirmed',
  'unsubscribed',
  'bounced',
  'complained',
] as const;
export type SubscriberStatus = (typeof SUBSCRIBER_STATUSES)[number];

export type SubscriberSource = 'web_form' | 'import' | 'api';

export type UnsubscribeSource =
  | 'one_click'
  | 'preferences_page'
  | 'complaint'
  | 'admin';

/** Spec §3.2. */
export interface SubscriberDoc {
  _id: ObjectId;
  listId: ObjectId;
  /** Normalized: lowercased, trimmed. */
  email: string;
  /** Denormalized for domain-level analysis. */
  emailDomain: string;
  status: SubscriberStatus;
  attributes: Record<string, string>;
  source: SubscriberSource;

  createdAt: Date;
  confirmedAt?: Date;
  /** Consent evidence — append-only, never modified or deleted. */
  confirmIp?: string;
  /** Consent evidence — append-only, never modified or deleted. */
  confirmUserAgent?: string;
  unsubscribedAt?: Date;
  unsubscribeSource?: UnsubscribeSource;

  /** HMAC-SHA256 of the confirmation token. The raw token is never stored. */
  confirmTokenHash?: string;
  confirmTokenExpiresAt?: Date;
  /** Drives the once-per-hour confirmation resend limit. */
  confirmEmailSentAt?: Date;

  /** Append-only audit trail of every status transition. */
  history: SubscriberHistoryEntry[];

  /** Counter for transient bounces, keyed by campaign so repeats are distinct. */
  transientBounceCampaignIds?: ObjectId[];
}

export interface SubscriberHistoryEntry {
  at: Date;
  from: SubscriberStatus | null;
  to: SubscriberStatus;
  reason: string;
  campaignId?: ObjectId;
}

/* ----------------------------------------------------------- suppressions */

export type SuppressionReason =
  | 'hard_bounce'
  | 'complaint'
  | 'manual'
  | 'import';

/** Global across every list and domain. Spec §3.3. */
export interface SuppressionDoc {
  _id: ObjectId;
  email: string;
  reason: SuppressionReason;
  createdAt: Date;
  sourceCampaignId?: ObjectId;
  /** SES diagnostic code or free text. */
  detail?: string;
}

/* -------------------------------------------------------------- campaigns */

export const CAMPAIGN_STATUSES = [
  'draft',
  'scheduled',
  'sending',
  'paused',
  'sent',
  'failed',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export interface CampaignCounts {
  recipients: number;
  sent: number;
  failed: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
  delivered: number;
  opened: number;
  clicked: number;
}

/**
 * How a campaign body is authored (§6.1).
 *
 * `rich` is the editor's document JSON. `html` is markup the operator pasted in
 * whole, for the campaign the closed node set cannot express.
 */
export const BODY_MODES = ['rich', 'html'] as const;
export type BodyMode = (typeof BODY_MODES)[number];

/** Spec §3.4. */
export interface CampaignDoc {
  _id: ObjectId;
  listId: ObjectId;
  subject: string;
  preheader: string;
  /** Editor JSON — the source of truth in `rich` mode. HTML is a render target. */
  bodySource: EditorDoc;
  /** Absent on campaigns written before HTML mode existed; treated as `rich`. */
  bodyMode?: BodyMode;
  /** The pasted markup — the source of truth in `html` mode. */
  bodyHtmlSource?: string;
  /**
   * The list's template as it was at freeze time.
   *
   * Frozen alongside the body for the same reason the body is: it is where the
   * merge fields and their fallbacks live, and editing the template mid-send
   * would otherwise change what SES substitutes into an already-frozen email.
   */
  templateSource?: string;
  /** Rendered at send-freeze time, immutable thereafter. */
  bodyHtml?: string;
  /** Plain-text alternative, auto-generated. */
  bodyText?: string;
  status: CampaignStatus;
  segmentQuery: SegmentQuery;
  scheduledFor?: Date;
  /** When the body was rendered and recipients materialized. */
  frozenAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  pausedAt?: Date;
  pausedReason?: string;
  trackOpens: boolean;
  trackClicks: boolean;
  counts: CampaignCounts;
  createdAt: Date;
  updatedAt: Date;
}

/* -------------------------------------------------------- campaign_batches */

export type BatchStatus = 'pending' | 'claimed' | 'sent' | 'failed';

/** The unit of work. Spec §3.5. */
export interface CampaignBatchDoc {
  _id: ObjectId;
  campaignId: ObjectId;
  /** Max 50, matching the SES SendBulkEmail destination limit. */
  subscriberIds: ObjectId[];
  status: BatchStatus;
  leaseUntil?: Date;
  /** Invocation id, for debugging. */
  claimedBy?: string;
  attempts: number;
  lastError?: string;
  createdAt: Date;
  sentAt?: Date;
}

/* --------------------------------------------------------------- sent_log */

/** The hard guarantee against double-sends. Spec §3.6. */
export interface SentLogDoc {
  _id: ObjectId;
  campaignId: ObjectId;
  subscriberId: ObjectId;
  sesMessageId?: string;
  sentAt: Date;
}

/* ----------------------------------------------------------------- events */

export type EventType =
  | 'delivered'
  | 'open'
  | 'click'
  | 'bounce'
  | 'complaint'
  | 'reject';

/** Spec §3.7. */
export interface EventDoc {
  _id: ObjectId;
  campaignId?: ObjectId;
  subscriberId?: ObjectId;
  type: EventType;
  ts: Date;
  /** Clicks only. */
  url?: string;
  detail?: string;
  /** Dedupe key so at-least-once SNS delivery stays idempotent. */
  dedupeKey?: string;
}

/* ------------------------------------------------------- campaign_versions */

/** Recoverable autosave history. Spec §6.1 requires at least the last 20. */
export interface CampaignVersionDoc {
  _id: ObjectId;
  campaignId: ObjectId;
  subject: string;
  preheader: string;
  bodySource: EditorDoc;
  bodyMode?: BodyMode;
  bodyHtmlSource?: string;
  createdAt: Date;
}

/* -------------------------------------------------------- email_templates */

/**
 * The two emails a list sends that are worth designing (§6.2a).
 *
 * `campaign` is the newsletter shell — the whole email minus the body, with a
 * `{{content}}` slot where the campaign lands. `confirmation` is the double
 * opt-in email (§5.4), which has no body to slot in: it is a complete email
 * whose one job is to get `{{confirm_url}}` clicked.
 */
export const TEMPLATE_KINDS = ['campaign', 'confirmation'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/**
 * One hand-authored HTML template per list, per kind (§6.2a).
 *
 * A list with no template document for a kind renders that email through the
 * built-in layout instead, which is what every list starts with.
 */
export interface EmailTemplateDoc {
  _id: ObjectId;
  listId: ObjectId;
  kind: TemplateKind;
  html: string;
  createdAt: Date;
  updatedAt: Date;
}

/* ------------------------------------------------------------ rate limits */

export interface RateLimitDoc {
  _id: string;
  count: number;
  windowStart: Date;
  expiresAt: Date;
}

/* -------------------------------------------------------------- seed list */

export interface SeedAddressDoc {
  _id: ObjectId;
  listId: ObjectId;
  email: string;
  label?: string;
  createdAt: Date;
}

/* ------------------------------------------------------------ import jobs */

export interface ImportAttestationDoc {
  _id: ObjectId;
  listId: ObjectId;
  /** Exact wording the operator agreed to, logged verbatim as evidence. */
  attestationText: string;
  attestedBy: string;
  attestedAt: Date;
  filename?: string;
  rowCount: number;
  importedAsConfirmed: boolean;
}

/* --------------------------------------------------------------- segments */

/** Spec §4.2 — a small, fixed set of filters, not a general query builder. */
export interface SegmentQuery {
  /** Signup date range (inclusive lower, exclusive upper). */
  signedUpAfter?: string;
  signedUpBefore?: string;
  /** Signup source. */
  source?: SubscriberSource;
  /** Arbitrary attribute equality. */
  attributeEquals?: { key: string; value: string }[];
  /** Arbitrary attribute existence. */
  attributeExists?: string[];
  /** Engagement: opened at least one of the last N campaigns. */
  openedInLastNCampaigns?: number;
}

/* ----------------------------------------------------------- editor model */

/**
 * Tiptap-compatible document JSON. This is the campaign source of truth.
 *
 * The supported node set is deliberately closed (spec §6.1): headings,
 * bold/italic, links, lists, blockquotes, images and horizontal rules.
 */
export interface EditorDoc {
  type: 'doc';
  content: EditorNode[];
}

export interface EditorNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: EditorNode[];
  marks?: EditorMark[];
  text?: string;
}

export interface EditorMark {
  type: string;
  attrs?: Record<string, unknown>;
}

/* ------------------------------------------------------ pre-send gate (§6.6) */

/**
 * One row of the pre-send validation gate. Declared here rather than in
 * `presend.ts` so the confirmation UI can depend on the shape without pulling
 * in the database-backed validator.
 */
export interface PresendCheck {
  id: string;
  label: string;
  passed: boolean;
  detail?: string;
}

export interface PresendResult {
  passed: boolean;
  checks: PresendCheck[];
  recipientCount: number;
}

/* -------------------------------------------------------------- rendering */

/** Per-recipient data used for merge-field substitution and tokenised links. */
export interface RecipientContext {
  subscriberId: string;
  email: string;
  attributes: Record<string, string>;
  unsubscribeUrl: string;
  /** Present only when the campaign has open tracking enabled. */
  openPixelUrl?: string;
  /** Signs click-tracking redirects; absent when click tracking is off. */
  trackingToken?: string;
}
