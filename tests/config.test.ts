import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '@/lib/config';

/**
 * `src/lib/config.ts` is the only module allowed to read `process.env`
 * (CONTRACTS "Ground rules"), so every guarantee about environment handling
 * lives or dies here:
 *
 *  - a missing required secret must fail loudly and name itself, not silently
 *    become `undefined` and sign tokens with "undefined";
 *  - a mistyped numeric knob must throw rather than turn into `NaN` and quietly
 *    disable pacing, leases or the circuit breaker (§7.5, §7.8);
 *  - `appBaseUrl` must be slash-normalised, because every confirm / unsubscribe
 *    / tracking URL is built by concatenation onto it.
 */

type EnvPatch = Record<string, string | undefined>;

/** Applies `patch` (undefined = delete) for the duration of `run`, then restores. */
function withEnv<T>(patch: EnvPatch, run: () => T): T {
  const previous: EnvPatch = {};
  for (const key of Object.keys(patch)) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

let snapshot: Record<string, string | undefined>;

beforeEach(() => {
  snapshot = { ...process.env };
});

afterEach(() => {
  // Guards the guard: a case that leaked an env change would poison the rest of
  // the file (and hide a real failure behind an unrelated one).
  expect({ ...process.env }).toEqual(snapshot);
});

const REQUIRED = [
  { name: 'mongoUri', variable: 'MONGODB_URI', read: () => config.mongoUri() },
  { name: 'cronSecret', variable: 'CRON_SECRET', read: () => config.cronSecret() },
  {
    name: 'confirmTokenSecret',
    variable: 'CONFIRM_TOKEN_SECRET',
    read: () => config.confirmTokenSecret(),
  },
  {
    name: 'unsubscribeSecret',
    variable: 'UNSUBSCRIBE_SECRET',
    read: () => config.unsubscribeSecret(),
  },
  { name: 'trackingSecret', variable: 'TRACKING_SECRET', read: () => config.trackingSecret() },
  {
    name: 'adminSessionSecret',
    variable: 'ADMIN_SESSION_SECRET',
    read: () => config.adminSessionSecret(),
  },
  { name: 'adminPassword', variable: 'ADMIN_PASSWORD', read: () => config.adminPassword() },
  { name: 'appBaseUrl', variable: 'APP_BASE_URL', read: () => config.appBaseUrl() },
];

describe('required variables', () => {
  it.each(REQUIRED)('$name throws and names $variable when it is unset', ({ variable, read }) => {
    withEnv({ [variable]: undefined }, () => {
      expect(read).toThrow(`Missing required environment variable: ${variable}`);
    });
  });

  it.each(REQUIRED)('$name throws when $variable is an empty string', ({ variable, read }) => {
    withEnv({ [variable]: '' }, () => {
      expect(read).toThrow(`Missing required environment variable: ${variable}`);
    });
  });

  it.each(REQUIRED)('$name returns the configured value of $variable', ({ variable, read }) => {
    withEnv({ [variable]: `value-for-${variable}` }, () => {
      expect(read()).toBe(`value-for-${variable}`);
    });
  });

  it('names only the variable that is actually missing', () => {
    withEnv({ CRON_SECRET: undefined, TRACKING_SECRET: 'still-here' }, () => {
      expect(() => config.cronSecret()).toThrow(/CRON_SECRET/);
      expect(() => config.cronSecret()).not.toThrow(/TRACKING_SECRET/);
      expect(config.trackingSecret()).toBe('still-here');
    });
  });

  it('never falls back to a placeholder admin password', () => {
    withEnv({ ADMIN_PASSWORD: undefined }, () => {
      // Fail closed (§1.2): there is no default admin password, ever.
      let thrown: unknown;
      let returned: unknown;
      try {
        returned = config.adminPassword();
      } catch (err) {
        thrown = err;
      }
      expect(returned).toBeUndefined();
      expect(thrown).toBeInstanceOf(Error);
    });
  });
});

const OPTIONAL = [
  {
    name: 'mongoDb',
    variable: 'MONGODB_DB',
    fallback: 'newsletter',
    read: () => config.mongoDb(),
  },
  {
    name: 'awsRegion',
    variable: 'AWS_REGION',
    fallback: 'us-east-1',
    read: () => config.awsRegion(),
  },
];

describe('optional variables', () => {
  it.each(OPTIONAL)('$name falls back to "$fallback" when $variable is unset', ({ variable, fallback, read }) => {
    withEnv({ [variable]: undefined }, () => {
      expect(read()).toBe(fallback);
    });
  });

  it.each(OPTIONAL)('$name falls back to "$fallback" when $variable is an empty string', ({ variable, fallback, read }) => {
    withEnv({ [variable]: '' }, () => {
      expect(read()).toBe(fallback);
    });
  });

  it.each(OPTIONAL)('$name prefers the configured value of $variable', ({ variable, read }) => {
    withEnv({ [variable]: 'configured' }, () => {
      expect(read()).toBe('configured');
    });
  });
});

const NUMERIC = [
  {
    name: 'sesMaxSendRate',
    variable: 'SES_MAX_SEND_RATE',
    fallback: 14,
    read: () => config.sesMaxSendRate(),
  },
  {
    name: 'maxBatchesPerRun',
    variable: 'MAX_BATCHES_PER_RUN',
    fallback: 10,
    read: () => config.maxBatchesPerRun(),
  },
  {
    name: 'cronBudgetMs',
    variable: 'CRON_BUDGET_MS',
    fallback: 45_000,
    read: () => config.cronBudgetMs(),
  },
  {
    name: 'batchLeaseMs',
    variable: 'BATCH_LEASE_MS',
    fallback: 120_000,
    read: () => config.batchLeaseMs(),
  },
  {
    name: 'maxBatchAttempts',
    variable: 'MAX_BATCH_ATTEMPTS',
    fallback: 5,
    read: () => config.maxBatchAttempts(),
  },
  { name: 'batchSize', variable: 'BATCH_SIZE', fallback: 50, read: () => config.batchSize() },
  {
    name: 'complaintCircuitBreakerRate',
    variable: 'COMPLAINT_CIRCUIT_BREAKER_RATE',
    fallback: 0.001,
    read: () => config.complaintCircuitBreakerRate(),
  },
  {
    name: 'complaintCircuitBreakerMinDelivered',
    variable: 'COMPLAINT_CIRCUIT_BREAKER_MIN_DELIVERED',
    fallback: 100,
    read: () => config.complaintCircuitBreakerMinDelivered(),
  },
  {
    name: 'typedConfirmationThreshold',
    variable: 'TYPED_CONFIRMATION_THRESHOLD',
    fallback: 1000,
    read: () => config.typedConfirmationThreshold(),
  },
  {
    name: 'pendingExpiryDays',
    variable: 'PENDING_EXPIRY_DAYS',
    fallback: 7,
    read: () => config.pendingExpiryDays(),
  },
  {
    name: 'confirmResendIntervalMs',
    variable: 'CONFIRM_RESEND_INTERVAL_MS',
    fallback: 3_600_000,
    read: () => config.confirmResendIntervalMs(),
  },
  {
    name: 'signupRateLimitPerIpPerHour',
    variable: 'SIGNUP_RATE_LIMIT_IP_PER_HOUR',
    fallback: 20,
    read: () => config.signupRateLimitPerIpPerHour(),
  },
  {
    name: 'transientBounceSuppressionThreshold',
    variable: 'TRANSIENT_BOUNCE_SUPPRESSION_THRESHOLD',
    fallback: 3,
    read: () => config.transientBounceSuppressionThreshold(),
  },
];

describe('numeric variables', () => {
  it.each(NUMERIC)('$name defaults to $fallback when $variable is unset', ({ variable, fallback, read }) => {
    withEnv({ [variable]: undefined }, () => {
      expect(read()).toBe(fallback);
    });
  });

  it.each(NUMERIC)('$name defaults to $fallback when $variable is an empty string', ({ variable, fallback, read }) => {
    withEnv({ [variable]: '' }, () => {
      expect(read()).toBe(fallback);
    });
  });

  it.each(NUMERIC)('$name parses the configured value of $variable', ({ variable, read }) => {
    withEnv({ [variable]: '7' }, () => {
      expect(read()).toBe(7);
    });
  });

  it.each(NUMERIC)('$name rejects a non-numeric $variable, naming both', ({ variable, read }) => {
    withEnv({ [variable]: 'fourteen' }, () => {
      expect(read).toThrow(
        `Environment variable ${variable} must be a number, got "fourteen"`,
      );
    });
  });

  const badValues = ['abc', '12abc', 'NaN', 'Infinity', '-Infinity', '1,000', '0x', 'true'];

  it.each(badValues)('rejects SES_MAX_SEND_RATE="%s" rather than producing NaN', (raw) => {
    withEnv({ SES_MAX_SEND_RATE: raw }, () => {
      // A NaN send rate would disable pacing entirely (§7.5) without a word.
      expect(() => config.sesMaxSendRate()).toThrow(/must be a number/);
    });
  });

  it('honours an explicit 0 instead of treating it as unset', () => {
    withEnv({ MAX_BATCHES_PER_RUN: '0' }, () => {
      // "0" is falsy; a truthiness check here would silently restore the
      // default of 10 and keep sending after an operator asked for a full stop.
      expect(config.maxBatchesPerRun()).toBe(0);
    });
  });

  it('supports fractional rates for the complaint circuit breaker', () => {
    withEnv({ COMPLAINT_CIRCUIT_BREAKER_RATE: '0.0005' }, () => {
      expect(config.complaintCircuitBreakerRate()).toBe(0.0005);
    });
  });

  it('supports exponent notation for long millisecond budgets', () => {
    withEnv({ BATCH_LEASE_MS: '1.2e5' }, () => {
      expect(config.batchLeaseMs()).toBe(120_000);
    });
  });

  it('reads the SES send rate at call time so it can be lowered without a redeploy', () => {
    withEnv({ SES_MAX_SEND_RATE: '14' }, () => {
      expect(config.sesMaxSendRate()).toBe(14);
      process.env.SES_MAX_SEND_RATE = '2';
      expect(config.sesMaxSendRate()).toBe(2);
    });
  });
});

describe('appBaseUrl', () => {
  it('strips a single trailing slash', () => {
    withEnv({ APP_BASE_URL: 'https://mail.example.com/' }, () => {
      expect(config.appBaseUrl()).toBe('https://mail.example.com');
    });
  });

  it('strips repeated trailing slashes', () => {
    withEnv({ APP_BASE_URL: 'https://mail.example.com///' }, () => {
      expect(config.appBaseUrl()).toBe('https://mail.example.com');
    });
  });

  it('leaves a slash-free origin untouched', () => {
    withEnv({ APP_BASE_URL: 'https://mail.example.com' }, () => {
      expect(config.appBaseUrl()).toBe('https://mail.example.com');
    });
  });

  it('preserves a path prefix while stripping its trailing slash', () => {
    withEnv({ APP_BASE_URL: 'https://example.com/newsletter/' }, () => {
      expect(config.appBaseUrl()).toBe('https://example.com/newsletter');
    });
  });

  it('does not strip slashes that are not at the end', () => {
    withEnv({ APP_BASE_URL: 'https://example.com/a//b' }, () => {
      expect(config.appBaseUrl()).toBe('https://example.com/a//b');
    });
  });

  it('yields a single-slash join for the URLs built on top of it', () => {
    withEnv({ APP_BASE_URL: 'https://mail.example.com//' }, () => {
      // Every confirm / unsubscribe / tracking link is built by concatenation;
      // a doubled slash breaks signature-bearing links in real mail clients.
      expect(`${config.appBaseUrl()}/api/confirm`).toBe(
        'https://mail.example.com/api/confirm',
      );
    });
  });

  it('throws when APP_BASE_URL is unset rather than returning a bare path', () => {
    withEnv({ APP_BASE_URL: undefined }, () => {
      expect(() => config.appBaseUrl()).toThrow(
        'Missing required environment variable: APP_BASE_URL',
      );
    });
  });
});

const PASSTHROUGH = [
  {
    name: 'turnstileSecret',
    variable: 'TURNSTILE_SECRET_KEY',
    read: () => config.turnstileSecret(),
  },
  {
    name: 'unsubscribeMailto',
    variable: 'UNSUBSCRIBE_MAILTO',
    read: () => config.unsubscribeMailto(),
  },
  {
    name: 'trackingUrlAllowlist',
    variable: 'TRACKING_URL_ALLOWLIST',
    read: () => config.trackingUrlAllowlist(),
  },
];

describe('optional-feature switches', () => {
  it.each(PASSTHROUGH)('$name is undefined when $variable is unset', ({ variable, read }) => {
    withEnv({ [variable]: undefined }, () => {
      expect(read()).toBeUndefined();
    });
  });

  it.each(PASSTHROUGH)('$name is undefined when $variable is an empty string', ({ variable, read }) => {
    withEnv({ [variable]: '' }, () => {
      // An empty value must read as "feature off", never as a configured empty
      // secret or an empty (deny-everything) allowlist.
      expect(read()).toBeUndefined();
    });
  });

  it.each(PASSTHROUGH)('$name returns the configured value of $variable', ({ variable, read }) => {
    withEnv({ [variable]: 'configured-value' }, () => {
      expect(read()).toBe('configured-value');
    });
  });
});

describe('skipMxCheck', () => {
  it('is false when SKIP_MX_CHECK is unset', () => {
    withEnv({ SKIP_MX_CHECK: undefined }, () => {
      expect(config.skipMxCheck()).toBe(false);
    });
  });

  it('is true only for the exact string "true"', () => {
    withEnv({ SKIP_MX_CHECK: 'true' }, () => {
      expect(config.skipMxCheck()).toBe(true);
    });
  });

  it.each(['false', 'TRUE', 'True', '1', 'yes', ''])('is false for "%s"', (raw) => {
    withEnv({ SKIP_MX_CHECK: raw }, () => {
      expect(config.skipMxCheck()).toBe(false);
    });
  });
});

describe('laziness', () => {
  it('reads every value at call time rather than at module load', () => {
    // The module was imported at the top of this file with the harness values
    // still in place; a snapshot-at-import design would ignore these changes.
    withEnv({ MONGODB_DB: 'switched-db', AWS_REGION: 'eu-west-1' }, () => {
      expect(config.mongoDb()).toBe('switched-db');
      expect(config.awsRegion()).toBe('eu-west-1');
    });

    expect(config.mongoDb()).not.toBe('switched-db');
  });

  it('recovers as soon as a missing variable is supplied again', () => {
    withEnv({ CONFIRM_TOKEN_SECRET: undefined }, () => {
      expect(() => config.confirmTokenSecret()).toThrow(/CONFIRM_TOKEN_SECRET/);
      process.env.CONFIRM_TOKEN_SECRET = 'restored';
      expect(config.confirmTokenSecret()).toBe('restored');
    });
  });
});
