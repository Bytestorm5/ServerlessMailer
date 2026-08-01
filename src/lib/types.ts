import type { ObjectId } from 'mongodb';

// ---------------------------------------------------------------------------
// §3.1 lists
// ---------------------------------------------------------------------------

export interface ListDoc {
  _id: ObjectId;
  name: string;
  sendingDomain: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  /** Legally required in every email (§6.6). */
  physicalAddress: string;
  sesConfigurationSet: string;
  active: boolean;
  /** Where a confirmed subscriber is sent after clicking the confirm link (§5.2). */
  welcomeUrl?: string;
  /** Custom merge fields available to the editor, beyond the built-ins (§6.4). */
  mergeFields: string[];
  /** Saved seed addresses for test sends (§6.5). */
  seedEmails: string[];
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// §3.2 subscribers
// ---------------------------------------------------------------------------

export type SubscriberStatus = 'pending' | 'confirmed' | 'unsubscribed' | 'bounced' | 'complained';
export type SubscriberSource = 'web_form' | 'import' | 'api';
export type UnsubscribeSource = 'one_click' | 'preferences_page' | 'complaint' | 'admin';

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
  confirmedAt?: Date | null;
  /** Consent evidence — append-only, never modified or deleted (§5.3). */
  confirmIp?: string | null;
  confirmUserAgent?: string | null;
  /** Set when consent originates from an operator attestation on import (§4.3). */
  confirmAttestationId?: ObjectId | null;

  unsubscribedAt?: Date | null;
  unsubscribeSource?: UnsubscribeSource | null;

  bouncedAt?: Date | null;
  complainedAt?: Date | null;
  /** Transient bounces, keyed by campaign, for the repeat-failure rule (§8.2). */
  transientBounceCampaignIds?: ObjectId[];

  /** HMAC-SHA256 of the confirmation token. The raw token is never stored. */
  confirmTokenHash?: string | null;
  confirmTokenExpiresAt?: Date | null;
  /** Rate limits confirmation resends (§5.1). */
  confirmEmailSentAt?: Date | null;

  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// §3.3 suppressions — global across every list and domain
// ---------------------------------------------------------------------------

export type SuppressionReason = 'hard_bounce' | 'complaint' | 'manual' | 'import';

export interface SuppressionDoc {
  _id: ObjectId;
  email: string;
  reason: SuppressionReason;
  createdAt: Date;
  sourceCampaignId?: ObjectId | null;
  /** SES diagnostic code, or free text for manual entries. */
  detail?: string | null;
}

// ---------------------------------------------------------------------------
// §3.4 campaigns
// ---------------------------------------------------------------------------

export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'paused' | 'sent' | 'failed';

/** Tiptap document JSON — the source of truth for campaign body content (§6.1). */
export interface TiptapNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

export interface TiptapDoc extends TiptapNode {
  type: 'doc';
  content?: TiptapNode[];
}

/**
 * One resolved merge-field occurrence. Each occurrence gets its own template
 * variable so two uses of the same field with different fallbacks cannot
 * collide (§6.4).
 */
export interface MergePlanEntry {
  /** Template variable name embedded in the frozen body, e.g. `m0`. */
  variable: string;
  /** Subscriber field or attribute name, e.g. `first_name`. */
  field: string;
  /** Value substituted when the subscriber has no value for the field. */
  fallback: string;
}

export interface CampaignCounts {
  recipients: number;
  sent: number;
  failed: number;
  delivered: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
  opened: number;
  clicked: number;
}

export interface CampaignDoc {
  _id: ObjectId;
  listId: ObjectId;
  name: string;
  subject: string;
  preheader: string;
  /** Editor JSON — the source of truth. HTML is a render target (§6.1). */
  bodySource: TiptapDoc;
  /** Rendered at send-freeze time, immutable thereafter (§6.2). */
  bodyHtml?: string | null;
  /** Plain-text alternative, auto-generated (§6.2). */
  bodyText?: string | null;
  /** Subject with merge fields compiled to template variables, frozen at send. */
  subjectTemplate?: string | null;
  mergePlan?: MergePlanEntry[] | null;
  /** Click-tracked destinations, in template-variable order (§13). */
  trackedLinks?: string[] | null;

  status: CampaignStatus;
  segmentQuery: SegmentQuery;
  scheduledFor?: Date | null;
  frozenAt?: Date | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  pausedAt?: Date | null;
  pauseReason?: string | null;

  trackOpens: boolean;
  trackClicks: boolean;

  counts: CampaignCounts;

  createdAt: Date;
  updatedAt: Date;
  /** Autosave bookkeeping for the editor's saved-state indicator (§6.1). */
  lastEditedAt?: Date | null;
}

// ---------------------------------------------------------------------------
// §4.2 segmentation
// ---------------------------------------------------------------------------

export type AttributeOp = 'eq' | 'ne' | 'exists' | 'not_exists';

export interface AttributeFilter {
  key: string;
  op: AttributeOp;
  value?: string;
}

export interface SegmentQuery {
  signupAfter?: string | null;
  signupBefore?: string | null;
  sources?: SubscriberSource[] | null;
  attributes?: AttributeFilter[] | null;
  /** Engagement filter, only available when metrics are enabled (§4.2). */
  openedInLastNCampaigns?: number | null;
}

// ---------------------------------------------------------------------------
// §3.5 campaign_batches
// ---------------------------------------------------------------------------

export type BatchStatus = 'pending' | 'claimed' | 'sent' | 'failed';

export interface CampaignBatchDoc {
  _id: ObjectId;
  campaignId: ObjectId;
  listId: ObjectId;
  /** At most 50, matching the SES SendBulkEmail destination limit. */
  subscriberIds: ObjectId[];
  status: BatchStatus;
  leaseUntil: Date;
  /** Invocation id, for debugging a stuck send. */
  claimedBy?: string | null;
  attempts: number;
  lastError?: string | null;
  sentAt?: Date | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// §3.6 sent_log — the hard guarantee against double-sends
// ---------------------------------------------------------------------------

export interface SentLogDoc {
  _id: ObjectId;
  campaignId: ObjectId;
  subscriberId: ObjectId;
  sesMessageId?: string | null;
  sentAt: Date;
}

// ---------------------------------------------------------------------------
// §3.7 events
// ---------------------------------------------------------------------------

export type EventType = 'delivered' | 'open' | 'click' | 'bounce' | 'complaint' | 'reject' | 'send';

export interface EventDoc {
  _id: ObjectId;
  campaignId?: ObjectId | null;
  listId?: ObjectId | null;
  subscriberId?: ObjectId | null;
  type: EventType;
  ts: Date;
  /** Clicks only. */
  url?: string | null;
  detail?: string | null;
}

// ---------------------------------------------------------------------------
// Supporting collections
// ---------------------------------------------------------------------------

export interface AdminDoc {
  _id: ObjectId;
  email: string;
  passwordHash: string;
  createdAt: Date;
  lastLoginAt?: Date | null;
}

/** Editor version history — at least the last 20 saves are recoverable (§6.1). */
export interface CampaignVersionDoc {
  _id: ObjectId;
  campaignId: ObjectId;
  subject: string;
  preheader: string;
  bodySource: TiptapDoc;
  createdAt: Date;
}

export interface ImportJobDoc {
  _id: ObjectId;
  listId: ObjectId;
  filename: string;
  status: 'open' | 'completed' | 'aborted';
  /** Operator attested prior opt-in consent for this file (§4.3). */
  attested: boolean;
  attestationText?: string | null;
  attestedBy?: string | null;
  attestedAt?: Date | null;
  mapping: Record<string, string>;
  counts: {
    rows: number;
    created: number;
    updated: number;
    suppressed: number;
    invalid: number;
  };
  /** Bounded sample of rejected rows, reported back rather than silently dropped. */
  errors: { row: number; email: string; reason: string }[];
  createdAt: Date;
  completedAt?: Date | null;
}

/** Queued double opt-in confirmations from bulk imports (§4.3). */
export interface ConfirmationQueueDoc {
  _id: ObjectId;
  subscriberId: ObjectId;
  listId: ObjectId;
  status: 'pending' | 'claimed' | 'sent' | 'failed';
  leaseUntil: Date;
  attempts: number;
  lastError?: string | null;
  createdAt: Date;
}

export interface RateLimitDoc {
  _id: string;
  count: number;
  windowStart: Date;
  expiresAt: Date;
}

/** SNS delivers at least once; this makes handlers idempotent (§8.1). */
export interface SnsMessageDoc {
  _id: string;
  receivedAt: Date;
  expiresAt: Date;
}

export interface TestSendDoc {
  _id: ObjectId;
  campaignId: ObjectId;
  recipients: string[];
  sentAt: Date;
  sentBy: string;
}
