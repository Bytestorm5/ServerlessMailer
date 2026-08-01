// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NewCampaignButton } from '@/components/admin/NewCampaignButton';
import { SuppressionControls } from '@/components/admin/SuppressionControls';
import { CampaignWorkspace } from '@/components/admin/CampaignWorkspace';
import type { CampaignCounts, CampaignStatus } from '@/lib/types';

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, refresh: nav.refresh }),
}));

type Handler = (url: string, init: RequestInit) => unknown;

function stubFetch(handler: Handler) {
  const fetchMock = vi.fn(async (url: unknown, init: unknown) =>
    handler(String(url), (init ?? {}) as RequestInit),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function bodyOf(fetchMock: ReturnType<typeof stubFetch>, index = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[index]![1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

beforeEach(() => {
  nav.push.mockClear();
  nav.refresh.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------ NewCampaignButton */

const LISTS = [
  { id: '507f1f77bcf86cd799439011', name: 'Domain A Weekly' },
  { id: '507f1f77bcf86cd799439012', name: 'Domain B Monthly' },
];

describe('NewCampaignButton', () => {
  it('creates a campaign on the only list and opens it', async () => {
    const fetchMock = stubFetch(() => json(200, { id: 'camp-99' }));
    const user = userEvent.setup();
    render(<NewCampaignButton lists={[LISTS[0]]} />);

    // One list means no ambiguity to resolve, so no picker.
    expect(screen.queryByRole('combobox')).toBeNull();
    await user.click(screen.getByRole('button', { name: /new campaign/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/campaigns');
    expect(init.method).toBe('POST');
    expect(bodyOf(fetchMock)).toEqual({ listId: LISTS[0].id });
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/admin/campaigns/camp-99'));
  });

  it('creates the campaign against the list the operator picked', async () => {
    // Composing for the wrong audience is a 19,000-person mistake, so the
    // chosen list has to be the one that reaches the server.
    const fetchMock = stubFetch(() => json(200, { id: 'camp-100' }));
    const user = userEvent.setup();
    render(<NewCampaignButton lists={LISTS} />);

    await user.selectOptions(screen.getByRole('combobox', { name: /list/i }), LISTS[1].id);
    await user.click(screen.getByRole('button', { name: /new campaign/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOf(fetchMock)).toEqual({ listId: LISTS[1].id });
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/admin/campaigns/camp-100'));
  });

  it('renders nothing at all when there are no lists', () => {
    const { container } = render(<NewCampaignButton lists={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('does not navigate when the server returns no campaign id', async () => {
    const fetchMock = stubFetch(() => json(400, { error: 'unknown list' }));
    const user = userEvent.setup();
    render(<NewCampaignButton lists={[LISTS[0]]} />);

    await user.click(screen.getByRole('button', { name: /new campaign/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(nav.push).not.toHaveBeenCalled();
    // and the button comes back so the operator can retry
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /new campaign/i })).toBeEnabled(),
    );
  });
});

/* --------------------------------------------------- SuppressionControls */

describe('SuppressionControls', () => {
  async function submit(email = 'person@example.com') {
    const user = userEvent.setup();
    render(<SuppressionControls />);
    await user.type(screen.getByLabelText(/suppress an address/i), email);
    await user.click(screen.getByRole('button', { name: /add/i }));
    return user;
  }

  it('posts the address and confirms a newly created suppression', async () => {
    const fetchMock = stubFetch(() => json(200, { ok: true, created: true }));

    await submit('bounced@example.com');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/suppressions');
    expect(init.method).toBe('POST');
    expect(bodyOf(fetchMock)).toEqual({ email: 'bounced@example.com' });

    expect(await screen.findByRole('status')).toHaveTextContent(/^suppressed\.$/i);
    // The list behind the form has to reflect the new entry.
    await waitFor(() => expect(nav.refresh).toHaveBeenCalledTimes(1));
  });

  it('says so when the address was already suppressed', async () => {
    // addSuppression is idempotent; the operator still deserves to know which
    // of the two things happened.
    stubFetch(() => json(200, { ok: true, created: false }));

    await submit();

    expect(await screen.findByRole('status')).toHaveTextContent(/already suppressed/i);
  });

  it('clears the field after a successful add so the next address is easy', async () => {
    stubFetch(() => json(200, { ok: true, created: true }));

    await submit('bounced@example.com');

    await waitFor(() => expect(screen.getByLabelText(/suppress an address/i)).toHaveValue(''));
  });

  it('reports a rejected suppression and keeps what was typed', async () => {
    stubFetch(() => json(400, { error: 'a valid email address is required' }));

    await submit('person@example');

    expect(await screen.findByRole('status')).toHaveTextContent(/valid email address/i);
    expect(screen.getByLabelText(/suppress an address/i)).toHaveValue('person@example');
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it('falls back to a plain message when a failure carries no JSON body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 502,
        json: async () => {
          throw new SyntaxError('not json');
        },
      })),
    );

    await submit();

    expect(await screen.findByRole('status')).toHaveTextContent(/could not suppress/i);
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it('never reaches the server with a syntactically impossible address', async () => {
    const fetchMock = stubFetch(() => json(200, { created: true }));
    const user = userEvent.setup();
    render(<SuppressionControls />);

    await user.type(screen.getByLabelText(/suppress an address/i), 'not-an-email');
    await user.click(screen.getByRole('button', { name: /add/i }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it('will not submit an empty address', async () => {
    const fetchMock = stubFetch(() => json(200, { created: true }));
    render(<SuppressionControls />);

    expect(screen.getByRole('button', { name: /add/i })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* ----------------------------------------------------- CampaignWorkspace */

function counts(overrides: Partial<CampaignCounts> = {}): CampaignCounts {
  return {
    recipients: 0,
    sent: 0,
    failed: 0,
    bounced: 0,
    complained: 0,
    unsubscribed: 0,
    delivered: 0,
    opened: 0,
    clicked: 0,
    ...overrides,
  };
}

function renderWorkspace(
  status: CampaignStatus,
  overrides: Partial<React.ComponentProps<typeof CampaignWorkspace>> = {},
) {
  render(
    <CampaignWorkspace
      campaignId="camp-1"
      status={status}
      pausedReason={null}
      counts={counts({ recipients: 19482, sent: 4821, delivered: 4700, bounced: 12, complained: 3 })}
      initialDraft={{
        subject: 'This week from Domain A',
        preheader: 'The short version',
        bodySource: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }],
        },
      }}
      list={{
        name: 'Domain A Weekly',
        fromName: 'Domain A',
        fromEmail: 'hello@news.domain-a.com',
        replyTo: 'hello@domain-a.com',
      }}
      mergeFields={[{ key: 'first_name', label: 'First name', system: false }]}
      previewSubscribers={[{ id: 'sub-1', email: 'ada@example.com', label: 'ada@example.com' }]}
      versions={[]}
      typedConfirmationThreshold={1000}
      {...overrides}
    />,
  );
}

/** Routes the editor's own preview call so the draft screen can mount. */
const editorFetch: Handler = (url) => {
  if (url.includes('/preview')) return json(200, { html: '<p>Hello</p>', text: 'Hello' });
  return json(200, { ok: true });
};

describe('CampaignWorkspace — after freeze there is no editor (§7.1)', () => {
  it.each(['sending', 'sent', 'paused', 'failed'] as CampaignStatus[])(
    'shows the progress view and no editor for a %s campaign',
    async (status) => {
      stubFetch(editorFetch);
      renderWorkspace(status);

      // The body and recipient set are immutable once frozen, so offering an
      // editable subject line would be a lie.
      expect(screen.queryByLabelText(/subject line/i)).toBeNull();
      expect(screen.queryByLabelText(/preheader/i)).toBeNull();
      expect(screen.queryByRole('button', { name: /review and send/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /send test/i })).toBeNull();

      expect(screen.getByRole('heading', { name: /this week from domain a/i })).toBeVisible();
      expect(screen.getByText(status)).toBeVisible();
    },
  );

  it.each(['draft', 'scheduled'] as CampaignStatus[])(
    'still offers the editor for a %s campaign',
    async (status) => {
      stubFetch(editorFetch);
      renderWorkspace(status);

      expect(await screen.findByLabelText(/subject line/i)).toHaveValue(
        'This week from Domain A',
      );
      expect(screen.queryByRole('button', { name: /pause sending/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /resume sending/i })).toBeNull();
    },
  );
});

describe('CampaignWorkspace — progress reporting', () => {
  it('reports progress against the frozen recipient count', async () => {
    stubFetch(editorFetch);
    renderWorkspace('sending');

    expect(screen.getByText('25%')).toBeVisible();
    expect(screen.getByText(/4,821 of 19,482/)).toBeVisible();
    expect(screen.getByText('4,700')).toBeVisible(); // delivered
    expect(screen.getByText('12')).toBeVisible(); // bounced
    expect(screen.getByText('3')).toBeVisible(); // complained
  });

  it('shows 0% rather than NaN before any recipients are materialised', async () => {
    stubFetch(editorFetch);
    renderWorkspace('sending', { counts: counts() });

    expect(screen.getByText('0%')).toBeVisible();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it('surfaces why a campaign was paused', async () => {
    // The circuit breaker (§7.8) pauses with a reason; burying it would leave
    // the operator resuming a send that is generating complaints.
    stubFetch(editorFetch);
    renderWorkspace('paused', {
      pausedReason: 'Complaint rate 0.42% exceeded the 0.10% threshold',
    });

    expect(screen.getByRole('alert')).toHaveTextContent(/0.42%/);
  });
});

describe('CampaignWorkspace — pause and resume (§7.7)', () => {
  it('offers Pause while sending, and posts {action:"pause"}', async () => {
    const fetchMock = stubFetch(editorFetch);
    const user = userEvent.setup();
    renderWorkspace('sending');

    expect(screen.queryByRole('button', { name: /resume/i })).toBeNull();
    await user.click(screen.getByRole('button', { name: /pause sending/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/campaigns/camp-1/actions');
    expect(init.method).toBe('POST');
    const body = bodyOf(fetchMock);
    expect(body.action).toBe('pause');
    expect(String(body.reason)).not.toHaveLength(0);

    // The new status has to come back from the server, not be guessed locally.
    await waitFor(() => expect(nav.refresh).toHaveBeenCalledTimes(1));
  });

  it('offers Resume while paused, and posts {action:"resume"}', async () => {
    const fetchMock = stubFetch(editorFetch);
    const user = userEvent.setup();
    renderWorkspace('paused');

    expect(screen.queryByRole('button', { name: /pause/i })).toBeNull();
    await user.click(screen.getByRole('button', { name: /resume sending/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/admin/campaigns/camp-1/actions');
    expect(bodyOf(fetchMock)).toEqual({ action: 'resume' });
    await waitFor(() => expect(nav.refresh).toHaveBeenCalledTimes(1));
  });

  it('offers neither control once the campaign has been sent', async () => {
    stubFetch(editorFetch);
    renderWorkspace('sent', { counts: counts({ recipients: 19482, sent: 19482 }) });

    expect(screen.queryByRole('button', { name: /pause/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /resume/i })).toBeNull();
    expect(screen.getByText('100%')).toBeVisible();
  });

  it('reaches the actions endpoint of the campaign it was given, not a fixed one', async () => {
    const fetchMock = stubFetch(editorFetch);
    const user = userEvent.setup();
    renderWorkspace('sending', { campaignId: '507f1f77bcf86cd799439099' });

    await user.click(screen.getByRole('button', { name: /pause sending/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![0]).toBe(
      '/api/admin/campaigns/507f1f77bcf86cd799439099/actions',
    );
  });

  it('cannot be pressed twice while the pause is in flight', async () => {
    let release: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async () => pending);
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    renderWorkspace('sending');

    const pause = screen.getByRole('button', { name: /pause sending/i });
    await user.click(pause);
    await waitFor(() => expect(pause).toBeDisabled());
    await user.click(pause);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release(json(200, { ok: true }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalledTimes(1));
  });
});

describe('CampaignWorkspace — wiring the draft editor to the admin API', () => {
  const PASSING = {
    passed: true,
    recipientCount: 480,
    checks: [{ id: 'subject', label: 'Subject line is present', passed: true }],
  };

  /** Answers every endpoint the editor screen touches. */
  const draftFetch: Handler = (url) => {
    if (url.includes('/preview')) {
      return json(200, { html: '<p>Rendered body</p>', text: 'Rendered body' });
    }
    if (url.includes('/validate')) return json(200, PASSING);
    return json(200, { ok: true });
  };

  function callsTo(fetchMock: ReturnType<typeof stubFetch>, fragment: string) {
    return fetchMock.mock.calls.filter(([url]) => String(url).includes(fragment));
  }

  it('renders the preview through the campaign preview endpoint', async () => {
    const fetchMock = stubFetch(draftFetch);
    renderWorkspace('draft');

    await waitFor(() => expect(callsTo(fetchMock, '/preview')).not.toHaveLength(0));
    const [url, init] = callsTo(fetchMock, '/preview')[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/campaigns/camp-1/preview');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    // The preview must exercise a real subscriber's merge data (§6.3).
    expect(body.subscriberId).toBe('sub-1');
    expect(body.subject).toBe('This week from Domain A');

    await waitFor(() =>
      expect(screen.getByTitle(/email preview/i)).toHaveAttribute(
        'srcdoc',
        '<p>Rendered body</p>',
      ),
    );
  });

  it('autosaves the draft with PATCH to the campaign document', async () => {
    const fetchMock = stubFetch(draftFetch);
    const user = userEvent.setup();
    renderWorkspace('draft');

    await user.type(await screen.findByLabelText(/subject line/i), '!');

    const patchCalls = () =>
      fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === 'PATCH');
    await waitFor(() => expect(patchCalls()).not.toHaveLength(0), { timeout: 5000 });
    const patches = patchCalls();
    const [url, init] = patches.at(-1) as [string, RequestInit];
    expect(url).toBe('/api/admin/campaigns/camp-1');
    expect(JSON.parse(String(init.body)).subject).toBe('This week from Domain A!');
  });

  it('tells the writer their work did not save when the PATCH fails', async () => {
    // Silently losing someone's writing is the worst failure a writing tool has.
    const fetchMock = stubFetch((url, init) => {
      if (url.includes('/preview')) return json(200, { html: '<p>x</p>', text: 'x' });
      if (init.method === 'PATCH') return json(409, { error: 'campaign is no longer editable' });
      return json(200, { ok: true });
    });
    const user = userEvent.setup();
    renderWorkspace('draft');

    await user.type(await screen.findByLabelText(/subject line/i), '!');

    expect(await screen.findByText(/not saved/i, {}, { timeout: 5000 })).toHaveTextContent(
      /campaign is no longer editable/i,
    );
    expect(fetchMock).toHaveBeenCalled();
  });

  it('validates through the pre-send gate and then posts {action:"send"}', async () => {
    const fetchMock = stubFetch(draftFetch);
    const user = userEvent.setup();
    renderWorkspace('draft');

    await user.click(await screen.findByRole('button', { name: /review and send/i }));

    await waitFor(() => expect(callsTo(fetchMock, '/validate')).not.toHaveLength(0));
    expect(callsTo(fetchMock, '/validate')[0]![0]).toBe('/api/admin/campaigns/camp-1/validate');

    await user.click(await screen.findByRole('button', { name: /send to 480/i }));

    await waitFor(() => expect(callsTo(fetchMock, '/actions')).not.toHaveLength(0));
    const [, init] = callsTo(fetchMock, '/actions')[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ action: 'send' });
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });

  it('sends a test through the actions endpoint without touching the send action', async () => {
    const fetchMock = stubFetch(draftFetch);
    const user = userEvent.setup();
    renderWorkspace('draft');

    await user.type(await screen.findByLabelText(/send a test to/i), 'me@example.com');
    await user.click(screen.getByRole('button', { name: /send test/i }));

    await waitFor(() => expect(callsTo(fetchMock, '/actions')).not.toHaveLength(0));
    const [url, init] = callsTo(fetchMock, '/actions')[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/campaigns/camp-1/actions');
    expect(JSON.parse(String(init.body))).toEqual({ action: 'test', to: ['me@example.com'] });
  });

  it('restores a previous version through the actions endpoint', async () => {
    const fetchMock = stubFetch(draftFetch);
    const user = userEvent.setup();
    renderWorkspace('draft', {
      versions: [{ id: 'v1', createdAt: '2026-07-31T10:00:00.000Z', subject: 'Older draft' }],
    });

    await user.click(await screen.findByText(/version history/i));
    await user.click(screen.getByRole('button', { name: /restore/i }));

    await waitFor(() => expect(callsTo(fetchMock, '/actions')).not.toHaveLength(0));
    const [, init] = callsTo(fetchMock, '/actions')[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ action: 'restore', versionId: 'v1' });
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });
});
