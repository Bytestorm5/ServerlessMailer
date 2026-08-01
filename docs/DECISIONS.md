# Decisions

The spec leaves four questions open (§17), and a handful of others had to be
settled during implementation. This is what was decided and why, so the next
person does not have to reverse-engineer it.

---

## The spec's open questions

### Retention policy for `events` — TTL index, or archive?

**Neither, for now: events are kept.** A TTL index silently deletes the only
per-recipient evidence of what happened during a send, and it does so at the
moment you are least likely to notice. At ~33k sends a month with opens and
clicks optional per campaign, the collection grows slowly enough that this is
not yet a cost problem.

The aggregate counts that drive the dashboard and the circuit breaker are
denormalised onto the campaign document, so `events` can be archived later
without breaking anything. When it does need bounding, archive to cold storage
rather than adding a TTL — the difference matters the first time a complaint is
escalated.

### One deployment with a list selector, or two deployments sharing a codebase?

**One deployment, `listId` throughout** — the spec's own leaning, and the schema
already assumes it. Every collection except `suppressions` carries `listId`, and
`suppressions` is deliberately global because SES reputation thresholds are
account-level: a hard bounce on one domain must suppress the address on the
other.

Two deployments would need the suppression list shared between them anyway, which
is the hard part, and would double the cron surface for no benefit.

### Preference centre scope — topic-level opt-outs, or unsubscribe only?

**Unsubscribe only.** Topic-level preferences are a second product: they need a
topic model, per-topic consent records, and a segmentation story, and they make
the unsubscribe path — the most availability-critical endpoint in the system —
more complicated for no compliance benefit. The human-facing unsubscribe page
offers a one-click way back, which covers the case where someone left by
accident.

### Alerting channel for the circuit breaker and failed batches

**Dashboard plus structured logs**, with no external dependency. The circuit
breaker logs at `error` level with the campaign id and the observed rate, which
any log drain can alert on, and the dashboard surfaces rolling bounce and
complaint rates on the front page rather than in a metrics tab. Failed batches
appear on the campaign with their `lastError`.

Adding Slack or email alerting means another credential, another failure mode,
and another thing to test; the log line carries everything an alert would, so the
integration can be added at the drain rather than in this codebase.

---

## Decisions taken during implementation

### Unsubscribe tokens carry their ids alongside the signature

§9.2 specifies `HMAC-SHA256(subscriberId + campaignId, UNSUBSCRIBE_SECRET)`.
Taken literally that is a one-way digest, and the endpoint receiving it could not
tell which subscriber to unsubscribe. The token is therefore
`base64url(subscriberId.campaignId).base64url(hmac)` — the ids travel with the
signature. Both properties the spec cares about hold: it is unforgeable without
the secret, so not enumerable, and it carries no expiry, so a link in a
three-year-old email still works.

### Bulk sends use an inline SES template, not a stored one

SES v2's `SendBulkEmail` accepts full template content in the request, so the
pipeline creates no server-side templates. That keeps sends stateless: there is
no template lifecycle to manage, nothing to garbage-collect, and no way for a
campaign to send with a template belonging to a different campaign. Per-recipient
values arrive as `ReplacementTemplateData` and the `List-Unsubscribe` header as
`ReplacementHeaders`.

### Reputation rates are computed against sends, not deliveries

SES computes its account-level bounce and complaint rates against messages sent,
and so does the dashboard. Using `delivered` would be actively dangerous:
delivery notifications are an optional SNS subscription (§8.2), so a deployment
that never subscribed to them would show a 0% bounce rate no matter how badly the
account was burning.

### Freeze flips the campaign status before materialising batches

`claimBatch` only considers campaigns in `sending`, and
`reconcileCompletedCampaigns` ignores a `sending` campaign with no batches at
all. That makes the half-frozen window inert — nothing is sent, and nothing is
prematurely marked complete — and it means two concurrent freezes cannot both
proceed, because only one can win the status transition. A failure part way
through rolls the campaign back to `draft`.

### Imported-as-pending subscribers are confirmed by a background job

§4.3 says addresses imported without a prior-consent attestation "land as
`pending` and receive a confirmation email". Sending those inline would blow the
request's time budget on a 33,000-row file, so import creates the records and a
bounded job on the per-minute cron mints each token and sends the email. A large
import drains over a few minutes rather than stalling one request, and the
suppression list is checked there too.

### The pre-send gate renders the email

Three of the §6.6 checks — that the email renders, that it carries an
unsubscribe link, and that it carries the postal address — are made against the
*rendered* output rather than the source. Checking the source would pass a
campaign whose template had regressed and dropped the footer. Rendering costs a
few hundred milliseconds and is paid once per send.

### Lists are configured in the app, and a populated list is never deleted

§3.1 defines the `lists` collection but no surface for editing it, so a list
could only be created by inserting a document into MongoDB by hand — which put
the sending identity (verified domain, From address, physical address,
configuration set) outside the application that depends on all four, and left a
fresh deployment unable to do anything at all until someone reached for
`mongosh`. `/admin/lists` now owns it.

Two rules make that safe. Validation runs against the whole document rather than
the incoming patch, because `fromEmail` is only meaningful in relation to
`sendingDomain`: SES rejects a From address outside the verified identity, so
editing one side of that pair alone must fail. And deletion is refused for a
list that any subscriber or campaign references. Subscribers hold the consent
evidence that answers a complaint, campaigns hold the send history behind the
reputation numbers, and `processBatch` fails a batch outright when its list has
vanished mid-send; none of that is recoverable by re-creating a list with the
same name, because every reference is by `_id`. Deactivation is the reversible
operation — it closes signups and hides the list from the campaign picker while
leaving history intact — and it is what an operator almost always means.
