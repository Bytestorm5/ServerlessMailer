# Operations

Deliverability configuration is not application code, but the application does
not work without it. This is the setup, the migration order, and the runbook.

---

## 1. Per sending domain (spec §10.1)

Do this once per newsletter, before any real send.

**Dedicated sending subdomain.** `news.domain-a.com`, `news.domain-b.com`. Bulk
reputation stays isolated from human mail on the root domain, so a bad campaign
cannot stop your invoices arriving.

**SES verified domain identity with Easy DKIM, 2048-bit.** Verify the
subdomain, not the root. SES gives you three CNAMEs; publish all three in
Cloudflare with proxying **off** (DKIM records must resolve as CNAMEs, not
through Cloudflare's proxy).

**Custom MAIL FROM domain** — `bounce.news.domain-a.com` — for DMARC alignment.
This needs two records:

| Type | Name | Value |
|---|---|---|
| MX | `bounce.news.domain-a.com` | `10 feedback-smtp.<region>.amazonses.com` |
| TXT | `bounce.news.domain-a.com` | `v=spf1 include:amazonses.com ~all` |

**SES configuration set** per domain, with an SNS event destination publishing
`Bounce`, `Complaint`, `Delivery` and `Reject` to a topic subscribed to
`https://<your-host>/api/webhooks/ses`. Record the configuration set name in the
list document's `sesConfigurationSet` field — the send pipeline passes it on
every message, and without it no feedback reaches the application at all.

**Request a sending rate increase before the first production send.** The
default is 14 messages/second and a low daily cap. Set `SES_MAX_SEND_RATE` to
whatever SES actually grants you, never higher.

## 2. DMARC (spec §10.2)

Publish on the **root** domain at `p=none` with an `rua` address:

```
_dmarc.domain-a.com  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@domain-a.com"
```

Monitor for at least two weeks and confirm alignment before moving to
`p=quarantine`. Moving early, while a legitimate sender is still misaligned,
silently quarantines your own mail.

## 3. IP strategy (spec §10.3)

Shared IPs. A dedicated IP costs $24.95/month and needs sustained volume to stay
warm; at ~33k/month across both lists it would actively hurt deliverability.

## 4. Warmup (spec §10.4)

Do **not** send 19,000 on day one from a new subdomain. Ramp over 2–4 weeks,
most-engaged segments first. The segment picker's engagement filter ("opened one
of the last 3 campaigns") exists for exactly this.

A workable ramp: 500 → 1,000 → 2,500 → 5,000 → 10,000 → full list, one step per
send, holding a step if the bounce or complaint rate moves.

---

## 5. Migration from Squarespace (spec §14)

**The order matters.** Getting it wrong re-mails people who opted out, which is
a CAN-SPAM problem as well as a deliverability one.

1. **Export subscribers _and_ the suppression list** (unsubscribes, bounces)
   from Squarespace. The suppression list is the part people forget.
2. **Import suppressions first**, before any subscribers. Admin → Import &
   export. Import is idempotent, so re-running it is safe.
3. **Import subscribers as `confirmed`** under the prior-consent attestation.
   Do not re-confirm 33,000 existing subscribers — a re-confirmation campaign
   typically loses the majority of a list. The attestation wording is stored
   verbatim as your consent record.
4. **Configure DNS, SES identities, DKIM, MAIL FROM and DMARC** per §1–§2 above.
5. **Run one campaign in parallel**: send from this system to a 500-person
   engaged segment, keep Squarespace for the remainder, and compare bounce and
   complaint rates.
6. **Warm up** per §4.
7. **Cut over.** Keep the Squarespace subscription for one billing cycle as a
   rollback path.

Because import checks every address against `suppressions` and skips matches,
step 2 protects every later step. If you discover you did step 3 before step 2,
import the suppressions and then audit: the addresses are already subscribed,
and only the suppression list will keep them from being mailed.

---

## 6. Runbook (spec §15)

| Symptom | Likely cause | Response |
|---|---|---|
| Send stalls, batches stuck `claimed` | Function crashing mid-batch | Lease expiry auto-recovers within 2 minutes. If it persists, check `lastError` on the batch and the function logs |
| Batches at `attempts = MAX`, `failed` | Malformed content or SES rejection | The campaign page lists failed batches with their `lastError`. Fix the cause, then re-send to the remainder |
| Bounce rate climbing | Stale list or a bad import | Pause immediately from the campaign page, then audit recent imports against `suppressions` |
| Complaint rate above 0.1% | Content or consent problem | The circuit breaker should have paused it already. Investigate before resuming |
| SES `Throttling` errors | Concurrency exceeding quota | Lower `MAX_BATCHES_PER_RUN`, then `SES_MAX_SEND_RATE`. Request a quota increase |
| Cron not firing | Schedule not registered after a rollback | Redeploy. Cron registers at deploy time, and an Instant Rollback does **not** update active cron jobs |
| Duplicate sends reported | Should be impossible | Verify the `sent_log` unique index exists: `db.sent_log.getIndexes()`. That index is the invariant |
| Confirmation emails not arriving | Transactional path or SES identity issue | These do not use the cron path. Check SES send logs directly |

### Stopping a send right now

Open the campaign and press **Pause sending**. Sending stops within one minute,
because pausing removes the campaign from the claim query and nothing else
coordinates the workers. No in-flight work is lost, and resuming cannot
double-send — `sent_log` sees to that.

This is why a 30-minute send window is desirable: a bad subject line caught at
minute three costs 1,800 sends instead of 19,000.

### Lowering the send rate under pressure

`SES_MAX_SEND_RATE` and `MAX_BATCHES_PER_RUN` are environment variables
specifically so they can be changed without a code change. Lower them in Vercel
and redeploy; the next tick picks up the new values.

### Verifying the invariant

```js
// Every index the application depends on, including the one that makes
// double-sends impossible.
db.sent_log.getIndexes()      // expect campaignId_subscriberId_unique
db.suppressions.getIndexes()  // expect email_unique
db.subscribers.getIndexes()   // expect listId_email_unique
```

`ensureIndexes()` in `src/lib/db/indexes.ts` creates all of them and is
idempotent, so it is safe to run against production at any time.
