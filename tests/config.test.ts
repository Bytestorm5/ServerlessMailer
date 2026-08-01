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
  // Guards the guard: a case that leaks an env change would poison the rest of
  // the file (and hide a real failure behind an unrelated one).
  expect({ ...process.env }).toEqual(snapshot);
});

const REQUIRED: Array<[string, () => string, string]> = [
  ['mongoUri', () => config.mongoUri(), 'MONGODB_URI'],
  ['cronSecret', () => config.cronSecret(), 'CRON_SECRET'],
  ['confirmTokenSecret', () => config.confirmTokenSecret(), 'CONFIRM_TOKEN_SECRET'],
  ['unsubscribeSecret', () => config.unsubscribeSecret(), 'UNSUBSCRIBE_SECRET'],
  ['trackingSecret', () => config.trackingSecret(), 'TRACKING_SECRET'],
  ['adminSessionSecret', () => config.adminSessionSecret(), 'ADMIN_SESSION_SECRET'],
  ['adminPassword', () => config.adminPassword(), 'ADMIN_PASSWORD'],
  ['appBaseUrl', () => config.appBaseUrl(), 'APP_BASE_URL'],
];

describe('required variables', () => {
  it.each(REQUIRED)('%s throws and names %s when it is unset', (_name, read, variable) => {
    withEnv({ [variable]: undefined }, () => {
      expect(read).toThrow(`Missing required environment variable: ${variable}`);
    });
  });

  it.each(REQUIRED)('%s throws when %s is set to an empty string', (_name, read, variable) => {
    withEnv({ [variable]: '' }, () => {
      expect(read).toThrow(`Missing required environment variable: ${variable}`);
    });
  });

  it.each(REQUIRED)('%s returns the configured value of %s', (_name, read, variable) => {
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

  it('does not fall back to a placeholder secret when the variable is missing', () => {
    withEnv({ ADMIN_PASSWORD: undefined }, () => {
      // Fail closed (§1.2): there is no default admin password, ever.
      let thrown: unknown;
      try {
        config.adminPassword();
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
    });
  });
});

const OPTIONAL: Array<[string, () => string, string, string]> = [
  ['mongoDb', () => config.mongoDb(), 'MONGODB_DB', 'newsletter'],
  ['awsRegion', () => config.awsRegion(), 'AWS_REGION', 'us-east-1'],
];

describe('optional variables', () => {
  it.each(OPTIONAL)('%s falls back to "%s" default when %s is unset', (_n, read, variable, fallback) => {
    withEnv({ [variable]: undefined }, () => {
      expect(read()).toBe(fallback);
    });
  });

  it.each(OPTIONAL)('%s falls back to its default when %s is an empty string', (_n, read, variable, fallback) => {
    withEnv({ [variable]: '' }, () => {
      expect(read()).toBe(fallback);
    });
  });

  it.each(OPTIONAL)('%s prefers the configured value of %s', (_n, read, variable) => {
    withEnv({ [variable]: 'configured' }, () => {
      expect(read()).toBe('configured');
    });
  });
});

const NUMERIC: Array<[string, () => number, string, number]> = [
  ['sesMaxSendRate', () => config.sesMaxSendRate(), 'SES_MAX_SEND_RATE', 14],
  ['maxBatchesPerRun', () => config.maxBatchesPerRun(), 'MAX_BATCHES_PER_RUN', 10],
  ['cronBudgetMs', () => config.cronBudgetMs(), 'CRON_BUDGET_MS', 45_000],
  ['batchLeaseMs', () => config.batchLeaseMs(), 'BATCH_LEASE_MS', 120_000],
  ['maxBatchAttempts', () => config.maxBatchAttempts(), 'MAX_BATCH_ATTEMPTS', 5],
  ['batchSize', () => config.batchSize(), 'BATCH_SIZE', 50],
  [
    'complaintCircuitBreakerRate',
    () => config.complaintCircuitBreakerRate(),
    'COMPLAINT_CIRCUIT_BREAKER_RATE',
    0.001,
  ],
  [
    'complaintCircuitBreakerMinDelivered',
    () => config.complaintCircuitBreakerMinDelivered(),
    'COMPLAINT_CIRCUIT_BREAKER_MIN_DELIVERED',
    100,
  ],
  [
    'typedConfirmationThreshold',
    () => config.typedConfirmationThreshold(),
    'TYPED_CONFIRMATION_THRESHOLD',
    1000,
  ],
  ['pendingExpiryDays', () => config.pendingExpiryDays(), 'PENDING_EXPIRY_DAYS', 7],
  [
    'confirmResendIntervalMs',
    () => config.confirmResendIntervalMs(),
    'CONFIRM_RESEND_INTERVAL_MS',
    3_600_000,
  ],
  [
    'signupRateLimitPerIpPerHour',
    () => config.signupRateLimitPerIpPerHour(),
    'SIGNUP_RATE_LIMIT_IP_PER_HOUR',
    20,
  ],
  [
    'transientBounceSuppressionThreshold',
    () => config.transientBounceSuppressionThreshold(),
    'TRANSIENT_BOUNCE_SUPPRESSION_THRESHOLD',
    3,
  ],
];

describe('numeric variables', () => {
  it.each(NUMERIC)('%s defaults to %# when %s is unset', (_n, read, variable, fallback) => {
    withEnv({ [variable]: undefined }, () => {
      expect(read()).toBe(fallback);
    });
  });

  it.each(NUMERIC)('%s defaults when %s is an empty string', (_n, read, variable, fallback) => {
    withEnv({ [variable]: '' }, () => {
      expect(read()).toBe(fallback);
    });
  });

  it.each(NUMERIC)('%s parses the configured value of %s', (_n, read, variable) => {
    withEnv({ [variable]: '7' }, () => {
      expect(read()).toBe(7);
    });
  });

  it.each(NUMERIC)('%s rejects a non-numeric %s, naming the variable and the value', (_n, read, variable) => {
    withEnv({ [variable]: 'fourteen' }, () => {
      expect(read).toThrow(
        `Environment variable ${variable} must be a number, got "fourteen"`,
      );
    });
  });

  const badValues = ['abc', '12abc', 'NaN', 'Infinity', '-Infinity', '1,000', '0x', 'true'];

  it.each(badValues)('rejects %s rather than silently producing NaN', (raw) => {
    withEnv({ SES_MAX_SEND_RATE: raw }, () => {
      // A NaN send rate would disable pacing entirely (§7.5) without a word.
      expect(() => config.sesMaxSendRate()).toThrow(/must be a number/);
    });
  });

  it('honours an explicit 0 instead of treating it as unset', () => {
    withEnv({ MAX_BATCHES_PER_RUN: '0' }, () => {
      // "0" is falsy; a truthiness check here would silently restore the
      // default and keep sending after an operator asked for a full stop.
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

const PASSTHROUGH: Array<[string, () => string | undefined, string]> = [
  ['turnstileSecret', () => config.turnstileSecret(), 'TURNSTILE_SECRET_KEY'],
  ['unsubscribeMailto', () => config.unsubscribeMailto(), 'UNSUBSCRIBE_MAILTO'],
  ['trackingUrlAllowlist', () => config.trackingUrlAllowlist(), 'TRACKING_URL_ALLOWLIST'],
];

describe('optional-feature switches', () => {
  it.each(PASSTHROUGH)('%s is undefined when %s is unset', (_n, read, variable) => {
    withEnv({ [variable]: undefined }, () => {
      expect(read()).toBeUndefined();
    });
  });

  it.each(PASSTHROUGH)('%s is undefined when %s is an empty string', (_n, read, variable) => {
    withEnv({ [variable]: '' }, () => {
      // An empty value must read as "feature off", never as a configured
      // empty secret / empty allowlist.
      expect(read()).toBeUndefined();
    });
  });

  it.each(PASSTHROUGH)('%s returns the configured value of %s', (_n, read, variable) => {
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

  it.each(['false', 'TRUE', 'True', '1', 'yes', ''])(
    'is false for %s',
    (raw) => {
      withEnv({ SKIP_MX_CHECK: raw }, () => {
        expect(config.skipMxCheck()).toBe(false);
      });
    },
  );
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
