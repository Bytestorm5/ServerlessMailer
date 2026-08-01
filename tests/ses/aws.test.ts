import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAwsSesAdapter } from '@/lib/ses/aws';
import { SesThrottlingError } from '@/lib/ses/types';
import type { SendBulkParams, SendSimpleParams } from '@/lib/ses/types';

/**
 * The AWS SDK is deliberately NOT imported here. The adapter is the only place
 * allowed to touch it (§ CONTRACTS ground rules), so these tests inspect the
 * commands structurally — by constructor name and `.input` — which is also the
 * shape the SDK serialises onto the wire.
 */

interface MessageHeaderShape {
  Name?: string;
  Value?: string;
}

interface BulkEntryShape {
  Destination?: { ToAddresses?: string[] };
  ReplacementEmailContent?: { ReplacementTemplate?: { ReplacementTemplateData?: string } };
  ReplacementHeaders?: MessageHeaderShape[];
}

interface BulkInputShape {
  FromEmailAddress?: string;
  ReplyToAddresses?: string[];
  ConfigurationSetName?: string;
  DefaultContent?: {
    Template?: {
      TemplateName?: string;
      TemplateArn?: string;
      TemplateContent?: { Subject?: string; Html?: string; Text?: string };
      TemplateData?: string;
    };
  };
  BulkEmailEntries?: BulkEntryShape[];
}

interface SimpleInputShape {
  FromEmailAddress?: string;
  ReplyToAddresses?: string[];
  ConfigurationSetName?: string;
  Destination?: { ToAddresses?: string[] };
  Content?: {
    Simple?: {
      Subject?: { Data?: string; Charset?: string };
      Body?: {
        Html?: { Data?: string; Charset?: string };
        Text?: { Data?: string; Charset?: string };
      };
      Headers?: MessageHeaderShape[];
    };
    Template?: unknown;
    Raw?: unknown;
  };
}

interface IdentityInputShape {
  EmailIdentity?: string;
}

interface CapturedCommand {
  name: string;
  input: Record<string, unknown>;
}

interface Stub {
  client: never;
  commands: CapturedCommand[];
  /** Convenience: the input of the nth captured command. */
  input<T>(index?: number): T;
}

type Handler = (command: CapturedCommand) => unknown;

/**
 * Minimal stand-in for SESv2Client. Only `send` is ever used by the adapter; if
 * the adapter reached for anything else this would blow up loudly, which is the
 * point — no network, ever.
 */
function stubClient(handler: Handler): Stub {
  const commands: CapturedCommand[] = [];
  const client = {
    send: async (command: { input: Record<string, unknown> }) => {
      const captured: CapturedCommand = {
        name: command.constructor.name,
        input: command.input,
      };
      commands.push(captured);
      return handler(captured);
    },
  };
  return {
    // The adapter's parameter is typed as SESv2Client; the double cast keeps the
    // test honest about the fact that only `send` is exercised.
    client: client as unknown as never,
    commands,
    input<T>(index = 0): T {
      return commands[index].input as T;
    },
  };
}

/** An error shaped the way the AWS SDK shapes service exceptions. */
class ServiceError extends Error {
  readonly $fault = 'client';
  code?: string;
  constructor(name: string, message: string, code?: string) {
    super(message);
    this.name = name;
    if (code !== undefined) this.code = code;
  }
}

function bulkParams(overrides: Partial<SendBulkParams> = {}): SendBulkParams {
  return {
    fromName: 'Domain A',
    fromEmail: 'hello@news.domain-a.com',
    replyTo: 'hello@domain-a.com',
    configurationSet: 'domain-a-events',
    content: {
      subject: 'Weekly {{first_name}}',
      html: '<p>Hello {{first_name}}</p>',
      text: 'Hello {{first_name}}',
    },
    destinations: [
      {
        email: 'alice@example.com',
        replacements: { first_name: 'Alice', unsubscribe_url: 'https://mail.example.com/u/a' },
        headers: {
          'List-Unsubscribe': '<https://mail.example.com/u/a>',
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      },
      {
        email: 'bob@example.com',
        replacements: { first_name: 'Bob', unsubscribe_url: 'https://mail.example.com/u/b' },
        headers: { 'List-Unsubscribe': '<https://mail.example.com/u/b>' },
      },
    ],
    ...overrides,
  };
}

function simpleParams(overrides: Partial<SendSimpleParams> = {}): SendSimpleParams {
  return {
    fromName: 'Domain A',
    fromEmail: 'hello@news.domain-a.com',
    replyTo: 'hello@domain-a.com',
    to: 'new@example.com',
    configurationSet: 'domain-a-events',
    content: {
      subject: 'Confirm your subscription',
      html: '<p>Confirm</p>',
      text: 'Confirm',
    },
    ...overrides,
  };
}

function successResults(count: number) {
  return {
    BulkEmailEntryResults: Array.from({ length: count }, (_unused, i) => ({
      Status: 'SUCCESS',
      MessageId: `ses-${i}`,
    })),
  };
}

describe('createAwsSesAdapter', () => {
  it('returns an object satisfying the SesAdapter interface', () => {
    const adapter = createAwsSesAdapter(stubClient(() => successResults(0)).client);
    expect(typeof adapter.sendBulk).toBe('function');
    expect(typeof adapter.sendSimple).toBe('function');
    expect(typeof adapter.isIdentityVerified).toBe('function');
  });

  it('can be constructed with no client at all (registry calls it that way)', () => {
    // Must not throw and must not touch the network at construction time —
    // src/lib/ses/registry.ts memoises exactly this call.
    const adapter = createAwsSesAdapter();
    expect(typeof adapter.sendBulk).toBe('function');
  });

  it('reuses the injected client across calls', async () => {
    const stub = stubClient(() => successResults(2));
    const adapter = createAwsSesAdapter(stub.client);
    await adapter.sendBulk(bulkParams());
    await adapter.sendBulk(bulkParams());
    expect(stub.commands).toHaveLength(2);
  });

  it('answers an empty batch without ever building a client', async () => {
    // No injected client and no network: the short-circuit has to happen before
    // the SDK client is constructed.
    const results = await createAwsSesAdapter().sendBulk(bulkParams({ destinations: [] }));
    expect(results).toEqual([]);
  });

  it('answers an empty identity without ever building a client', async () => {
    expect(await createAwsSesAdapter().isIdentityVerified('')).toBe(false);
  });
});

describe('default client construction', () => {
  afterEach(() => {
    vi.doUnmock('@aws-sdk/client-sesv2');
    vi.resetModules();
  });

  it('builds one SESv2Client in the configured region, lazily, and reuses it', async () => {
    const constructed: unknown[] = [];
    const send = vi.fn().mockResolvedValue({ MessageId: 'lazy-1' });

    vi.doMock('@aws-sdk/client-sesv2', () => ({
      SESv2Client: class {
        send = send;
        constructor(cfg: unknown) {
          constructed.push(cfg);
        }
      },
      SendBulkEmailCommand: class {
        constructor(readonly input: unknown) {}
      },
      SendEmailCommand: class {
        constructor(readonly input: unknown) {}
      },
      GetEmailIdentityCommand: class {
        constructor(readonly input: unknown) {}
      },
    }));
    vi.resetModules();

    const { createAwsSesAdapter: freshFactory } = await import('@/lib/ses/aws');
    const adapter = freshFactory();

    // Nothing constructed until the first call that actually needs the client.
    expect(constructed).toHaveLength(0);

    await adapter.sendSimple(simpleParams());
    await adapter.sendSimple(simpleParams());

    expect(constructed).toEqual([{ region: 'us-east-1' }]);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('sendBulk — command shape', () => {
  it('issues exactly one SendBulkEmailCommand', async () => {
    const stub = stubClient(() => successResults(2));
    await createAwsSesAdapter(stub.client).sendBulk(bulkParams());

    expect(stub.commands).toHaveLength(1);
    expect(stub.commands[0].name).toBe('SendBulkEmailCommand');
  });

  it('formats FromEmailAddress as "Name <email>"', async () => {
    const stub = stubClient(() => successResults(2));
    await createAwsSesAdapter(stub.client).sendBulk(bulkParams());

    expect(stub.input<BulkInputShape>().FromEmailAddress).toBe(
      'Domain A <hello@news.domain-a.com>',
    );
  });

  it('falls back to the bare address when the from name is blank', async () => {
    const stub = stubClient(() => successResults(2));
    await createAwsSesAdapter(stub.client).sendBulk(bulkParams({ fromName: '   ' }));

    expect(stub.input<BulkInputShape>().FromEmailAddress).toBe('hello@news.domain-a.com');
  });

  it('quotes a display name containing RFC 5322 specials', async () => {
    const stub = stubClient(() => successResults(2));
    await createAwsSesAdapter(stub.client).sendBulk(bulkParams({ fromName: 'Acme, Inc.' }));

    expect(stub.input<BulkInputShape>().FromEmailAddress).toBe(
      '"Acme, Inc." <hello@news.domain-a.com>',
    );
  });

  it('escapes quotes and backslashes inside a quoted display name', async () => {
    const stub = stubClient(() => successResults(2));
    await createAwsSesAdapter(stub.client).sendBulk(
      bulkParams({ fromName: 'He said "hi" \\ bye' }),
    );

    expect(stub.input<BulkInputShape>().FromEmailAddress).toBe(
      '"He said \\"hi\\" \\\\ bye" <hello@news.domain-a.com>',
    );
  });

  it('strips CR/LF from the display name (header injection)', async () => {
    const stub = stubClient(() => successResults(2));
    await createAwsSesAdapter(stub.client).sendBulk(
      bulkParams({ fromName: 'Evil\r\nBcc: victim@example.com' }),
    );

    const from = stub.input<BulkInputShape>().FromEmailAddress ?? '';
    expect(from).not.toMatch(/[\r\n]/);
  });

  it('trims the from address itself', async () => {
    const stub = stubClient(() => successResults(2));
    await createAwsSesAdapter(stub.client).sendBulk(
      bulkParams({ fromName: '', fromEmail: '  hello@news.domain-a.com \n' }),
    );

    expect(stub.input<BulkInputShape>().FromEmailAddress).toBe('hello@news.domain-a.com');
  });

  it('sets ReplyToAddresses from replyTo', async () => {
    const stub = stubClient(() => successResults(2));
    await createAwsSesAdapter(stub.client).sendBulk(bulkParams());

    expect(stub.input<BulkInputShape>().ReplyToAddresses).toEqual(['hello@domain-a.com']);
  });

  it('omits ReplyToAddresses when replyTo is empty', async () => {
    const stub = stubClient(() => successResults(2));
    await createAwsSesAdapter(stub.client).sendBulk(bulkParams({ replyTo: '' }));

    expect(stub.input<BulkInputShape>().ReplyToAddresses).toBeUndefined();
  });

  it('passes ConfigurationSetName through', async () => {
    const stub = stubClient(() => successResults(2));
    await createAwsSesAdapter(stub.client).sendBulk(bulkParams());

    expect(stub.input<BulkInputShape>().ConfigurationSetName).toBe('domain-a-events');
  });

  it('omits ConfigurationSetName when the list has none', async () => {
    const stub = stubClient(() => successResults(2));
    await createAwsSesAdapter(stub.client).sendBulk(bulkParams({ configurationSet: undefined }));

    expect(stub.input<BulkInputShape>()).not.toHaveProperty('ConfigurationSetName');
  });

  it('omits ConfigurationSetName when it is an empty string', async () => {
    const stub = stubClient(() => successResults(2));
    await createAwsSesAdapter(stub.client).sendBulk(bulkParams({ configurationSet: '' }));

    expect(stub.input<BulkInputShape>().ConfigurationSetName).toBeUndefined();
  });

  it('uses an INLINE TemplateContent — never a stored SES template', async () => {
    const stub = stubClient(() => successResults(2));
    await createAwsSesAdapter(stub.client).sendBulk(bulkParams());

    const template = stub.input<BulkInputShape>().DefaultContent?.Template;
    expect(template?.TemplateContent).toEqual({
      Subject: 'Weekly {{first_name}}',
      Html: '<p>Hello {{first_name}}</p>',
      Text: 'Hello {{first_name}}',
    });
    expect(template?.TemplateName).toBeUndefined();
    expect(template?.TemplateArn).toBeUndefined();
  });

  it('supplies default TemplateData as valid JSON', async () => {
    const stub = stubClient(() => successResults(2));
    await createAwsSesAdapter(stub.client).sendBulk(bulkParams());

    const data = stub.input<BulkInputShape>().DefaultContent?.Template?.TemplateData;
    expect(typeof data).toBe('string');
    expect(JSON.parse(data as string)).toEqual({});
  });

  it('builds one BulkEmailEntry per destination, in order', async () => {
    const stub = stubClient(() => successResults(2));
    await createAwsSesAdapter(stub.client).sendBulk(bulkParams());

    const entries = stub.input<BulkInputShape>().BulkEmailEntries ?? [];
    expect(entries).toHaveLength(2);
    expect(entries[0].Destination?.ToAddresses).toEqual(['alice@example.com']);
    expect(entries[1].Destination?.ToAddresses).toEqual(['bob@example.com']);
  });

  it('serialises each recipient’s replacements into ReplacementTemplateData', async () => {
    const stub = stubClient(() => successResults(2));
    await createAwsSesAdapter(stub.client).sendBulk(bulkParams());

    const entries = stub.input<BulkInputShape>().BulkEmailEntries ?? [];
    const first = entries[0].ReplacementEmailContent?.ReplacementTemplate
      ?.ReplacementTemplateData;
    expect(JSON.parse(first as string)).toEqual({
      first_name: 'Alice',
      unsubscribe_url: 'https://mail.example.com/u/a',
    });

    const second = entries[1].ReplacementEmailContent?.ReplacementTemplate
      ?.ReplacementTemplateData;
    expect(JSON.parse(second as string)).toEqual({
      first_name: 'Bob',
      unsubscribe_url: 'https://mail.example.com/u/b',
    });
  });

  it('sends "{}" for a recipient with no replacements', async () => {
    const stub = stubClient(() => successResults(1));
    await createAwsSesAdapter(stub.client).sendBulk(
      bulkParams({
        destinations: [{ email: 'plain@example.com', replacements: {}, headers: {} }],
      }),
    );

    const entries = stub.input<BulkInputShape>().BulkEmailEntries ?? [];
    expect(
      entries[0].ReplacementEmailContent?.ReplacementTemplate?.ReplacementTemplateData,
    ).toBe('{}');
  });

  it('delivers per-recipient headers as ReplacementHeaders (§9.1)', async () => {
    const stub = stubClient(() => successResults(2));
    await createAwsSesAdapter(stub.client).sendBulk(bulkParams());

    const entries = stub.input<BulkInputShape>().BulkEmailEntries ?? [];
    expect(entries[0].ReplacementHeaders).toEqual([
      { Name: 'List-Unsubscribe', Value: '<https://mail.example.com/u/a>' },
      { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
    ]);
    expect(entries[1].ReplacementHeaders).toEqual([
      { Name: 'List-Unsubscribe', Value: '<https://mail.example.com/u/b>' },
    ]);
  });

  it('omits ReplacementHeaders when a recipient has none', async () => {
    const stub = stubClient(() => successResults(1));
    await createAwsSesAdapter(stub.client).sendBulk(
      bulkParams({
        destinations: [{ email: 'plain@example.com', replacements: {}, headers: {} }],
      }),
    );

    const entries = stub.input<BulkInputShape>().BulkEmailEntries ?? [];
    expect(entries[0].ReplacementHeaders).toBeUndefined();
  });

  it('folds CR/LF out of header values (header injection)', async () => {
    const stub = stubClient(() => successResults(1));
    await createAwsSesAdapter(stub.client).sendBulk(
      bulkParams({
        destinations: [
          {
            email: 'plain@example.com',
            replacements: {},
            headers: {
              'List-Unsubscribe': '<https://x.test/u>\r\nBcc: victim@example.com',
            },
          },
        ],
      }),
    );

    const entries = stub.input<BulkInputShape>().BulkEmailEntries ?? [];
    const value = entries[0].ReplacementHeaders?.[0].Value ?? '';
    expect(value).not.toMatch(/[\r\n]/);
    expect(value).toBe('<https://x.test/u> Bcc: victim@example.com');
  });

  it('drops headers whose name is not a legal field name', async () => {
    const stub = stubClient(() => successResults(1));
    await createAwsSesAdapter(stub.client).sendBulk(
      bulkParams({
        destinations: [
          {
            email: 'plain@example.com',
            replacements: {},
            headers: {
              'Bad\r\nName': 'x',
              'Has: Colon': 'x',
              'Has Space': 'x',
              '': 'x',
              'List-Unsubscribe': '<https://x.test/u>',
            },
          },
        ],
      }),
    );

    const entries = stub.input<BulkInputShape>().BulkEmailEntries ?? [];
    expect(entries[0].ReplacementHeaders).toEqual([
      { Name: 'List-Unsubscribe', Value: '<https://x.test/u>' },
    ]);
  });

  it('drops headers whose value is empty after sanitising', async () => {
    const stub = stubClient(() => successResults(1));
    await createAwsSesAdapter(stub.client).sendBulk(
      bulkParams({
        destinations: [
          {
            email: 'plain@example.com',
            replacements: {},
            headers: { 'X-Empty': '   ', 'X-Newlines': '\r\n' },
          },
        ],
      }),
    );

    const entries = stub.input<BulkInputShape>().BulkEmailEntries ?? [];
    expect(entries[0].ReplacementHeaders).toBeUndefined();
  });

  it('tolerates a null header value from a careless caller', async () => {
    const stub = stubClient(() => successResults(1));
    await createAwsSesAdapter(stub.client).sendBulk(
      bulkParams({
        destinations: [
          {
            email: 'plain@example.com',
            replacements: {},
            headers: { 'X-Null': null } as unknown as Record<string, string>,
          },
        ],
      }),
    );

    const entries = stub.input<BulkInputShape>().BulkEmailEntries ?? [];
    expect(entries[0].ReplacementHeaders).toBeUndefined();
  });

  it('tolerates a destination with no replacements object at all', async () => {
    const stub = stubClient(() => successResults(1));
    await createAwsSesAdapter(stub.client).sendBulk(
      bulkParams({
        destinations: [
          { email: 'plain@example.com', headers: {} } as unknown as SendBulkParams['destinations'][number],
        ],
      }),
    );

    const entries = stub.input<BulkInputShape>().BulkEmailEntries ?? [];
    expect(
      entries[0].ReplacementEmailContent?.ReplacementTemplate?.ReplacementTemplateData,
    ).toBe('{}');
  });

  it('carries a full 50-destination batch in a single call', async () => {
    const destinations = Array.from({ length: 50 }, (_unused, i) => ({
      email: `user${i}@example.com`,
      replacements: { first_name: `User ${i}` },
      headers: { 'List-Unsubscribe': `<https://x.test/u/${i}>` },
    }));
    const stub = stubClient(() => successResults(50));

    const results = await createAwsSesAdapter(stub.client).sendBulk(
      bulkParams({ destinations }),
    );

    expect(stub.commands).toHaveLength(1);
    expect(stub.input<BulkInputShape>().BulkEmailEntries).toHaveLength(50);
    expect(results).toHaveLength(50);
  });
});

describe('sendBulk — result mapping', () => {
  it('maps SUCCESS results positionally back onto the destinations', async () => {
    const stub = stubClient(() => ({
      BulkEmailEntryResults: [
        { Status: 'SUCCESS', MessageId: 'id-alice' },
        { Status: 'SUCCESS', MessageId: 'id-bob' },
      ],
    }));

    const results = await createAwsSesAdapter(stub.client).sendBulk(bulkParams());

    expect(results).toEqual([
      { email: 'alice@example.com', status: 'success', messageId: 'id-alice' },
      { email: 'bob@example.com', status: 'success', messageId: 'id-bob' },
    ]);
  });

  it('is positional, not order-guessing: the second result belongs to the second address', async () => {
    const stub = stubClient(() => ({
      BulkEmailEntryResults: [
        { Status: 'MESSAGE_REJECTED', Error: 'rejected' },
        { Status: 'SUCCESS', MessageId: 'id-bob' },
      ],
    }));

    const results = await createAwsSesAdapter(stub.client).sendBulk(bulkParams());

    expect(results[0]).toMatchObject({ email: 'alice@example.com', status: 'failed' });
    expect(results[1]).toMatchObject({
      email: 'bob@example.com',
      status: 'success',
      messageId: 'id-bob',
    });
  });

  it('treats every non-SUCCESS status as a per-destination failure', async () => {
    const statuses = [
      'MESSAGE_REJECTED',
      'FAILED',
      'INVALID_PARAMETER',
      'ACCOUNT_THROTTLED',
      'TEMPLATE_NOT_FOUND',
      'TRANSIENT_FAILURE',
      'ACCOUNT_SUSPENDED',
    ];
    const stub = stubClient(() => ({
      BulkEmailEntryResults: statuses.map((Status) => ({ Status })),
    }));

    const results = await createAwsSesAdapter(stub.client).sendBulk(
      bulkParams({
        destinations: statuses.map((s, i) => ({
          email: `user${i}@example.com`,
          replacements: {},
          headers: {},
        })),
      }),
    );

    expect(results.every((r) => r.status === 'failed')).toBe(true);
    expect(results.map((r) => r.error)).toEqual(statuses);
  });

  it('prefers the Error string over the Status when SES supplies one', async () => {
    const stub = stubClient(() => ({
      BulkEmailEntryResults: [
        { Status: 'MESSAGE_REJECTED', Error: 'Email address is not verified' },
        { Status: 'SUCCESS', MessageId: 'id-bob' },
      ],
    }));

    const results = await createAwsSesAdapter(stub.client).sendBulk(bulkParams());
    expect(results[0].error).toBe('Email address is not verified');
  });

  it('reports a generic error when both Status and Error are missing', async () => {
    const stub = stubClient(() => ({ BulkEmailEntryResults: [{}, {}] }));

    const results = await createAwsSesAdapter(stub.client).sendBulk(bulkParams());

    expect(results.map((r) => r.status)).toEqual(['failed', 'failed']);
    expect(results[0].error).toBeTruthy();
  });

  it('never reports a messageId on a failure', async () => {
    const stub = stubClient(() => ({
      BulkEmailEntryResults: [
        { Status: 'MESSAGE_REJECTED', Error: 'nope', MessageId: 'leaked' },
        { Status: 'SUCCESS', MessageId: 'id-bob' },
      ],
    }));

    const results = await createAwsSesAdapter(stub.client).sendBulk(bulkParams());
    expect(results[0].messageId).toBeUndefined();
  });

  it('accepts a SUCCESS with no MessageId without inventing one', async () => {
    const stub = stubClient(() => ({
      BulkEmailEntryResults: [{ Status: 'SUCCESS' }, { Status: 'SUCCESS', MessageId: 'id-bob' }],
    }));

    const results = await createAwsSesAdapter(stub.client).sendBulk(bulkParams());

    expect(results[0]).toEqual({ email: 'alice@example.com', status: 'success' });
  });

  it('reports per-destination failures when BulkEmailEntryResults is missing entirely', async () => {
    const stub = stubClient(() => ({}));

    const results = await createAwsSesAdapter(stub.client).sendBulk(bulkParams());

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 'failed')).toBe(true);
    expect(results.map((r) => r.email)).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('does not throw when the whole response is undefined', async () => {
    const stub = stubClient(() => undefined);

    const results = await createAwsSesAdapter(stub.client).sendBulk(bulkParams());

    expect(results.every((r) => r.status === 'failed')).toBe(true);
  });

  it('reports the tail as failures when the results array is short', async () => {
    const stub = stubClient(() => ({
      BulkEmailEntryResults: [{ Status: 'SUCCESS', MessageId: 'id-alice' }],
    }));

    const results = await createAwsSesAdapter(stub.client).sendBulk(bulkParams());

    expect(results[0]).toEqual({
      email: 'alice@example.com',
      status: 'success',
      messageId: 'id-alice',
    });
    expect(results[1]).toMatchObject({ email: 'bob@example.com', status: 'failed' });
    expect(results[1].error).toBeTruthy();
  });

  it('ignores surplus results rather than inventing destinations', async () => {
    const stub = stubClient(() => successResults(5));

    const results = await createAwsSesAdapter(stub.client).sendBulk(bulkParams());

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.email)).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('tolerates a null entry inside the results array', async () => {
    const stub = stubClient(() => ({
      BulkEmailEntryResults: [null, { Status: 'SUCCESS', MessageId: 'id-bob' }],
    }));

    const results = await createAwsSesAdapter(stub.client).sendBulk(bulkParams());

    expect(results[0].status).toBe('failed');
    expect(results[1].status).toBe('success');
  });

  it('short-circuits an empty destination list without calling SES', async () => {
    const stub = stubClient(() => {
      throw new Error('SES must not be called for an empty batch');
    });

    const results = await createAwsSesAdapter(stub.client).sendBulk(
      bulkParams({ destinations: [] }),
    );

    expect(results).toEqual([]);
    expect(stub.commands).toHaveLength(0);
  });
});

describe('sendBulk — throttling (§7.5)', () => {
  const throttlers: Array<[string, unknown]> = [
    ['TooManyRequestsException', new ServiceError('TooManyRequestsException', 'slow down')],
    ['ThrottlingException', new ServiceError('ThrottlingException', 'Rate exceeded')],
    ['Throttling', new ServiceError('Throttling', 'Maximum sending rate exceeded')],
    [
      'legacy code property',
      new ServiceError('ServiceUnavailable', 'something', 'Throttling'),
    ],
    [
      'message only',
      new ServiceError('SomeOtherError', 'Maximum sending rate exceeded'),
    ],
    ['already-typed SesThrottlingError', new SesThrottlingError('already typed')],
  ];

  for (const [label, error] of throttlers) {
    it(`rethrows ${label} as SesThrottlingError`, async () => {
      const stub = stubClient(() => {
        throw error;
      });

      await expect(createAwsSesAdapter(stub.client).sendBulk(bulkParams())).rejects.toThrow(
        SesThrottlingError,
      );
    });
  }

  it('the thrown error carries the throttled marker the pipeline keys off', async () => {
    const stub = stubClient(() => {
      throw new ServiceError('TooManyRequestsException', 'Maximum sending rate exceeded');
    });

    await expect(
      createAwsSesAdapter(stub.client).sendBulk(bulkParams()),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof SesThrottlingError &&
        err.throttled === true &&
        err.name === 'SesThrottlingError'
      );
    });
  });

  it('preserves the original SES message on the throttling error', async () => {
    const stub = stubClient(() => {
      throw new ServiceError('TooManyRequestsException', 'Maximum sending rate exceeded');
    });

    await expect(createAwsSesAdapter(stub.client).sendBulk(bulkParams())).rejects.toThrow(
      /Maximum sending rate exceeded/,
    );
  });

  it('rethrows a non-throttling error unchanged', async () => {
    const boom = new ServiceError('BadRequestException', 'Missing required parameter');
    const stub = stubClient(() => {
      throw boom;
    });

    await expect(createAwsSesAdapter(stub.client).sendBulk(bulkParams())).rejects.toBe(boom);
  });

  it('recognises throttling on a rejection that is not an Error instance', async () => {
    const stub = stubClient(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw { name: 'ThrottlingException', message: 'Rate exceeded' };
    });

    await expect(createAwsSesAdapter(stub.client).sendBulk(bulkParams())).rejects.toThrow(
      SesThrottlingError,
    );
  });

  it('rethrows a non-Error rejection unchanged', async () => {
    const stub = stubClient(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'string failure';
    });

    await expect(createAwsSesAdapter(stub.client).sendBulk(bulkParams())).rejects.toBe(
      'string failure',
    );
  });
});

describe('sendSimple', () => {
  it('issues a SendEmailCommand with Simple content', async () => {
    const stub = stubClient(() => ({ MessageId: 'simple-1' }));

    const result = await createAwsSesAdapter(stub.client).sendSimple(simpleParams());

    expect(stub.commands).toHaveLength(1);
    expect(stub.commands[0].name).toBe('SendEmailCommand');
    expect(result).toEqual({ messageId: 'simple-1' });
  });

  it('puts subject, html and text into Content.Simple with a UTF-8 charset', async () => {
    const stub = stubClient(() => ({ MessageId: 'simple-1' }));
    await createAwsSesAdapter(stub.client).sendSimple(simpleParams());

    const simple = stub.input<SimpleInputShape>().Content?.Simple;
    expect(simple?.Subject).toEqual({ Data: 'Confirm your subscription', Charset: 'UTF-8' });
    expect(simple?.Body?.Html).toEqual({ Data: '<p>Confirm</p>', Charset: 'UTF-8' });
    expect(simple?.Body?.Text).toEqual({ Data: 'Confirm', Charset: 'UTF-8' });
  });

  it('never uses a template or raw content for a simple send', async () => {
    const stub = stubClient(() => ({ MessageId: 'simple-1' }));
    await createAwsSesAdapter(stub.client).sendSimple(simpleParams());

    const content = stub.input<SimpleInputShape>().Content;
    expect(content?.Template).toBeUndefined();
    expect(content?.Raw).toBeUndefined();
  });

  it('addresses exactly one recipient', async () => {
    const stub = stubClient(() => ({ MessageId: 'simple-1' }));
    await createAwsSesAdapter(stub.client).sendSimple(simpleParams());

    expect(stub.input<SimpleInputShape>().Destination?.ToAddresses).toEqual([
      'new@example.com',
    ]);
  });

  it('formats the from address and passes the configuration set', async () => {
    const stub = stubClient(() => ({ MessageId: 'simple-1' }));
    await createAwsSesAdapter(stub.client).sendSimple(simpleParams());

    const input = stub.input<SimpleInputShape>();
    expect(input.FromEmailAddress).toBe('Domain A <hello@news.domain-a.com>');
    expect(input.ConfigurationSetName).toBe('domain-a-events');
    expect(input.ReplyToAddresses).toEqual(['hello@domain-a.com']);
  });

  it('omits ReplyToAddresses when replyTo is not supplied', async () => {
    const stub = stubClient(() => ({ MessageId: 'simple-1' }));
    await createAwsSesAdapter(stub.client).sendSimple(simpleParams({ replyTo: undefined }));

    expect(stub.input<SimpleInputShape>().ReplyToAddresses).toBeUndefined();
  });

  it('omits ConfigurationSetName when not supplied', async () => {
    const stub = stubClient(() => ({ MessageId: 'simple-1' }));
    await createAwsSesAdapter(stub.client).sendSimple(
      simpleParams({ configurationSet: undefined }),
    );

    expect(stub.input<SimpleInputShape>().ConfigurationSetName).toBeUndefined();
  });

  it('passes optional headers through as MessageHeader entries', async () => {
    const stub = stubClient(() => ({ MessageId: 'simple-1' }));
    await createAwsSesAdapter(stub.client).sendSimple(
      simpleParams({
        headers: { 'List-Unsubscribe': '<https://x.test/u>', 'X-Kind': 'transactional' },
      }),
    );

    expect(stub.input<SimpleInputShape>().Content?.Simple?.Headers).toEqual([
      { Name: 'List-Unsubscribe', Value: '<https://x.test/u>' },
      { Name: 'X-Kind', Value: 'transactional' },
    ]);
  });

  it('omits Headers when none are supplied', async () => {
    const stub = stubClient(() => ({ MessageId: 'simple-1' }));
    await createAwsSesAdapter(stub.client).sendSimple(simpleParams());

    expect(stub.input<SimpleInputShape>().Content?.Simple?.Headers).toBeUndefined();
  });

  it('omits Headers when the supplied map is empty', async () => {
    const stub = stubClient(() => ({ MessageId: 'simple-1' }));
    await createAwsSesAdapter(stub.client).sendSimple(simpleParams({ headers: {} }));

    expect(stub.input<SimpleInputShape>().Content?.Simple?.Headers).toBeUndefined();
  });

  it('sanitises header values on the simple path too', async () => {
    const stub = stubClient(() => ({ MessageId: 'simple-1' }));
    await createAwsSesAdapter(stub.client).sendSimple(
      simpleParams({ headers: { 'X-Kind': 'a\r\nBcc: victim@example.com' } }),
    );

    const value = stub.input<SimpleInputShape>().Content?.Simple?.Headers?.[0].Value ?? '';
    expect(value).not.toMatch(/[\r\n]/);
  });

  it('returns an empty messageId rather than undefined when SES omits it', async () => {
    const stub = stubClient(() => ({}));

    const result = await createAwsSesAdapter(stub.client).sendSimple(simpleParams());

    expect(result).toEqual({ messageId: '' });
  });

  it('survives an undefined response', async () => {
    const stub = stubClient(() => undefined);

    const result = await createAwsSesAdapter(stub.client).sendSimple(simpleParams());

    expect(result).toEqual({ messageId: '' });
  });

  it('translates throttling into SesThrottlingError', async () => {
    const stub = stubClient(() => {
      throw new ServiceError('TooManyRequestsException', 'Maximum sending rate exceeded');
    });

    await expect(
      createAwsSesAdapter(stub.client).sendSimple(simpleParams()),
    ).rejects.toThrow(SesThrottlingError);
  });

  it('rethrows a rejection (MessageRejected) unchanged', async () => {
    const boom = new ServiceError('MessageRejected', 'Email address is not verified');
    const stub = stubClient(() => {
      throw boom;
    });

    await expect(createAwsSesAdapter(stub.client).sendSimple(simpleParams())).rejects.toBe(
      boom,
    );
  });
});

describe('isIdentityVerified', () => {
  it('asks SES for the identity with GetEmailIdentityCommand', async () => {
    const stub = stubClient(() => ({ VerifiedForSendingStatus: true }));

    const verified = await createAwsSesAdapter(stub.client).isIdentityVerified(
      'news.domain-a.com',
    );

    expect(verified).toBe(true);
    expect(stub.commands[0].name).toBe('GetEmailIdentityCommand');
    expect(stub.input<IdentityInputShape>().EmailIdentity).toBe('news.domain-a.com');
  });

  it('normalises case and whitespace before querying', async () => {
    const stub = stubClient(() => ({ VerifiedForSendingStatus: true }));

    await createAwsSesAdapter(stub.client).isIdentityVerified('  NEWS.Domain-A.com  ');

    expect(stub.input<IdentityInputShape>().EmailIdentity).toBe('news.domain-a.com');
  });

  it('returns false when VerifiedForSendingStatus is false', async () => {
    const stub = stubClient(() => ({ VerifiedForSendingStatus: false }));

    expect(
      await createAwsSesAdapter(stub.client).isIdentityVerified('news.domain-a.com'),
    ).toBe(false);
  });

  it('returns false when VerifiedForSendingStatus is absent', async () => {
    const stub = stubClient(() => ({ IdentityType: 'DOMAIN' }));

    expect(
      await createAwsSesAdapter(stub.client).isIdentityVerified('news.domain-a.com'),
    ).toBe(false);
  });

  it('returns false when the whole response is undefined', async () => {
    const stub = stubClient(() => undefined);

    expect(
      await createAwsSesAdapter(stub.client).isIdentityVerified('news.domain-a.com'),
    ).toBe(false);
  });

  it('treats NotFoundException as "not verified", not as an error', async () => {
    const stub = stubClient(() => {
      throw new ServiceError('NotFoundException', 'Email identity not found');
    });

    expect(
      await createAwsSesAdapter(stub.client).isIdentityVerified('news.domain-a.com'),
    ).toBe(false);
  });

  it('falls back to the domain identity when an address is not itself verified', async () => {
    const stub = stubClient((command) => {
      const input = command.input as IdentityInputShape;
      if (input.EmailIdentity === 'hello@news.domain-a.com') {
        throw new ServiceError('NotFoundException', 'not found');
      }
      return { VerifiedForSendingStatus: true };
    });

    const verified = await createAwsSesAdapter(stub.client).isIdentityVerified(
      'hello@news.domain-a.com',
    );

    expect(verified).toBe(true);
    expect(stub.commands).toHaveLength(2);
    expect(stub.input<IdentityInputShape>(1).EmailIdentity).toBe('news.domain-a.com');
  });

  it('returns false when neither the address nor its domain is verified', async () => {
    const stub = stubClient(() => {
      throw new ServiceError('NotFoundException', 'not found');
    });

    expect(
      await createAwsSesAdapter(stub.client).isIdentityVerified('hello@news.domain-a.com'),
    ).toBe(false);
    expect(stub.commands).toHaveLength(2);
  });

  it('does not retry when the address identity exists but is unverified', async () => {
    const stub = stubClient(() => ({ VerifiedForSendingStatus: false }));

    expect(
      await createAwsSesAdapter(stub.client).isIdentityVerified('hello@news.domain-a.com'),
    ).toBe(false);
    expect(stub.commands).toHaveLength(1);
  });

  it('does not retry when the value has no domain part', async () => {
    const stub = stubClient(() => {
      throw new ServiceError('NotFoundException', 'not found');
    });

    expect(await createAwsSesAdapter(stub.client).isIdentityVerified('broken@')).toBe(false);
    expect(stub.commands).toHaveLength(1);
  });

  it('returns false for an empty identity without calling SES', async () => {
    const stub = stubClient(() => {
      throw new Error('must not be called');
    });

    expect(await createAwsSesAdapter(stub.client).isIdentityVerified('   ')).toBe(false);
    expect(stub.commands).toHaveLength(0);
  });

  it('treats a legacy `code: NotFound` as "not verified"', async () => {
    const stub = stubClient(() => {
      throw new ServiceError('ServiceException', 'nope', 'NotFound');
    });

    expect(
      await createAwsSesAdapter(stub.client).isIdentityVerified('news.domain-a.com'),
    ).toBe(false);
  });

  it('treats a nameless plain-object rejection carrying a not-found code as "not verified"', async () => {
    const stub = stubClient(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw { code: 'NotFoundException' };
    });

    expect(
      await createAwsSesAdapter(stub.client).isIdentityVerified('news.domain-a.com'),
    ).toBe(false);
  });

  it('treats a bare 404 from the service as "not verified"', async () => {
    const stub = stubClient(() => {
      const err = new Error('unexpected');
      Object.assign(err, { $metadata: { httpStatusCode: 404 } });
      throw err;
    });

    expect(
      await createAwsSesAdapter(stub.client).isIdentityVerified('news.domain-a.com'),
    ).toBe(false);
  });

  it('translates throttling into SesThrottlingError', async () => {
    const stub = stubClient(() => {
      throw new ServiceError('TooManyRequestsException', 'Rate exceeded');
    });

    await expect(
      createAwsSesAdapter(stub.client).isIdentityVerified('news.domain-a.com'),
    ).rejects.toThrow(SesThrottlingError);
  });

  it('propagates a non-Error rejection rather than reading it as not-found', async () => {
    const stub = stubClient(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'catastrophe';
    });

    await expect(
      createAwsSesAdapter(stub.client).isIdentityVerified('news.domain-a.com'),
    ).rejects.toBe('catastrophe');
  });

  it('propagates a genuine service error so the pre-send gate can report it', async () => {
    const boom = new ServiceError('AccessDeniedException', 'not authorized');
    const stub = stubClient(() => {
      throw boom;
    });

    await expect(
      createAwsSesAdapter(stub.client).isIdentityVerified('news.domain-a.com'),
    ).rejects.toBe(boom);
  });
});

describe('PII discipline (§12)', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    const capture = (...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(' '));
    };
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
  });

  it('never writes a recipient address when SES returns no results array', async () => {
    const stub = stubClient(() => ({}));

    await createAwsSesAdapter(stub.client).sendBulk(bulkParams());

    const output = logs.join('\n');
    expect(output).not.toContain('alice@example.com');
    expect(output).not.toContain('bob@example.com');
  });

  it('never writes a recipient address when a send throttles', async () => {
    const stub = stubClient(() => {
      throw new ServiceError('TooManyRequestsException', 'Maximum sending rate exceeded');
    });

    await expect(
      createAwsSesAdapter(stub.client).sendBulk(bulkParams()),
    ).rejects.toThrow(SesThrottlingError);

    expect(logs.join('\n')).not.toContain('alice@example.com');
  });

  it('never writes the recipient address on a simple-send failure', async () => {
    const stub = stubClient(() => {
      throw new ServiceError('MessageRejected', 'rejected for new@example.com');
    });

    await expect(
      createAwsSesAdapter(stub.client).sendSimple(simpleParams()),
    ).rejects.toThrow();

    expect(logs.join('\n')).not.toContain('new@example.com');
  });

  it('never writes an identity address while verifying', async () => {
    const stub = stubClient(() => {
      throw new ServiceError('NotFoundException', 'hello@news.domain-a.com not found');
    });

    await createAwsSesAdapter(stub.client).isIdentityVerified('hello@news.domain-a.com');

    expect(logs.join('\n')).not.toContain('hello@news.domain-a.com');
  });
});
