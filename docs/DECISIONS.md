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

### A list can be tested before a campaign exists

§6.5 covers test sends, but the only implementation was campaign-scoped, and the
thing most likely to be wrong on a newly configured list is the sending identity
itself — an unverified domain, a From address outside it, a mistyped
configuration set. Those are precisely the fields a campaign inherits, so
discovering them through a campaign is discovering them late.

`/admin/lists` can therefore send a test from a list alone. It renders a
synthetic campaign — never persisted — through `renderCampaignPreview`, so the
merge path, the postal address and the unsubscribe footer are the real ones
rather than a second implementation written for testing. Nothing is written to
`sent_log`, batches or campaign counts, and the unsubscribe link is signed with
a synthetic subscriber id so clicking it in a test inbox cannot unsubscribe a
real person.

It refuses a suppressed address. A test send is a real send with real
reputation cost, and §1.2 admits no bypass — the campaign-scoped
`sendTestEmail` predates this module and does not yet make the same check.

### Templates are opt-in per list, not a replacement for MJML

§6.2 says not to hand-author table-based email HTML, and for the *generated*
layout that still stands. But a newsletter is a piece of design, and a generated
layout can only ever be the layout its generator knows about. §6.2a adds a
hand-authored template per list; the question was whether it should replace the
built-in one everywhere.

**It does not.** A list with no stored template renders exactly as before, so
adopting a template is a decision an operator makes per list and can undo with
one button, and no campaign changes appearance because the feature shipped. The
template page opens pre-filled with the branded default, so the starting point
is a real design rather than an empty box — one click stores it and the list is
switched over.

The one place a template is unavoidable is a **pasted HTML fragment**: MJML
cannot host arbitrary markup, and a fragment with no document around it is not
an email. Those render through the stored template, or through the built-in
default when the list has not chosen one.

### The HTML sanitizer keeps almost everything

`render/doc.ts` rejects anything outside a closed node set, and that is right
for editor JSON: an unknown node is content the renderer has no template for.
Applying the same stance to hand-authored HTML would defeat the point of it —
tables, VML, `<style>`, MSO conditional comments and presentational attributes
are what an email is actually made of.

So `render/sanitize.ts` inverts the default: keep everything, remove only what
is actively dangerous — script and embedded elements, `on*` handlers, unsafe URL
schemes, `<base>`, `<meta http-equiv>`. It is a hand-written tokenizer rather
than a sanitizer library for the same reason `merge.ts` and `markdown.ts` are
hand-written: the parser has to be the same shape as the contract. A
general-purpose sanitizer's allowlist has no room for `<v:roundrect>`, and its
attribute filter would not know that `{{ first_name | default: "there" }}` in a
`title=` must survive byte for byte into a frozen SES template.

Removals are **warnings, not errors**. They do not block a save and they do not
block the §6.6 gate. The output is already safe by the time anything sees it, so
a hard block would buy no safety and would only teach people to route around the
gate — which is the failure mode §6.6 itself warns about.

### The template is frozen onto the campaign

§7.1 freezes the rendered body so a template change mid-send cannot produce two
different emails. That was not quite enough once templates existed: SES
substitutes merge values per recipient, batch by batch, for as long as the send
runs, and `buildReplacements` derives those values — and their fallbacks — from
the template *source*, not from the frozen HTML, because the frozen HTML has
already been reduced to bare `{{placeholder}}` markers with the fallbacks
stripped out.

So `freezeCampaign` stores `campaign.templateSource` alongside `bodyHtml`. The
send pipeline reads the frozen copy and never the live one, which needed no
change to `processBatch` at all: `campaignTemplateText` simply defaults to it.

### The preview no longer announces that it is re-rendering

The campaign preview re-renders on every keystroke, and a `<p>Updating…</p>`
that appeared and vanished a few hundred milliseconds later reflowed the toolbar
underneath the writer's cursor. §6 says this is a writing tool; a writing tool
that twitches is not one.

The state is now `aria-busy` on the preview region — no layout, no reflow, and
assistive technology still learns that the panel is stale.

### The confirmation email is a template kind, not a second system

Putting the double opt-in email (§5.4) under the same editor as the newsletter
raised one real question: is it a *shell* with a slot, like a campaign template,
or is it the whole email?

**The whole email.** A campaign has a body written elsewhere, so its template
needs `{{content}}`; a confirmation email's copy — the greeting, the sentence
explaining why it arrived, the "if you didn't subscribe, ignore this" line — *is*
the design. Splitting that into app-owned copy and an operator-owned wrapper
would leave the operator unable to change the one paragraph most worth changing.

So `EmailTemplateDoc` gained a `kind`, the unique index moved to
`{listId, kind}`, and validation became kind-aware: a campaign template must
have `{{content}}` and must not use `{{confirm_url}}`; a confirmation template
must have `{{confirm_url}}` and must not use `{{unsubscribe_url}}`. That last
rule is not pedantry — an unsubscribe link in a confirmation email offers to
remove a subscription that does not exist yet, and the one-click endpoint would
have nothing to act on.

Two things stay app-owned. The **subject** is still
`Confirm your subscription to <list>`, because it is the line that makes the
email recognisable in an inbox and nothing about a template says it should
change. The **confirmation link** is guaranteed into the output exactly the way
the unsubscribe link is guaranteed into a campaign: a template that forgets it
gets one appended rather than sending a dead email.

The plain-text part is now derived from the rendered HTML rather than written
alongside it. A separately-authored text part is a text part that goes stale the
first time somebody edits the design.

### Both default templates were rebuilt around one design

The defaults are what most lists will actually send, so they are not
placeholders. Both now share a cream page, a rounded paper card held to 600px by
an MSO-only table — Word ignores `max-width`, so a fixed 600 would still be 600
on a phone — a serif wordmark, and a sign-off outside the card. The confirmation
default adds a bulletproof button: a background-coloured table cell for clients
that drop CSS on anchors, with a VML shape behind it for Outlook, which drops
`border-radius` and padding.

The wordmark is **text, not an image**. A default that points at a logo URL
nobody has uploaded renders as a broken-image icon in every inbox; the commented
`<img>` beside it is the two-line swap for operators who have one.
