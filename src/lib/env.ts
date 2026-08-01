/**
 * Environment access.
 *
 * Everything here is resolved lazily at call time, never at module load. A
 * missing secret must fail the request that needs it, not the build or the
 * cold start of an unrelated route.
 */

function read(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function requireEnv(name: string): string {
  const value = read(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function optionalEnv(name: string): string | undefined {
  return read(name);
}

function num(name: string, fallback: number): number {
  const raw = read(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got: ${raw}`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = read(name)?.toLowerCase();
  if (raw === undefined) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export const env = {
  get appBaseUrl(): string {
    const raw =
      read('APP_BASE_URL') ??
      (read('VERCEL_PROJECT_PRODUCTION_URL') ? `https://${read('VERCEL_PROJECT_PRODUCTION_URL')}` : undefined) ??
      (read('VERCEL_URL') ? `https://${read('VERCEL_URL')}` : undefined);
    if (!raw) throw new Error('Missing required environment variable: APP_BASE_URL');
    return raw.replace(/\/+$/, '');
  },

  get mongoUri(): string {
    return requireEnv('MONGODB_URI');
  },
  get mongoDb(): string {
    return read('MONGODB_DB') ?? 'serverless_mailer';
  },

  get cronSecret(): string {
    return requireEnv('CRON_SECRET');
  },
  get sessionSecret(): string {
    return requireEnv('SESSION_SECRET');
  },
  get confirmTokenSecret(): string {
    return requireEnv('CONFIRM_TOKEN_SECRET');
  },
  get unsubscribeSecret(): string {
    return requireEnv('UNSUBSCRIBE_SECRET');
  },
  get trackingSecret(): string {
    return requireEnv('TRACKING_SECRET');
  },

  get sesRegion(): string {
    return read('SES_REGION') ?? read('AWS_REGION') ?? 'us-east-1';
  },
  get sesAccessKeyId(): string | undefined {
    return read('SES_ACCESS_KEY_ID') ?? read('AWS_ACCESS_KEY_ID');
  },
  get sesSecretAccessKey(): string | undefined {
    return read('SES_SECRET_ACCESS_KEY') ?? read('AWS_SECRET_ACCESS_KEY');
  },
  get mailerDriver(): 'ses' | 'console' {
    return read('MAILER_DRIVER') === 'ses' ? 'ses' : 'console';
  },

  get sesMaxSendRate(): number {
    return Math.max(1, num('SES_MAX_SEND_RATE', 14));
  },
  get cronRunBudgetMs(): number {
    return num('CRON_RUN_BUDGET_MS', 45_000);
  },
  get batchLeaseMs(): number {
    return num('BATCH_LEASE_MS', 120_000);
  },
  get maxBatchAttempts(): number {
    return num('MAX_BATCH_ATTEMPTS', 5);
  },
  /**
   * Sized to the SES quota rather than to the clock (§7.2): the run budget
   * multiplied by the send rate is the most this invocation may emit without
   * risking the account-level rate limit when invocations overlap.
   */
  get maxBatchesPerRun(): number {
    const explicit = read('MAX_BATCHES_PER_RUN');
    if (explicit !== undefined) return Math.max(1, Number(explicit));
    const messages = (this.cronRunBudgetMs / 1000) * this.sesMaxSendRate;
    return Math.max(1, Math.floor(messages / BATCH_SIZE));
  },

  get complaintRateThreshold(): number {
    return num('COMPLAINT_RATE_THRESHOLD', 0.001);
  },
  get complaintMinDelivered(): number {
    return num('COMPLAINT_MIN_DELIVERED', 500);
  },
  get bounceRateThreshold(): number {
    return num('BOUNCE_RATE_THRESHOLD', 0.05);
  },
  get bounceMinDelivered(): number {
    return num('BOUNCE_MIN_DELIVERED', 500);
  },
  get alertWebhookUrl(): string | undefined {
    return read('ALERT_WEBHOOK_URL');
  },

  get typedConfirmThreshold(): number {
    return num('TYPED_CONFIRM_THRESHOLD', 1000);
  },

  get signupRateLimitPerIp(): number {
    return num('SIGNUP_RATE_LIMIT_PER_IP', 10);
  },
  get signupRateLimitWindowSec(): number {
    return num('SIGNUP_RATE_LIMIT_WINDOW_SEC', 3600);
  },
  get confirmResendIntervalSec(): number {
    return num('CONFIRM_RESEND_INTERVAL_SEC', 3600);
  },
  get turnstileSecretKey(): string | undefined {
    return read('TURNSTILE_SECRET_KEY');
  },

  get disableMxCheck(): boolean {
    return bool('DISABLE_MX_CHECK', false);
  },

  get adminBootstrapEmail(): string | undefined {
    return read('ADMIN_BOOTSTRAP_EMAIL');
  },
  get adminBootstrapPassword(): string | undefined {
    return read('ADMIN_BOOTSTRAP_PASSWORD');
  },

  get isProduction(): boolean {
    return process.env.NODE_ENV === 'production';
  },
};

/**
 * SES `SendBulkEmail` accepts at most 50 destinations per call, which is what
 * fixes the batch size (§3.5).
 */
export const BATCH_SIZE = 50;

/** Pending subscribers that never confirm are purged after this long (§4.1). */
export const PENDING_TTL_DAYS = 7;

/** Confirmation tokens expire after this long (§5.1). */
export const CONFIRM_TOKEN_TTL_DAYS = 7;
