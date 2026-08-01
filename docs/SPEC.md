# Newsletter Platform — Specification

**Status:** Draft v1
**Owner:** TBD
**Last updated:** 2026-07-31

---

## 1. Purpose and scope

A self-hosted newsletter application serving two independent domains with separate subscriber lists (~14,000 and ~19,000 at time of writing). It replaces a Squarespace Email Campaigns subscription on one domain and an ad-hoc SES integration on the other.

The application must do three things excellently:

1. **List management** — subscribers, segments, suppression, and import/export
2. **Double opt-in** — legally defensible, low-friction consent capture
3. **Writing UI** — a genuinely pleasant place to compose an email

And one thing invisibly but flawlessly:

4. **The send pipeline** — never double-send, never lose a recipient, never damage sender reputation

Everything else is secondary.

### 1.1 Non-goals (v1)

Explicitly out of scope. Listed so they don't creep in:

- Drip sequences / automation workflows
- A/B testing
- Landing page builder
- Transactional email for other applications
- Inbound email parsing (replies are handled by an external mailbox, see §11)
- Multi-tenant / multi-account support
- Paid subscription or paywall features

### 1.2 Design principles

- **Fail closed.** When in doubt, don't send. An email not sent is recoverable; an email wrongly sent is not.
- **The suppression list is sacred.** Every send path checks it. No exceptions, no bypass flag.
- **Consent is a record, not a state.** Store the evidence, not just the boolean.
- **Slow is fine.** A 30-minute send is a feature, not a compromise.

---

## 2. Architecture

| Layer | Technology | Rationale |
|---|---|---|
| Web app + API | Next.js on Vercel Pro | Already paid for; short-lived requests fit the plan's unused headroom |
| Scheduler | Vercel Cron, `* * * * *` | Per-minute cadence available on Pro; invoked within the specified minute |
| Database | MongoDB Atlas | Already provisioned |
| Delivery | AWS SES (v2 API over HTTPS) | $0.10/1,000, existing account and domain reputation |
| Bounce/complaint feedback | SES → SNS → HTTPS webhook | Accurate, unlike POP3 bounce parsing |
| Reply handling | Cloudflare Email Routing → external mailbox | Out of application scope (§11) |
| DNS | Cloudflare | Existing |

### 2.1 Why cron rather than a queue service

Vercel Cron on Pro fires within the specified minute. Vercel does not retry failed cron invocations and does not prevent overlapping runs, but the lease-based batch claiming described in §7 makes both harmless: a failed run leaves batches leased, and the next tick reclaims them after lease expiry. Cron plus lease expiry *is* the retry queue. This removes the need for a separate queue service, worker platform, or long-running process.

### 2.2 Constraints inherited from the platform

- Cron invocations arrive as `GET` requests. Routes must accept `GET`.
- Cron schedules register at deploy time. An Instant Rollback does **not** update active cron jobs.
- Cron expressions are UTC only.
- `CRON_SECRET` is auto-provisioned by Vercel and sent as a bearer token. It **must** be verified (§12).
- Function billing is on active CPU, not I/O wait. A run that spends 45 seconds waiting on SES costs almost nothing.

---

## 3. Data model

MongoDB collections. Field lists are indicative, not exhaustive.

### 3.1 `lists`

One document per newsletter (i.e. per domain).

```
_id
name                    "Domain A Weekly"
sendingDomain           "news.domain-a.com"
fromName                "Domain A"
fromEmail               "hello@news.domain-a.com"
replyTo                 "hello@domain-a.com"
physicalAddress         string   // legally required in every email
sesConfigurationSet     string
active                  boolean
```

### 3.2 `subscribers`

```
_id
listId
email                   // normalized: lowercased, trimmed
emailDomain             // denormalized for domain-level analysis
status                  pending | confirmed | unsubscribed | bounced | complained
attributes              { firstName, ... }   // merge fields
source                  "web_form" | "import" | "api"

createdAt
confirmedAt
confirmIp               // consent evidence
confirmUserAgent        // consent evidence
unsubscribedAt
unsubscribeSource       one_click | preferences_page | complaint | admin

confirmTokenHash        // HMAC-SHA256 of the token; never store the raw token
confirmTokenExpiresAt
confirmEmailSentAt      // rate limiting
```

**Indexes**

- `{ listId: 1, email: 1 }` — **unique**
- `{ listId: 1, status: 1 }`
- `{ confirmTokenHash: 1 }` — sparse

### 3.3 `suppressions`

Global across both lists and both domains. A hard bounce or complaint on one domain suppresses the address everywhere, because SES reputation thresholds are account-level.

```
_id
email                   // normalized
reason                  hard_bounce | complaint | manual | import
createdAt
sourceCampaignId
detail                  // SES diagnostic code, free text
```

**Indexes**

- `{ email: 1 }` — **unique**

### 3.4 `campaigns`

```
_id
listId
subject
preheader
bodySource              // markdown or editor JSON — source of truth
bodyHtml                // rendered at send-freeze time, immutable thereafter
bodyText                // plain-text alternative, auto-generated
status                  draft | scheduled | sending | paused | sent | failed
segmentQuery            // see §4.2
scheduledFor
frozenAt                // when body was rendered and recipients materialized
startedAt
completedAt
trackOpens              boolean
trackClicks             boolean
counts                  { recipients, sent, failed, bounced, complained, unsubscribed }
```

### 3.5 `campaign_batches`

The unit of work. Created once, at send time.

```
_id
campaignId
subscriberIds           [ObjectId]  // max 50, matching SES SendBulkEmail limit
status                  pending | claimed | sent | failed
leaseUntil              Date
claimedBy               // invocation id, for debugging
attempts                number
lastError
```

**Indexes**

- `{ campaignId: 1, status: 1 }`
- `{ status: 1, leaseUntil: 1 }` — drives the claim query

### 3.6 `sent_log`

The hard guarantee against double-sends.

```
_id
campaignId
subscriberId
sesMessageId
sentAt
```

**Indexes**

- `{ campaignId: 1, subscriberId: 1 }` — **unique**

This index is not an optimization. It is a database-level invariant that survives bugs in the claim logic. A duplicate-key error on insert means "already sent" and is handled by skipping silently, not by erroring.

### 3.7 `events` (optional, metrics tier)

```
_id
campaignId
subscriberId
type                    delivered | open | click | bounce | complaint
ts
url                     // clicks only
```

---

## 4. Flagship 1 — List management

### 4.1 Subscriber lifecycle

```
   (form submit)          (confirm link)
        │                       │
        ▼                       ▼
    [pending] ──────────► [confirmed] ──────► [unsubscribed]
        │                       │
        │ (7d expiry)           ├──────────► [bounced]
        ▼                       │
    (purged)                    └──────────► [complained]
```

- Only `confirmed` subscribers are ever sent a campaign.
- `pending` records that expire unconfirmed after 7 days are purged by a daily job.
- `unsubscribed`, `bounced`, and `complained` records are retained as tombstones, never deleted. They are the proof that the address was correctly excluded.

### 4.2 Segmentation

Segments are stored as a saved query against the `subscribers` collection, evaluated at send-freeze time. v1 supports:

- Status (always implicitly `confirmed`)
- Signup date range
- Signup source
- Arbitrary attribute equality / existence
- Engagement, if metrics are enabled (opened in last N campaigns)

The UI presents these as a small set of dropdowns, not a query builder. A live count ("this will send to 12,481 people") updates as filters change, and the count is re-derived at freeze time — never trusted from the UI.

### 4.3 Import

- CSV upload with column mapping.
- Import validates and normalizes each address; malformed rows are reported back, not silently dropped.
- Imported subscribers land as `confirmed` **only** when the operator affirmatively attests the list has prior opt-in consent (a checkbox with explicit wording, logged). Otherwise they land as `pending` and receive a confirmation email.
- Import checks every address against `suppressions` and skips matches. A suppressed address must never be resurrected by a re-import. This is the single most common way people destroy their sender reputation.
- Import is idempotent on `{listId, email}` — re-importing updates attributes, never duplicates or resets consent state.

### 4.4 Export

- Full CSV export of any list or segment, including status and consent evidence fields.
- Suppression list exports separately.
- Export exists partly so this application is never a lock-in trap. It should work on day one.

### 4.5 Admin views

- Subscriber list with search by email, filter by status, sortable by signup date.
- Individual subscriber detail: full status history, consent evidence, campaigns sent, events received.
- Suppression list view with reason and origin, and a manual add.

---

## 5. Flagship 2 — Double opt-in

### 5.1 Signup

`POST /api/subscribe`

1. Rate limit by IP and by email address (see §12).
2. Reject if the honeypot field is populated. Optionally verify a Cloudflare Turnstile token.
3. Normalize and validate the address. Syntax check plus MX lookup on the domain; reject addresses whose domain has no MX record.
4. Check `suppressions`. If suppressed, return the same success response as any other submission and do nothing. Never disclose suppression state.
5. Upsert the subscriber as `pending`.
6. Generate a 32-byte random token. Store **only** its HMAC-SHA256 hash and a 7-day expiry.
7. Send the confirmation email immediately via SES — this is a transactional send and **does not** go through the campaign cron.
8. Return a generic success response.

**Response must be identical** whether the address is new, already pending, already confirmed, or suppressed. Any variation is an email enumeration oracle.

Resend of a confirmation email is rate-limited to once per hour per address.

### 5.2 Confirmation

`GET /api/confirm?token=…`

1. Hash the supplied token and look up by hash. Compare in constant time.
2. Reject if expired, already used, or unknown — with a friendly page offering to start over, not a raw error.
3. Set `status = confirmed`, `confirmedAt = now`, and record `confirmIp` and `confirmUserAgent`.
4. Clear `confirmTokenHash`.
5. Redirect to a configurable welcome page.

### 5.3 Consent evidence

`confirmedAt`, `confirmIp`, and `confirmUserAgent` together constitute the proof of opt-in. They are:

- Never modified after being written
- Never deleted, including after unsubscribe
- Included in subscriber export

This record is what you produce if a complaint is ever escalated. Treat it as append-only.

### 5.4 Confirmation email content

Plain, short, and obviously transactional. One clear call to action. No marketing content, no images, no tracking. It should look nothing like a newsletter, because its deliverability requirements are different and its job is singular.

---

## 6. Flagship 3 — Writing UI

The daily-use surface. If this is unpleasant, the project has failed regardless of how correct the backend is.

### 6.1 Composition

- **Source of truth is Markdown** (or structured editor JSON), not HTML. HTML is a render target.
- Editor supports headings, bold/italic, links, lists, blockquotes, images, and horizontal rules. That is the complete list. Resist additions.
- Autosave on a debounce, with a visible saved-state indicator and a recoverable version history of at least the last 20 saves.
- Full-width, distraction-light writing surface. This is a writing tool.

### 6.2 Rendering

- HTML generated via **MJML or React Email**. Do not hand-author table-based email HTML — Outlook renders with the Word engine and this is a solved problem not worth re-solving.
- CSS inlined at render time.
- A plain-text alternative is auto-generated from the Markdown source and sent as `multipart/alternative`. This is not optional; HTML-only sends are a deliverability penalty.
- Rendered HTML is **frozen** onto the campaign document at send time and never re-rendered. A template change mid-send must not produce two different emails.

### 6.3 Preview

- Side-by-side live preview.
- Desktop / mobile width toggle.
- Preview renders with a real subscriber's merge data, selectable from a dropdown, so fallbacks get exercised.
- Plain-text preview available as a tab.

### 6.4 Merge fields

Syntax: `{{ first_name | default: "there" }}`

- Every merge field **must** have a fallback. The pre-send gate (§6.6) rejects any field without one.
- Available fields are listed in the editor UI; no free-typing of field names.

### 6.5 Test sends

- Send to an arbitrary address or to a saved seed list.
- Test sends are tagged and excluded from all campaign counts and metrics.
- A test send must exercise the real render path — same code, same merge, same headers — or it is not a test.

### 6.6 Pre-send validation gate

A campaign cannot transition to `sending` unless every check passes. Hard block, no override:

| Check | Rationale |
|---|---|
| Subject line non-empty | — |
| Body non-empty and not image-only | Image-only bodies are a spam signal |
| Physical postal address present | Legally required |
| Unsubscribe placeholder present in body | Legally required |
| All merge fields have fallbacks | Prevents "Hi ," |
| All links resolve and are absolute | Prevents broken relative URLs |
| From-domain verified in SES | Prevents a wasted send |
| Recipient count > 0 | — |

### 6.7 Send confirmation

A modal that restates, in plain language: the recipient count, the list name, the from address, the reply-to address, and the subject line. Typed confirmation for sends above a configurable threshold. This is the last human checkpoint before 19,000 people receive something.

---

## 7. The send pipeline

### 7.1 Freeze

When a campaign is sent (or reaches its `scheduledFor` time), in one operation:

1. Re-evaluate the segment query to get the recipient set.
2. Exclude: anyone not `confirmed`, anyone in `suppressions`, anyone already in `sent_log` for this campaign.
3. Render and store `bodyHtml` and `bodyText`.
4. Materialize `campaign_batches` — chunks of up to 50 subscriber IDs, matching the SES `SendBulkEmail` destination limit.
5. Set `campaign.status = sending`, `frozenAt = now`, `counts.recipients = n`.

After freeze, the recipient set and body are immutable.

### 7.2 The cron route

`GET /api/cron/send` — `maxDuration: 60`

```
1. Verify Authorization: Bearer ${CRON_SECRET}. Reject otherwise.
2. deadline = now + 45s
3. while (now < deadline && batchesThisRun < MAX_BATCHES_PER_RUN):
     batch = claimBatch()
     if (!batch) break
     processBatch(batch)
4. reconcileCompletedCampaigns()
5. return 200 with a small summary
```

The 45-second budget leaves headroom before the next tick. Overlapping invocations are safe — they claim disjoint batches — but excessive overlap risks exceeding the SES rate quota, so `MAX_BATCHES_PER_RUN` is sized to the quota rather than to the clock.

### 7.3 Claiming a batch

A single atomic `findOneAndUpdate`. MongoDB guarantees atomicity on single-document updates, which is what makes this safe without transactions:

```js
db.campaign_batches.findOneAndUpdate(
  {
    campaignId: { $in: activeSendingCampaignIds },
    $or: [
      { status: 'pending' },
      { status: 'claimed', leaseUntil: { $lt: now } }   // reclaim crashed work
    ],
    attempts: { $lt: MAX_ATTEMPTS }
  },
  {
    $set: { status: 'claimed', leaseUntil: now + 120_000, claimedBy: invocationId },
    $inc: { attempts: 1 }
  },
  { returnDocument: 'after' }
)
```

**The lease is the whole design.** Without `leaseUntil`, a function that dies mid-batch leaves 50 people permanently unsent with no error anywhere. With it, the next tick picks the work back up. Lease duration must comfortably exceed the worst-case batch processing time.

`activeSendingCampaignIds` excludes paused campaigns, which is what makes the pause button in §7.7 effective within one minute.

### 7.4 Processing a batch

1. Load the subscriber documents.
2. **Re-check suppressions and status.** The freeze happened up to an hour ago; someone may have unsubscribed since. This second check is not redundant, it is the point.
3. Build per-recipient replacement data, including the signed unsubscribe token.
4. Call SES `SendBulkEmail` with up to 50 destinations.
5. For each per-destination result:
   - Success → insert into `sent_log`. A duplicate-key error means already sent; swallow it and continue.
   - Failure → record and count; do not fail the whole batch for one bad address.
6. Mark the batch `sent`, or `failed` if `attempts >= MAX_ATTEMPTS`.

### 7.5 Rate limiting

SES enforces an account-level send rate (default 14/sec; request an increase before first production send). The pipeline must:

- Pace sends within a batch to stay under the configured rate.
- Catch SES `Throttling` / `TooManyRequestsException`, release the batch by setting `leaseUntil = now`, and exit the run early. Do not hammer.
- Expose the configured rate as an environment variable so it can be lowered instantly if reputation degrades.

### 7.6 Completion

A campaign is `sent` when it has zero batches in `pending` or `claimed`. The reconcile step at the end of each run checks this and sets `completedAt`. Batches in `failed` are surfaced in the UI with their `lastError` for manual review.

### 7.7 Pause and abort

A single prominent control. Setting `campaign.status = paused` removes it from the claim query, so sending stops within one minute with no in-flight work lost. Resuming sets it back to `sending`; already-sent batches are untouched because of `sent_log`.

This is the reason a 30-minute send window is desirable. A bad subject line caught at minute three costs 1,800 sends instead of 19,000.

### 7.8 Automatic circuit breaker

If, during an active send, the complaint rate for that campaign exceeds a configured threshold (default 0.1% of delivered), auto-pause the campaign and alert. This requires SNS events flowing during the send, which §8 provides. It is the difference between a bad campaign and a suspended SES account.

---

## 8. Bounce and complaint handling

`POST /api/webhooks/ses`

### 8.1 Security

- **Verify the SNS message signature.** Fetch the signing certificate, confirm the `SigningCertURL` host is under `amazonaws.com`, and verify the signature. A shared-secret URL is not sufficient; the endpoint is otherwise trivially spoofable, and spoofing it means an attacker can suppress your entire list.
- Handle `SubscriptionConfirmation` by fetching the `SubscribeURL`.
- SNS delivers at least once. All handlers must be idempotent.

### 8.2 Event handling

| Event | Action |
|---|---|
| Bounce, `Permanent` | Insert into `suppressions`; set subscriber `status = bounced` |
| Bounce, `Transient` | Record; suppress only after repeated transient failures across distinct campaigns |
| Complaint | Insert into `suppressions`; set `status = complained`. Always permanent, no threshold |
| Delivery | Optional; increment counters if metrics enabled |
| Reject | Alert — indicates a configuration problem, not a recipient problem |

### 8.3 Reputation monitoring

SES account-level thresholds, worth stating explicitly because they are the failure mode that matters:

- Bounce rate above **5%** → account under review; above **10%** → sending paused
- Complaint rate above **0.1%** → under review; above **0.5%** → sending paused

The dashboard surfaces rolling bounce and complaint rates prominently, not buried in a metrics tab.

---

## 9. Unsubscribe

Legally required, and the most availability-critical endpoint in the system. If it fails during a send, complaints accrue against the thresholds in §8.3.

### 9.1 Headers

Every campaign email includes:

```
List-Unsubscribe: <mailto:unsubscribe@…>, <https://…/api/unsubscribe?t=TOKEN>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

Both headers are mandatory under the Google and Yahoo bulk sender requirements at this volume. The `POST` endpoint must unsubscribe immediately with **no confirmation step and no landing page**, and return `200` fast.

### 9.2 Tokens

`HMAC-SHA256(subscriberId + campaignId, UNSUBSCRIBE_SECRET)`, base64url encoded. Not enumerable, no expiry (an old email must still work years later).

### 9.3 Endpoints

- `POST /api/unsubscribe` — one-click. Unsubscribe, return 200. Nothing else.
- `GET /api/unsubscribe` — human-facing page. Confirms the action, offers a preferences option, and allows resubscribe.

Unsubscribes must be processed within two days per the bulk sender rules. Process synchronously; there is no reason to queue this.

Unsubscribing sets `status = unsubscribed` on the subscriber but does **not** add to global `suppressions` — suppression is for deliverability failures, unsubscribe is a per-list preference. Both exclude from sending.

---

## 10. Deliverability configuration

Not application code, but the application does not work without it.

### 10.1 Per sending domain

- Dedicated sending subdomain: `news.domain-a.com`, `news.domain-b.com`. Bulk reputation stays isolated from human mail on the root domain.
- SES verified domain identity with Easy DKIM, 2048-bit.
- Custom MAIL FROM domain (`bounce.news.domain-a.com`) with the required SPF and MX records, for DMARC alignment.
- SES configuration set per domain with an SNS event destination.

### 10.2 DMARC

Publish on the root domain at `p=none` with an `rua` address. Monitor for at least two weeks, confirm alignment, then move to `p=quarantine`.

### 10.3 IP strategy

Shared IPs. A dedicated IP costs $24.95/month and requires sustained volume to stay warm; at ~33k/month across both lists it would actively hurt deliverability.

### 10.4 Warmup

On migration, do not send 19,000 on day one from a new subdomain. Ramp over 2–4 weeks, most-engaged segments first. The segment UI (§4.2) must support this.

---

## 11. Reply handling (out of application scope)

Campaigns set `Reply-To` to a real address on the root domain. That address is handled outside this application:

- Cloudflare Email Routing forwards `hello@domain-a.com` to an external mailbox
- Outbound replies are sent via SES SMTP credentials configured as a "send mail as" identity, so replies leave as `hello@domain-a.com`
- If reply volume or team coordination justifies it later, this layer is replaced with a hosted mailbox and shared inbox without any change to this application

The application never receives, parses, or stores inbound mail.

---

## 12. Security

| Concern | Control |
|---|---|
| Cron endpoint | Verify `Authorization: Bearer ${CRON_SECRET}` before any work |
| SNS webhook | Full SNS signature verification (§8.1) |
| Admin UI | Authenticated; no public write paths to campaigns or subscribers |
| Signup abuse | Rate limit per IP and per email; honeypot field; optional Turnstile |
| Email enumeration | Identical responses from `/api/subscribe` regardless of address state |
| Token storage | Confirmation tokens stored as HMAC hashes only; constant-time comparison |
| Click tracking | Redirect targets must be signed and validated against an allowlist — an unsigned redirector is an open redirect and will be abused |
| PII in logs | Email addresses never written to application logs |
| Secrets | All in Vercel environment variables; separate values per environment |

---

## 13. Metrics (optional tier)

Explicitly lower priority. Build only after everything above is solid.

- **Opens** — 1×1 pixel at `/api/t/o/:token`. Note in the UI that Apple Mail Privacy Protection inflates open rates substantially; do not present open rate as a precise figure.
- **Clicks** — link rewriting through `/api/t/c/:token`. Signed targets only (§12).
- Both toggleable per campaign; some sends should go untracked.
- Aggregate counts denormalized onto the campaign document; individual events in `events` for drill-down.
- Campaign view shows: delivered, bounced, complained, unsubscribed, opens, clicks, and top clicked links.

---

## 14. Migration from Squarespace

Order matters here.

1. Export subscribers **and the suppression list** (unsubscribes, bounces) from Squarespace. The suppression list is the part people forget, and importing without it re-mails people who opted out — a CAN-SPAM problem as well as a deliverability one.
2. Import suppressions **first**, before any subscribers.
3. Import subscribers as `confirmed` under the prior-consent attestation (§4.3). Do not re-confirm 33,000 existing subscribers; a re-confirmation campaign typically loses the majority of a list.
4. Configure DNS, SES identities, DKIM, MAIL FROM, and DMARC per §10.
5. Run one campaign in parallel — send from the new system to a 500-person engaged segment, keep Squarespace for the remainder — and compare bounce and complaint rates.
6. Warm up per §10.4.
7. Cut over. Keep the Squarespace subscription for one billing cycle as a rollback path.

---

## 15. Failure modes and runbook

| Symptom | Likely cause | Response |
|---|---|---|
| Send stalls, batches stuck `claimed` | Function crashing mid-batch | Check logs; lease expiry auto-recovers within 2 min. Persistent → inspect `lastError` |
| Batches at `attempts = MAX`, `failed` | Malformed content or SES rejection | Inspect `lastError`; fix and re-materialize failed batches |
| Bounce rate climbing | Stale list or bad import | Pause immediately; audit recent imports against suppressions |
| Complaint rate above 0.1% | Content or consent problem | Circuit breaker should have paused. Investigate before resuming |
| SES `Throttling` errors | Concurrency exceeding quota | Lower `MAX_BATCHES_PER_RUN`; request quota increase |
| Cron not firing | Schedule not registered after rollback | Redeploy; cron registers at deploy time |
| Duplicate sends reported | Should be impossible | Verify the `sent_log` unique index exists. This is the invariant |
| Confirmation emails not arriving | Transactional path or SES identity issue | These do not use the cron path; check SES send logs directly |

---

## 16. Build phases

**Phase 1 — Foundation**
Data model and indexes. SES identities, DKIM, MAIL FROM, DMARC. Signup endpoint, double opt-in flow, unsubscribe endpoints and headers. SNS webhook with signature verification and suppression writes.

*Exit criteria: a subscriber can join, confirm, and unsubscribe; a bounce suppresses correctly.*

**Phase 2 — Send pipeline**
Freeze, batch materialization, cron route, lease claiming, `sent_log`, rate limiting, pause, circuit breaker.

*Exit criteria: a 5,000-recipient send to seed addresses completes with correct counts, survives a forced mid-send crash, and cannot double-send.*

**Phase 3 — Writing UI**
Editor, render pipeline, preview, merge fields, test sends, pre-send gate, send confirmation.

*Exit criteria: a full campaign composed and sent without touching the database directly.*

**Phase 4 — List management**
Import/export, segmentation, admin views, suppression management.

*Exit criteria: Squarespace migration executable end to end.*

**Phase 5 — Metrics**
Open and click tracking, campaign reporting.

---

## 17. Open questions

- Retention policy for `events` — TTL index, or archive?
- Should the two lists share one deployment with a list selector, or two deployments sharing a codebase? (Leaning: one deployment, `listId` throughout — the schema already assumes this.)
- Preference centre scope: topic-level opt-outs, or unsubscribe only?
- Alerting channel for circuit breaker and failed batches — email, Slack, or dashboard only?
