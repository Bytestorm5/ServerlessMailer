/**
 * Environment configuration.
 *
 * Every value is read lazily through a function rather than captured at module
 * load, so tests can change the environment between cases and so a missing
 * secret fails at the point of use with a precise message instead of crashing
 * the whole serverless bundle at import time.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function numeric(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  }
  return parsed;
}

export const config = {
  mongoUri: () => required('MONGODB_URI'),
  mongoDb: () => optional('MONGODB_DB', 'newsletter'),

  cronSecret: () => required('CRON_SECRET'),
  confirmTokenSecret: () => required('CONFIRM_TOKEN_SECRET'),
  unsubscribeSecret: () => required('UNSUBSCRIBE_SECRET'),
  trackingSecret: () => required('TRACKING_SECRET'),
  adminSessionSecret: () => required('ADMIN_SESSION_SECRET'),
  adminPassword: () => required('ADMIN_PASSWORD'),

  /** Public origin, used to build confirm / unsubscribe / tracking URLs. */
  appBaseUrl: () => required('APP_BASE_URL').replace(/\/+$/, ''),

  awsRegion: () => optional('AWS_REGION', 'us-east-1'),

  /**
   * SES account-level send rate (messages/second). Exposed as an env var
   * precisely so it can be lowered instantly if reputation degrades (§7.5).
   */
  sesMaxSendRate: () => numeric('SES_MAX_SEND_RATE', 14),

  /** Sized to the SES quota rather than to the clock (§7.2). */
  maxBatchesPerRun: () => numeric('MAX_BATCHES_PER_RUN', 10),

  /** Wall-clock budget for one cron invocation, leaving headroom before the next tick. */
  cronBudgetMs: () => numeric('CRON_BUDGET_MS', 45_000),

  /** Must comfortably exceed worst-case batch processing time (§7.3). */
  batchLeaseMs: () => numeric('BATCH_LEASE_MS', 120_000),

  maxBatchAttempts: () => numeric('MAX_BATCH_ATTEMPTS', 5),

  /** SES SendBulkEmail destination limit. */
  batchSize: () => numeric('BATCH_SIZE', 50),

  /** Auto-pause threshold, as a fraction of delivered (§7.8). */
  complaintCircuitBreakerRate: () => numeric('COMPLAINT_CIRCUIT_BREAKER_RATE', 0.001),

  /** Below this many delivered, the complaint rate is too noisy to act on. */
  complaintCircuitBreakerMinDelivered: () =>
    numeric('COMPLAINT_CIRCUIT_BREAKER_MIN_DELIVERED', 100),

  /** Sends above this recipient count require typed confirmation (§6.7). */
  typedConfirmationThreshold: () => numeric('TYPED_CONFIRMATION_THRESHOLD', 1000),

  /** Unconfirmed pending records are purged after this many days (§4.1). */
  pendingExpiryDays: () => numeric('PENDING_EXPIRY_DAYS', 7),

  /** Confirmation email resend limit, per address. */
  confirmResendIntervalMs: () => numeric('CONFIRM_RESEND_INTERVAL_MS', 60 * 60 * 1000),

  signupRateLimitPerIpPerHour: () => numeric('SIGNUP_RATE_LIMIT_IP_PER_HOUR', 20),

  /**
   * Optional Cloudflare Turnstile. When unset, the check is skipped.
   *
   * Trimmed because Cloudflare compares the secret byte for byte: one trailing
   * newline — which is exactly what `vercel env add < file` and a copy-paste
   * out of the dashboard leave behind — turns every siteverify call into
   * `invalid-input-secret`, and the signup form rejects every human on the
   * site. Secrets are never whitespace-significant, so trimming loses nothing.
   */
  turnstileSecret: () => process.env.TURNSTILE_SECRET_KEY?.trim() || undefined,

  /** Transient bounces across this many distinct campaigns cause suppression (§8.2). */
  transientBounceSuppressionThreshold: () =>
    numeric('TRANSIENT_BOUNCE_SUPPRESSION_THRESHOLD', 3),

  /** mailto: address advertised in the List-Unsubscribe header. */
  unsubscribeMailto: () => process.env.UNSUBSCRIBE_MAILTO || undefined,

  /**
   * Comma-separated hosts that click-tracking redirects may target. When unset,
   * the signature alone gates the redirector; when set, it is enforced as well.
   */
  trackingUrlAllowlist: () => process.env.TRACKING_URL_ALLOWLIST || undefined,

  /** Skips MX verification when running without outbound DNS. */
  skipMxCheck: () => process.env.SKIP_MX_CHECK === 'true',
};

export type Config = typeof config;
