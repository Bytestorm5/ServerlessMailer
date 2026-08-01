# Module contracts

This file is the coordination artifact for the implementation. Every module
below has a fixed public signature. Implementations may add helpers, but must
not change these signatures, because other modules are written against them.

Spec section references (`§n`) point at `docs/SPEC.md`.

## Ground rules

- **TDD.** Write `tests/<area>/<module>.test.ts` first, watch it fail, then implement.
- Import via the `@/` alias (`@/lib/...`) and `@tests/` for helpers.
- Never import the AWS SDK outside `src/lib/ses/aws.ts`. Use `getSesAdapter()`.
- Never read `process.env` directly outside `src/lib/config.ts`.
- Never log an email address; use `logger` from `@/lib/logging`.
- All DB access goes through `@/lib/db/collections`.
- Every exported function takes an explicit `now: Date` parameter where time
  matters, defaulting to `new Date()`. This keeps time-dependent tests honest
  without faking timers.

## Already implemented (do not modify)

- `src/lib/types.ts` — all domain types
- `src/lib/config.ts` — env accessors
- `src/lib/logging.ts` — `logger`, `redactEmail`, `scrub`
- `src/lib/db/{client,collections,indexes}.ts`
- `src/lib/ses/types.ts` — `SesAdapter`, `SendBulkParams`, `SesThrottlingError`, `isThrottlingError`
- `src/lib/ses/registry.ts` — `getSesAdapter`, `setSesAdapter`, `resetSesAdapter`
- `tests/helpers/{global-setup,setup,factories,fake-ses}.ts`

---

## 1. `src/lib/crypto/tokens.ts`

```ts
export function hmacHex(value: string, secret: string): string;
export function constantTimeEqual(a: string, b: string): boolean;

// Double opt-in (§5.1, §5.2). Raw token is returned once and never stored.
export function generateConfirmToken(now?: Date): {
  token: string; tokenHash: string; expiresAt: Date;
};
export function hashConfirmToken(token: string): string;

// Recipient token: identifies (subscriber, campaign) and is signed (§9.2).
// Format: `${base64url(subscriberId.campaignId)}.${base64url(hmac)}`.
// No expiry — an unsubscribe link in a three-year-old email must still work.
export function buildRecipientToken(subscriberId: string, campaignId: string): string;
export function verifyRecipientToken(token: string):
  { subscriberId: string; campaignId: string } | null;

// Click tracking (§13, §12). The target URL is signed at render time so the
// redirector can never be turned into an open redirect.
export interface ClickTarget { campaignId: string; linkIndex: number; url: string }
export function buildClickToken(target: ClickTarget): string;
export function verifyClickToken(token: string): ClickTarget | null;

// Rejects unsigned or off-allowlist targets. Enforces http(s) and, when
// TRACKING_URL_ALLOWLIST is set, an explicit host allowlist.
export function isAllowedRedirectTarget(url: string): boolean;
```

`confirmTokenHash` uses `CONFIRM_TOKEN_SECRET`; recipient tokens use
`UNSUBSCRIBE_SECRET`; click tokens use `TRACKING_SECRET`. Verification must be
constant-time and must return `null` (never throw) on malformed input.

## 2. `src/lib/email/normalize.ts`

```ts
export function normalizeEmail(raw: string): string;          // trim + lowercase
export function isValidEmailSyntax(email: string): boolean;
export function emailDomain(email: string): string;           // '' when invalid
export type EmailCheck =
  | { ok: true; email: string; domain: string }
  | { ok: false; reason: 'empty' | 'syntax' | 'too_long' };
export function normalizeAndValidate(raw: string): EmailCheck;
```

## 3. `src/lib/email/mx.ts`

```ts
export type MxResolver = (domain: string) => Promise<{ exchange: string; priority: number }[]>;
export function setMxResolver(resolver: MxResolver | undefined): void; // test seam
export function resetMxResolver(): void;
export async function hasMxRecord(domain: string): Promise<boolean>;
```

Returns `true` unconditionally when `config.skipMxCheck()`. A DNS error means
"no MX" (fail closed on signup), never an unhandled rejection.

## 4. `src/lib/ratelimit.ts`

```ts
export interface RateLimitResult { allowed: boolean; remaining: number; resetAt: Date }
export async function consumeRateLimit(
  key: string, limit: number, windowMs: number, now?: Date,
): Promise<RateLimitResult>;
export async function peekRateLimit(key: string, limit: number, now?: Date): Promise<RateLimitResult>;
```

Fixed window, implemented as a single atomic `findOneAndUpdate` upsert keyed by
`${key}:${windowIndex}`. Must be safe under concurrency.

## 5. `src/lib/merge.ts`

Syntax: `{{ first_name | default: "there" }}` (§6.4).

```ts
export interface MergeFieldDefinition { key: string; label: string; description: string; system: boolean }
export const AVAILABLE_MERGE_FIELDS: readonly MergeFieldDefinition[];
// system fields (always resolvable, fallback not required):
//   unsubscribe_url, preferences_url, email, physical_address, list_name, subject
export interface MergeFieldRef { raw: string; field: string; fallback: string | null; index: number }

export function parseMergeFields(text: string): MergeFieldRef[];
export function renderMergeFields(text: string, data: Record<string, string>): string;
/** Fields that need a fallback but do not have one. Drives the §6.6 gate. */
export function findMergeFieldsWithoutFallback(text: string): MergeFieldRef[];
export function findUnknownMergeFields(text: string): MergeFieldRef[];
/** Converts `{{ x | default: "y" }}` to a bare `{{x}}` SES placeholder. */
export function toSesPlaceholders(text: string): string;
/** Resolves one recipient's values, applying each field's declared fallback. */
export function resolveReplacements(
  templateText: string, data: Record<string, string>,
): Record<string, string>;
```

Rendering must HTML-escape nothing (callers decide) and must leave unknown
fields untouched rather than emitting `undefined`.

## 6. `src/lib/render/doc.ts`

```ts
export const ALLOWED_NODE_TYPES: readonly string[];  // doc, paragraph, text, heading,
  // bulletList, orderedList, listItem, blockquote, image, horizontalRule, hardBreak
export const ALLOWED_MARK_TYPES: readonly string[];  // bold, italic, link
export function validateEditorDoc(input: unknown):
  { ok: true; doc: EditorDoc } | { ok: false; errors: string[] };
export function collectText(doc: EditorDoc): string;
export function collectLinks(doc: EditorDoc): { href: string; index: number }[];
export function collectImages(doc: EditorDoc): string[];
export function isEmptyDoc(doc: EditorDoc): boolean;
export function isImageOnly(doc: EditorDoc): boolean;  // images but no meaningful text
export function mapLinks(doc: EditorDoc, fn: (href: string, index: number) => string): EditorDoc;
```

`validateEditorDoc` rejects unknown node/mark types — the node set is closed
(§6.1) and an unvalidated doc is an HTML-injection vector.

## 7. `src/lib/render/markdown.ts`

```ts
export function docToMarkdown(doc: EditorDoc): string;
export function markdownToDoc(markdown: string): EditorDoc;
```

Round-tripping supported constructs must be lossless. Exists for portability
and export (§4.4), not as the internal source of truth.

## 8. `src/lib/render/text.ts`

```ts
export function docToPlainText(doc: EditorDoc): string;
```

Links render as `text (url)`. Headings get underlines. Lists get `- ` / `1. `.
This is the `multipart/alternative` text part (§6.2) — never empty for a
non-empty doc.

## 9. `src/lib/render/html.ts`

```ts
export interface EmailChrome {
  preheader?: string; physicalAddress: string; listName: string;
  unsubscribePlaceholder: string;  // e.g. '{{unsubscribe_url}}'
  openPixelUrl?: string;
}
export function docToMjml(doc: EditorDoc, chrome: EmailChrome): string;
export async function renderMjml(mjml: string): Promise<{ html: string; errors: string[] }>;
export async function docToEmailHtml(doc: EditorDoc, chrome: EmailChrome): Promise<string>;
```

`mjml` v5 is async: `(await import('mjml')).default(src)` resolves to
`{ html, json, errors }`. CSS is inlined via `<mj-style inline="inline">`.
All user text must be HTML-escaped. The physical address and an unsubscribe
link appear in the footer of every rendered email.

## 10. `src/lib/render/campaign.ts`

```ts
export interface RenderedCampaign { subject: string; html: string; text: string }
/** Frozen render: merge fields become bare SES placeholders, links are
 *  rewritten for click tracking when enabled. Called once, at freeze (§7.1). */
export async function renderCampaignForSend(
  campaign: CampaignDoc, list: ListDoc,
): Promise<RenderedCampaign>;
/** Fully-resolved render for preview and test sends — same code path (§6.5). */
export async function renderCampaignPreview(
  campaign: CampaignDoc, list: ListDoc, ctx: RecipientContext,
): Promise<RenderedCampaign>;
/** Per-recipient replacement data for SES (§7.4). */
export function buildReplacements(
  campaign: CampaignDoc, list: ListDoc, subscriber: SubscriberDoc,
): Record<string, string>;
export function buildRecipientHeaders(
  campaign: CampaignDoc, list: ListDoc, subscriber: SubscriberDoc,
): Record<string, string>;  // List-Unsubscribe + List-Unsubscribe-Post (§9.1)
```

## 11. `src/lib/presend.ts`

```ts
export interface PresendCheck { id: string; label: string; passed: boolean; detail?: string }
export interface PresendResult { passed: boolean; checks: PresendCheck[]; recipientCount: number }
export async function validateCampaignForSend(campaignId: ObjectId, now?: Date): Promise<PresendResult>;
```

Check ids, all mandatory, no override (§6.6): `subject`, `body_non_empty`,
`physical_address`, `unsubscribe_placeholder`, `merge_fallbacks`,
`links_absolute`, `from_domain_verified`, `recipient_count`.

## 12. `src/lib/suppressions.ts`

```ts
export async function isSuppressed(email: string): Promise<boolean>;
export async function filterSuppressed(emails: string[]): Promise<Set<string>>;  // returns suppressed subset
export async function addSuppression(input: {
  email: string; reason: SuppressionReason; detail?: string; sourceCampaignId?: ObjectId; now?: Date;
}): Promise<{ created: boolean }>;
export async function removeSuppression(email: string): Promise<boolean>;
export async function listSuppressions(opts?: {
  search?: string; limit?: number; skip?: number;
}): Promise<{ items: SuppressionDoc[]; total: number }>;
```

`addSuppression` is idempotent — a duplicate key means already suppressed and
returns `{ created: false }`, never throws.

## 13. `src/lib/subscribers.ts`

```ts
export async function upsertPendingSubscriber(input: {
  listId: ObjectId; email: string; attributes?: Record<string, string>;
  source: SubscriberSource; now?: Date;
}): Promise<{ subscriber: SubscriberDoc; created: boolean; alreadyConfirmed: boolean }>;

export async function setConfirmToken(subscriberId: ObjectId, tokenHash: string, expiresAt: Date, now?: Date): Promise<void>;
export async function confirmSubscriber(input: {
  token: string; ip?: string; userAgent?: string; now?: Date;
}): Promise<{ ok: true; subscriber: SubscriberDoc } | { ok: false; reason: 'unknown' | 'expired' }>;

export async function unsubscribeSubscriber(input: {
  subscriberId: ObjectId; source: UnsubscribeSource; campaignId?: ObjectId; now?: Date;
}): Promise<{ ok: boolean; alreadyUnsubscribed: boolean }>;
export async function resubscribe(subscriberId: ObjectId, now?: Date): Promise<boolean>;

export async function markBounced(input: { email: string; campaignId?: ObjectId; detail?: string; now?: Date }): Promise<void>;
export async function markComplained(input: { email: string; campaignId?: ObjectId; detail?: string; now?: Date }): Promise<void>;
export async function recordTransientBounce(input: { email: string; campaignId?: ObjectId; detail?: string; now?: Date }): Promise<{ suppressed: boolean }>;

export async function purgeExpiredPending(now?: Date): Promise<number>;
export async function findSubscribers(query: {
  listId?: ObjectId; status?: SubscriberStatus; search?: string;
  sort?: 'createdAt' | 'email'; direction?: 1 | -1; limit?: number; skip?: number;
}): Promise<{ items: SubscriberDoc[]; total: number }>;
```

Consent evidence (`confirmedAt`, `confirmIp`, `confirmUserAgent`) is written
once and never modified or cleared, including on unsubscribe (§5.3).
Every status change appends to `history`.

## 14. `src/lib/segments.ts`

```ts
export function segmentToFilter(listId: ObjectId, query: SegmentQuery): Filter<SubscriberDoc>;
export async function countSegment(listId: ObjectId, query: SegmentQuery): Promise<number>;
export async function resolveSegmentRecipients(input: {
  listId: ObjectId; query: SegmentQuery; campaignId: ObjectId;
}): Promise<ObjectId[]>;
```

`resolveSegmentRecipients` applies the full §7.1 exclusion set: status must be
`confirmed`, address must not be in `suppressions`, subscriber must not already
be in `sent_log` for this campaign. Status `confirmed` is always implicit and
cannot be overridden by the query.

## 15. `src/lib/pipeline/freeze.ts`

```ts
export async function freezeCampaign(campaignId: ObjectId, now?: Date): Promise<
  | { ok: true; recipients: number; batches: number }
  | { ok: false; reason: 'not_found' | 'wrong_status' | 'validation_failed' | 'no_recipients'; checks?: PresendCheck[] }
>;
```

One operation: re-evaluate the segment, exclude, render and store
`bodyHtml`/`bodyText`, materialise batches of ≤ `config.batchSize()`, set
`status='sending'`, `frozenAt`, `counts.recipients`. Must be idempotent — a
second freeze of an already-`sending` campaign returns `wrong_status` rather
than duplicating batches.

## 16. `src/lib/pipeline/claim.ts`

```ts
export async function activeSendingCampaignIds(now?: Date): Promise<ObjectId[]>;
export async function claimBatch(invocationId: string, now?: Date): Promise<CampaignBatchDoc | null>;
export async function releaseBatch(batchId: ObjectId, error?: string, now?: Date): Promise<void>;
export async function completeBatch(batchId: ObjectId, now?: Date): Promise<void>;
export async function failBatch(batchId: ObjectId, error: string, now?: Date): Promise<void>;
```

`claimBatch` is the single atomic `findOneAndUpdate` from §7.3. It must claim
`pending` batches and reclaim `claimed` batches whose `leaseUntil` has passed,
skip batches at `attempts >= MAX_ATTEMPTS`, and only ever touch campaigns whose
status is `sending` (so pausing takes effect within one minute).
`releaseBatch` sets `leaseUntil = now` and status back to `pending`.

## 17. `src/lib/pipeline/process.ts`

```ts
export interface ProcessBatchResult {
  sent: number; failed: number; skipped: number; throttled: boolean;
}
export async function processBatch(batch: CampaignBatchDoc, now?: Date): Promise<ProcessBatchResult>;
```

Per §7.4: load subscribers, **re-check suppression and status** (someone may
have unsubscribed since freeze), build replacements and per-recipient headers,
call `sendBulk`, then for each result insert into `sent_log` — a duplicate key
(code 11000) means already sent and is swallowed silently. One bad address must
never fail the whole batch. On throttling, release the batch and report
`throttled: true`. Sends are paced to `config.sesMaxSendRate()`.

## 18. `src/lib/pipeline/reconcile.ts`

```ts
export async function reconcileCompletedCampaigns(now?: Date): Promise<ObjectId[]>;
```

A campaign is `sent` once it has zero batches in `pending` or `claimed` (§7.6).
Sets `completedAt`. Campaigns with only `failed` batches remaining still
complete, but are surfaced with their `lastError`.

## 19. `src/lib/pipeline/circuit.ts`

```ts
export async function checkCircuitBreaker(campaignId: ObjectId, now?: Date): Promise<
  { tripped: boolean; complaintRate: number; delivered: number }
>;
export async function evaluateAllSendingCampaigns(now?: Date): Promise<ObjectId[]>;
```

Auto-pauses when the complaint rate exceeds
`config.complaintCircuitBreakerRate()` of delivered, once at least
`complaintCircuitBreakerMinDelivered()` messages have been delivered (§7.8).

## 20. `src/lib/pipeline/run.ts`

```ts
export interface CronRunSummary {
  invocationId: string; batchesProcessed: number; sent: number; failed: number;
  throttled: boolean; completedCampaigns: string[]; pausedCampaigns: string[];
  durationMs: number;
}
export async function runSendCycle(opts?: {
  now?: Date; deadlineMs?: number; maxBatches?: number;
}): Promise<CronRunSummary>;
```

The §7.2 loop. Also promotes `scheduled` campaigns whose `scheduledFor` has
passed by calling `freezeCampaign`, evaluates circuit breakers, and reconciles.

## 21. `src/lib/campaigns.ts`

```ts
export async function createCampaign(input: { listId: ObjectId; subject?: string; now?: Date }): Promise<CampaignDoc>;
export async function updateCampaignDraft(input: {
  campaignId: ObjectId; subject?: string; preheader?: string; bodySource?: EditorDoc;
  segmentQuery?: SegmentQuery; trackOpens?: boolean; trackClicks?: boolean; now?: Date;
}): Promise<{ ok: true; campaign: CampaignDoc } | { ok: false; reason: 'not_found' | 'immutable' | 'invalid_body'; errors?: string[] }>;
export async function listCampaignVersions(campaignId: ObjectId, limit?: number): Promise<CampaignVersionDoc[]>;
export async function restoreCampaignVersion(campaignId: ObjectId, versionId: ObjectId, now?: Date): Promise<boolean>;
export async function scheduleCampaign(campaignId: ObjectId, when: Date, now?: Date): Promise<{ ok: boolean; reason?: string }>;
export async function pauseCampaign(campaignId: ObjectId, reason?: string, now?: Date): Promise<boolean>;
export async function resumeCampaign(campaignId: ObjectId, now?: Date): Promise<boolean>;
export async function sendTestEmail(input: {
  campaignId: ObjectId; to: string[]; now?: Date;
}): Promise<{ ok: true; sent: number } | { ok: false; reason: string }>;
```

Only `draft`/`scheduled` campaigns are editable — a `sending` or `sent`
campaign is immutable (§7.1). Every draft update snapshots the previous body
into `campaign_versions`, retaining at least the last 20 (§6.1). Test sends
must go through the real render path and must never touch campaign counts,
`sent_log`, or batches (§6.5).

## 22. `src/lib/sns/verify.ts`

```ts
export interface SnsMessage {
  Type: string; MessageId: string; TopicArn: string; Message: string;
  Timestamp: string; SignatureVersion: string; Signature: string;
  SigningCertURL: string; Subject?: string; SubscribeURL?: string; Token?: string;
}
export type CertFetcher = (url: string) => Promise<string>;
export function setCertFetcher(f: CertFetcher | undefined): void;  // test seam
export function isValidSigningCertUrl(url: string): boolean;
export function buildStringToSign(message: SnsMessage): string;
export async function verifySnsMessage(message: SnsMessage): Promise<boolean>;
```

Must reject a `SigningCertURL` whose host is not under `amazonaws.com`, must
reject `http://`, and must reject hosts like `evil-amazonaws.com.attacker.io`.
Supports SignatureVersion 1 (SHA1) and 2 (SHA256). An attacker who can forge
this can suppress the entire list (§8.1) — treat every branch as security-critical.

## 23. `src/lib/sns/handle.ts`

```ts
export async function handleSnsNotification(raw: unknown): Promise<
  { handled: true; action: string } | { handled: false; reason: string }
>;
```

Handles `SubscriptionConfirmation` (fetches `SubscribeURL`), `Notification`
(bounce/complaint/delivery/reject per the §8.2 table), and `UnsubscribeConfirmation`.
Idempotent: SNS delivers at least once, so replaying an identical event must
not double-count. Permanent bounce → suppress + `status='bounced'`.
Complaint → suppress + `status='complained'`, always, no threshold.

## 24. `src/lib/csv/parse.ts`

```ts
export function parseCsv(input: string): { headers: string[]; rows: string[][] };
export function serializeCsv(headers: string[], rows: (string | undefined)[][]): string;
```

RFC 4180: quoted fields, embedded commas, embedded quotes (`""`), CRLF, and a
leading BOM. Must also defuse spreadsheet formula injection on export by
prefixing `=`, `+`, `-`, `@` with `'`.

## 25. `src/lib/csv/import.ts`

```ts
export interface ImportRowError { row: number; email?: string; reason: string }
export interface ImportResult {
  total: number; imported: number; updated: number; skippedSuppressed: number;
  errors: ImportRowError[]; attestationId?: ObjectId;
}
export async function importSubscribers(input: {
  listId: ObjectId; csv: string; mapping: { email: string; attributes?: Record<string, string> };
  markConfirmed: boolean; attestation?: { text: string; by: string }; filename?: string; now?: Date;
}): Promise<ImportResult | { error: string }>;
```

Per §4.3: malformed rows are reported, not silently dropped; every address is
checked against `suppressions` and skipped on a match (a suppressed address must
never be resurrected); idempotent on `{listId, email}` — re-import updates
attributes and never duplicates or resets consent state; `markConfirmed` is only
honoured when an attestation is supplied, and the attestation text is logged
verbatim.

## 26. `src/lib/csv/export.ts`

```ts
export async function exportSubscribersCsv(input: { listId: ObjectId; query?: SegmentQuery; status?: SubscriberStatus }): Promise<string>;
export async function exportSuppressionsCsv(): Promise<string>;
```

Includes status and the consent evidence fields (§4.4, §5.3).

## 27. `src/lib/auth.ts`

```ts
export interface AdminSession { user: string; issuedAt: number }
export function createSessionToken(user: string, now?: Date): string;   // signed, 7d
export function verifySessionToken(token: string | undefined, now?: Date): AdminSession | null;
export function verifyAdminPassword(password: string): boolean;         // constant-time
export const ADMIN_COOKIE_NAME = 'sm_admin';
export async function requireAdmin(request: Request): Promise<AdminSession | null>;
export function verifyCronRequest(request: Request): boolean;           // Bearer CRON_SECRET
```

`verifyCronRequest` compares in constant time and returns `false` when
`CRON_SECRET` is unset — fail closed (§12).

## 28. `src/lib/ses/aws.ts`

```ts
export function createAwsSesAdapter(client?: SESv2Client): SesAdapter;
```

Uses `SendBulkEmailCommand` with an **inline** `DefaultContent.Template`
(`TemplateContent` + `TemplateData`), per-entry
`ReplacementEmailContent.ReplacementTemplate.ReplacementTemplateData` and
per-entry `ReplacementHeaders` for `List-Unsubscribe` /
`List-Unsubscribe-Post`. No stored SES templates. Maps
`BulkEmailEntryResult.Status === 'SUCCESS'` to success and everything else to a
per-destination failure. Translates throttling into `SesThrottlingError`.
`isIdentityVerified` uses `GetEmailIdentityCommand`.

## 28a. `src/lib/lists.ts`

```ts
export class ListValidationError extends Error {}
export interface ListInput {
  name: string; sendingDomain: string; fromName: string; fromEmail: string;
  replyTo: string; physicalAddress: string; sesConfigurationSet: string;
  active?: boolean; welcomeUrl?: string;
}
export function validateListInput(input: ListInput): Omit<ListDoc, '_id' | 'createdAt'>;
export function serializeList(list: ListDoc): Record<string, unknown>;
export async function listLists(): Promise<ListDoc[]>;
export async function listSummaries(): Promise<ListSummary[]>;   // list + subscriber/campaign counts
export async function getList(id: ObjectId): Promise<ListDoc | null>;
export async function createList(input: ListInput, now?: Date): Promise<ListDoc>;
export async function updateList(id: ObjectId, patch: Partial<ListInput>): Promise<ListDoc | null>;
export async function deleteList(id: ObjectId): Promise<DeleteListResult>;
```

`updateList` merges the patch onto the stored document and validates the
*result*, so `fromEmail` and `sendingDomain` cannot be desynchronised by editing
one of them. `deleteList` refuses a list that any subscriber or campaign
references and returns `{ deleted: false, reason: 'in_use', … }`; only an
unreferenced list is removed, together with its seed addresses and import
attestations.

## 29. API routes — `src/app/api/**`

Every route is a Next.js App Router route handler exporting `GET`/`POST`.
Handlers are thin: parse, delegate to a lib function, shape the response.

| Route | Method | Notes |
|---|---|---|
| `/api/subscribe` | POST | §5.1. Identical response for every address state. |
| `/api/confirm` | GET | §5.2. Friendly HTML on failure, redirect on success. |
| `/api/unsubscribe` | POST | §9.3 one-click. No confirmation, no page, fast 200. |
| `/api/unsubscribe` | GET | §9.3 human page with resubscribe. |
| `/api/webhooks/ses` | POST | §8. Signature verified before any work. |
| `/api/cron/send` | GET | §7.2. `maxDuration = 60`. Bearer auth. |
| `/api/cron/purge` | GET | Daily purge of expired `pending` (§4.1). |
| `/api/t/o/[token]` | GET | 1×1 GIF open pixel (§13). |
| `/api/t/c/[token]` | GET | Signed click redirect (§13, §12). |
| `/api/admin/lists` | GET, POST | §3.1 list configuration. POST returns 201. |
| `/api/admin/lists/[id]` | GET, PATCH, DELETE | PATCH is partial. DELETE returns 409 for a list in use. |
| `/api/admin/**` | * | Session-authenticated; all campaign/subscriber writes. |

All admin routes must return 401 without a valid session. The subscribe,
confirm, unsubscribe, webhook and tracking routes are public by design.

## 30. UI — `src/app/(admin)/**`, `src/components/**`

Tiptap editor (`@tiptap/react` + `StarterKit`, `Link`, `Image`, `Placeholder`),
restricted to the §6.1 node set. Autosave on debounce with a visible saved-state
indicator and version history. Side-by-side preview with desktop/mobile toggle,
a real-subscriber merge-data selector, and a plain-text tab. Send confirmation
modal restating recipient count, list name, from, reply-to and subject, with
typed confirmation above `config.typedConfirmationThreshold()`.
