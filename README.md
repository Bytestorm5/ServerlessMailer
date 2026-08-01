# ServerlessMailer

A self-hosted newsletter application for two independent domains with separate
subscriber lists. Next.js on Vercel, MongoDB Atlas, AWS SES — no queue service,
no worker platform, no long-running process.

It implements the *Newsletter Platform* specification (draft v1) in full.
Section references throughout the code and this document (`§7.3`, `§8.1`, …)
point back at it.

The application does three things well — list management, double opt-in, and
the writing UI — and one thing invisibly: never double-send, never lose a
recipient, never damage sender reputation.

---

## How it works

**The send pipeline is a cron job and a lease.** A campaign freezes its
recipient set and rendered body into `campaign_batches` of 50, and
`GET /api/cron/send` runs every minute, claiming batches with a single atomic
`findOneAndUpdate` that sets `leaseUntil = now + 120s`. A function that dies
mid-batch leaves the batch leased; the next tick reclaims it after the lease
expires. Cron plus lease expiry *is* the retry queue. Overlapping invocations
are safe because they claim disjoint batches.

**Double-sends are prevented by the database, not by the code.** `sent_log` has
a unique index on `{campaignId, subscriberId}`. A duplicate-key error on insert
means "already sent" and is swallowed. That index survives bugs in the claim
logic, which is the point — the indexes are asserted on first database access,
so a fresh deployment cannot run without it.

**The suppression list is global and has no bypass.** A hard bounce or
complaint on one domain suppresses the address everywhere, because SES
reputation thresholds are account-level. Every send path checks it twice: once
at freeze, and again at send time, because someone may have unsubscribed in
between.

**Consent is a record, not a boolean.** `confirmedAt`, `confirmIp` and
`confirmUserAgent` are written once, never modified, never deleted — not even
after unsubscribe — and are included in every export.

---

## Setup

### 1. Install and configure

```bash
npm install
cp .env.example .env.local
```

Generate each secret with `openssl rand -hex 32` and fill in `.env.local`.
`MAILER_DRIVER` defaults to `console`, which prints messages to stdout instead
of sending them — leave it there until you are deliberately ready to send.

### 2. Create the indexes and the first admin

```bash
npm run indexes
npm run create-admin you@example.com 'a-long-password'
```

`ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD` also create the first
admin automatically when the `admins` collection is empty. Remove them once
you have logged in.

### 3. Run it

```bash
npm run dev          # http://localhost:3000
npm run seed         # optional: one list and four subscribers
```

### 4. Deploy

Deploy to Vercel and set the same environment variables there. `CRON_SECRET` is
auto-provisioned by Vercel and sent as a bearer token; the cron routes verify it
before doing any work.

The cron schedules in `vercel.json` register **at deploy time**. An Instant
Rollback does not update active cron jobs — if cron stops firing after a
rollback, redeploy.

---

## AWS configuration

The application does not work without this. Per sending domain:

1. **Dedicated subdomain** — `news.domain-a.com`. Bulk reputation stays
   isolated from human mail on the root domain.
2. **SES verified domain identity** with Easy DKIM, 2048-bit.
3. **Custom MAIL FROM domain** (`bounce.news.domain-a.com`) with the required
   SPF and MX records, for DMARC alignment.
4. **SES configuration set** per domain, with an SNS event destination
   publishing `Bounce`, `Complaint`, `Delivery` and `Reject` to an HTTPS
   subscription pointed at `https://your-app/api/webhooks/ses`.
5. **DMARC** on the root domain at `p=none` with an `rua` address. Monitor for
   two weeks, confirm alignment, then move to `p=quarantine`.
6. **Request a sending-rate increase** before the first production send, and
   set `SES_MAX_SEND_RATE` to match. Shared IPs; a dedicated IP at ~33k/month
   would actively hurt deliverability.

The webhook verifies the full SNS signature — it fetches the signing
certificate, checks the host is a genuine `sns.<region>.amazonaws.com` endpoint,
and verifies the signature against it. A shared-secret URL would not be enough:
anyone who can post accepted messages to that endpoint can suppress your entire
list.

---

## Migration from an existing provider

Order matters.

1. Export subscribers **and the suppression list** (unsubscribes, bounces) from
   the old provider.
2. Import suppressions **first**, at **Suppressions → Add addresses**, before
   any subscribers. Importing without them re-mails people who opted out.
3. Import subscribers with the prior-consent attestation ticked, so they land
   as `confirmed`. Do not re-confirm an existing list; a re-confirmation
   campaign typically loses most of it.
4. Configure DNS, SES identities, DKIM, MAIL FROM and DMARC as above.
5. Send one campaign in parallel to a 500-person engaged segment and compare
   bounce and complaint rates.
6. Warm up over 2–4 weeks, most-engaged segments first — the segment builder's
   "opened one of the last N campaigns" filter exists for this.
7. Cut over, keeping the old subscription for one billing cycle as a rollback.

---

## Operating it

The dashboard shows rolling bounce and complaint rates against the SES
thresholds that matter: bounce above **5%** puts the account under review and
**10%** pauses it; complaints above **0.1%** put it under review and **0.5%**
pauses it.

**Pause** removes a campaign from the claim query, so sending stops within one
minute with no in-flight work lost. Resuming is safe — `sent_log` makes an
already-sent batch a no-op. A bad subject line caught at minute three costs
1,800 sends instead of 19,000.

The **circuit breaker** auto-pauses a campaign whose complaint or bounce rate
crosses `COMPLAINT_RATE_THRESHOLD` / `BOUNCE_RATE_THRESHOLD` mid-send, once
enough messages have been delivered for the rate to mean anything.

### Runbook

| Symptom | Likely cause | Response |
|---|---|---|
| Send stalls, batches stuck `claimed` | Function crashing mid-batch | Lease expiry auto-recovers within 2 minutes. Persistent → check `lastError` on the campaign report |
| Batches `failed` at max attempts | Malformed content or SES rejection | Campaign report shows `lastError`; fix, then **Re-queue failed batches** |
| Bounce rate climbing | Stale list or a bad import | Pause immediately; audit recent imports against suppressions |
| Complaint rate above 0.1% | Content or consent problem | The circuit breaker should have paused it. Investigate before resuming |
| SES `Throttling` errors | Concurrency exceeding quota | Lower `MAX_BATCHES_PER_RUN`; request a quota increase |
| Cron not firing | Schedule not registered after a rollback | Redeploy; cron registers at deploy time |
| Duplicate sends reported | Should be impossible | **System** page → confirm the `sent_log` unique index. This is the invariant |
| Confirmation emails not arriving | Transactional path or SES identity | These bypass the cron entirely; check SES send logs directly |

---

## Development

```bash
npm run typecheck    # tsc --noEmit
npm test             # 120 unit and integration tests against a real MongoDB
npm run build
npm run smoke        # end-to-end HTTP run against `next start` (needs a build)
```

The test suite starts a real `mongodb-memory-server` rather than mocking the
database, because the properties under test — atomic batch claiming, the unique
index on `sent_log` — are database behaviours. `tests/pipeline.test.ts` covers
the exit criteria that matter: a send completes with correct counts, survives a
forced mid-send crash, and cannot double-send.

`npm run smoke` boots the built application and drives it over HTTP: signup,
double opt-in, a campaign sent through the cron route, one-click unsubscribe,
tracking, exports, and the authentication boundaries.

### Layout

```
src/lib/            The system. Everything below is a thin layer over this.
  pipeline.ts       Claim, process, reconcile, circuit breaker (§7)
  campaigns.ts      Freeze, pause, resume, abort (§7.1, §7.7)
  render/           Tiptap → MJML → HTML, and → plain text (§6.2)
  validation.ts     The pre-send gate (§6.6)
  sns-verify.ts     SNS signature verification (§8.1)
  suppressions.ts   Global suppression list (§3.3)
src/app/api/        Route handlers
src/app/admin/      Admin UI
src/components/     Editor, preview, segment builder, send dialog
```

---

## Notes on the implementation

A few decisions worth knowing about, where the spec left room or where the
obvious reading has a sharp edge:

- **Merge fields compile to per-occurrence variables.** `{{ first_name |
  default: "there" }}` becomes `{{m0}}` in the frozen body, with the fallback
  resolved per recipient before the data reaches SES. Two uses of one field
  with *different* fallbacks get different variables, so neither is silently
  lost. Values are stripped of `<` and `>` at substitution time rather than
  HTML-escaped, because one data object feeds both the HTML and the text part.

- **MX lookups fail open, everything else fails closed.** A definitive "this
  domain cannot receive mail" rejects a signup; a DNS timeout accepts it. The
  cost of accepting is one confirmation email that bounces before the address
  ever reaches a campaign — the cost of rejecting is a resolver blip silently
  refusing every genuine signup.

- **A spent confirmation link shows the friendly failure page.** §5.2 requires
  clearing the token hash on use, so a second click cannot be recognised as
  "already confirmed". The page says so plainly and offers to start over.

- **Link reachability is checked, but only a definitive 404, 410 or DNS failure
  blocks a send.** A timeout or a bot-blocking 403 is reported as a warning;
  treating an ambiguous answer as failure would make the gate a coin toss for
  any site behind a WAF.

- **`mjml`'s published types are wrong.** They declare `mjml2html` as async; it
  is synchronous as of 4.18. `src/types/mjml.d.ts` declares the real signature,
  which keeps the render path synchronous — the freeze renders and materializes
  in one pass.

- **Deliberately not built** (§1.1): drip sequences, A/B testing, landing
  pages, transactional email for other applications, inbound mail parsing,
  multi-tenancy, paid subscriptions.
