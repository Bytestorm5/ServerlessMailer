# ServerlessMailer

A self-hosted newsletter platform for two independent domains with separate
subscriber lists. It does three things well — list management, double opt-in,
and writing — and one thing invisibly: it never double-sends, never loses a
recipient, and never damages sender reputation.

Built to [`docs/SPEC.md`](docs/SPEC.md). Module-level signatures are fixed in
[`docs/CONTRACTS.md`](docs/CONTRACTS.md).

## Stack

| Layer | Technology |
|---|---|
| Web app + API | Next.js (App Router) on Vercel |
| Scheduler | Vercel Cron, `* * * * *` |
| Database | MongoDB Atlas |
| Delivery | AWS SES v2 |
| Feedback | SES → SNS → signed HTTPS webhook |
| Editor | Tiptap |
| Email HTML | MJML with inlined CSS |

## The design in one paragraph

Cron fires every minute and claims batches of at most 50 recipients with an
atomic `findOneAndUpdate` that sets a 120-second lease. A run that dies
mid-batch leaves the lease to expire, and the next tick picks the work back up —
cron plus lease expiry *is* the retry queue, which is why there is no queue
service here. Every successful send inserts into `sent_log`, which carries a
unique index on `{campaignId, subscriberId}`; a duplicate key means "already
sent" and is swallowed. That index is not an optimization, it is the invariant
that makes double-sends impossible even if the claim logic has a bug.

## Getting started

```bash
npm install
cp .env.example .env.local   # then fill in the secrets
npm run dev
```

Run the test suite (an in-memory MongoDB is started automatically):

```bash
npm test
npm run test:coverage
```

## Operational safety

- **Pause** removes a campaign from the claim query, so sending stops within one
  minute with no in-flight work lost. Resuming is safe because `sent_log` means
  already-sent batches cannot repeat.
- **The circuit breaker** auto-pauses a campaign whose complaint rate exceeds
  0.1% of delivered, which is the difference between a bad campaign and a
  suspended SES account.
- **The suppression list** is global across both domains and is checked on every
  send path, at freeze time *and* again at send time, plus on every import.
  There is no bypass flag.
- **`SES_MAX_SEND_RATE`** and **`MAX_BATCHES_PER_RUN`** are environment
  variables specifically so they can be lowered instantly if reputation
  degrades.

## Deployment notes

Cron schedules register at deploy time, and an Instant Rollback does **not**
update active cron jobs — if cron stops firing, redeploy. `CRON_SECRET` is
auto-provisioned by Vercel and is verified before any work happens.

Deliverability configuration (dedicated sending subdomain, Easy DKIM, custom
MAIL FROM, DMARC) is not application code but the application does not work
without it. See [`docs/SPEC.md` §10](docs/SPEC.md).
