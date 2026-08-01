import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSes } from '@tests/helpers/fake-ses';
import type { SesAdapter } from '@/lib/ses/types';
import { getSesAdapter, resetSesAdapter, setSesAdapter } from '@/lib/ses/registry';

/**
 * The SES seam (CONTRACTS ground rule: "Never import the AWS SDK outside
 * `src/lib/ses/aws.ts`. Use `getSesAdapter()`").
 *
 * Two properties matter here and nothing else does:
 *
 *  1. When a test has installed an override, the AWS module must not be
 *     imported *at all* — otherwise a test run would construct a real SESv2
 *     client, need real credentials, and could conceivably reach the network
 *     while the suite believes it is sending to a fake.
 *  2. `resetSesAdapter()` must clear both the override *and* the memoised
 *     production adapter, so state cannot leak between tests in either
 *     direction.
 *
 * `src/lib/ses/aws.ts` is mocked with a factory, so its real body is never
 * evaluated and this file asserts nothing about the AWS SDK.
 */

const awsModule = vi.hoisted(() => ({
  /** Times the AWS module itself was imported. */
  evaluations: 0,
  /** Times a production adapter was constructed. */
  constructions: 0,
}));

vi.mock('@/lib/ses/aws', () => {
  awsModule.evaluations += 1;
  return {
    createAwsSesAdapter: () => {
      awsModule.constructions += 1;
      const tag = `aws-adapter-${awsModule.constructions}`;
      return {
        tag,
        sendBulk: async () => [],
        sendSimple: async () => ({ messageId: `${tag}-message` }),
        isIdentityVerified: async () => false,
      };
    },
  };
});

function makeOverride(tag: string): SesAdapter & { tag: string } {
  return {
    tag,
    sendBulk: async () => [],
    sendSimple: async () => ({ messageId: `${tag}-message` }),
    isIdentityVerified: async () => true,
  };
}

beforeEach(() => {
  resetSesAdapter();
});

afterEach(() => {
  resetSesAdapter();
});

describe('getSesAdapter with an override installed', () => {
  // Deliberately the first test in the file: `awsModule.evaluations` can only
  // still be 0 if nothing has imported the AWS module yet.
  it('returns the override without ever importing the AWS module', async () => {
    const override = makeOverride('injected');
    setSesAdapter(override);

    expect(await getSesAdapter()).toBe(override);
    expect(await getSesAdapter()).toBe(override);
    expect(await getSesAdapter()).toBe(override);

    expect(awsModule.evaluations).toBe(0);
    expect(awsModule.constructions).toBe(0);
  });

  it('returns the very object that was installed, not a wrapper', async () => {
    const fake = new FakeSes();
    setSesAdapter(fake);

    const resolved = await getSesAdapter();
    expect(resolved).toBe(fake);

    // A wrapper or copy would leave the caller's fake with no record of this.
    await resolved.sendSimple({
      fromName: 'Domain A',
      fromEmail: 'hello@news.domain-a.com',
      to: 'bob@example.com',
      content: { subject: 's', html: '<p>h</p>', text: 't' },
    });
    expect(fake.simpleSends).toHaveLength(1);
    expect(fake.simpleSends[0].to).toBe('bob@example.com');
  });

  it('lets a later setSesAdapter replace an earlier override', async () => {
    const first = makeOverride('first');
    const second = makeOverride('second');
    setSesAdapter(first);
    setSesAdapter(second);

    expect(await getSesAdapter()).toBe(second);
  });

  it('wins over an already-memoised production adapter', async () => {
    const production = await getSesAdapter();
    expect(awsModule.constructions).toBeGreaterThan(0);

    const override = makeOverride('takes-over');
    setSesAdapter(override);

    expect(await getSesAdapter()).toBe(override);
    expect(await getSesAdapter()).not.toBe(production);
  });

  it('constructs nothing new while an override is in force', async () => {
    setSesAdapter(makeOverride('installed'));
    const before = awsModule.constructions;

    await getSesAdapter();
    await getSesAdapter();

    expect(awsModule.constructions).toBe(before);
  });
});

describe('getSesAdapter with no override', () => {
  it('constructs the production adapter lazily and memoises it', async () => {
    const before = awsModule.constructions;

    const first = await getSesAdapter();
    const second = await getSesAdapter();

    expect(first).toBe(second);
    expect(awsModule.constructions).toBe(before + 1);
  });

  it('hands back an object satisfying the whole SesAdapter surface', async () => {
    const adapter = await getSesAdapter();

    expect(typeof adapter.sendBulk).toBe('function');
    expect(typeof adapter.sendSimple).toBe('function');
    expect(typeof adapter.isIdentityVerified).toBe('function');
  });

  it('keeps serving the memoised adapter across many requests', async () => {
    // The send loop resolves an adapter on every batch; the module must not be
    // re-imported or the adapter re-built each time.
    const before = awsModule.constructions;
    const first = await getSesAdapter();

    for (let i = 0; i < 5; i += 1) {
      expect(await getSesAdapter()).toBe(first);
    }

    expect(awsModule.constructions).toBe(before + 1);
  });
});

describe('setSesAdapter(undefined)', () => {
  it('clears the override and falls back to the production adapter', async () => {
    const production = await getSesAdapter();
    setSesAdapter(makeOverride('temporary'));
    expect(await getSesAdapter()).not.toBe(production);

    setSesAdapter(undefined);

    expect(await getSesAdapter()).toBe(production);
  });

  it('does not discard the memoised production adapter', async () => {
    const production = await getSesAdapter();
    const constructionsAfterFirst = awsModule.constructions;

    setSesAdapter(makeOverride('temporary'));
    setSesAdapter(undefined);

    expect(await getSesAdapter()).toBe(production);
    expect(awsModule.constructions).toBe(constructionsAfterFirst);
  });
});

describe('resetSesAdapter', () => {
  it('clears the override', async () => {
    const override = makeOverride('leaked');
    setSesAdapter(override);

    resetSesAdapter();

    expect(await getSesAdapter()).not.toBe(override);
  });

  it('forgets the memoised production adapter so the next call rebuilds it', async () => {
    const before = awsModule.constructions;
    const first = await getSesAdapter();

    resetSesAdapter();
    const second = await getSesAdapter();

    expect(second).not.toBe(first);
    expect(awsModule.constructions).toBe(before + 2);
  });

  it('clears both at once, leaving no trace of either', async () => {
    // Memoise the production adapter, then shadow it with an override.
    const production = await getSesAdapter();
    const override = makeOverride('shadow');
    setSesAdapter(override);
    expect(await getSesAdapter()).toBe(override);

    resetSesAdapter();

    const afterReset = await getSesAdapter();
    expect(afterReset).not.toBe(override);
    expect(afterReset).not.toBe(production);
  });

  it('is safe to call repeatedly, including before anything was ever set', async () => {
    resetSesAdapter();
    resetSesAdapter();
    resetSesAdapter();

    const adapter = await getSesAdapter();
    expect(typeof adapter.sendBulk).toBe('function');
  });

  it('restores the ability to install a fresh override afterwards', async () => {
    setSesAdapter(makeOverride('one'));
    resetSesAdapter();

    const next = makeOverride('two');
    setSesAdapter(next);

    expect(await getSesAdapter()).toBe(next);
  });
});
