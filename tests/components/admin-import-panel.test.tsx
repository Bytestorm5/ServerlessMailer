// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportPanel } from '@/components/admin/ImportPanel';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const LISTS = [
  { id: '507f1f77bcf86cd799439011', name: 'Domain A Weekly' },
  { id: '507f1f77bcf86cd799439012', name: 'Domain B Monthly' },
];

const CSV = 'email,first name\nada@example.com,Ada\ngrace@example.com,Grace';

interface ImportBody {
  listId: string;
  csv: string;
  filename?: string;
  mapping: { email: string; attributes: Record<string, string> };
  markConfirmed: boolean;
  attestation?: { text: string; by: string };
}

function okResult(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    total: 2,
    imported: 2,
    updated: 0,
    skippedSuppressed: 0,
    skippedTombstoned: 0,
    errors: [],
    ...overrides,
  };
}

function stubFetch(response: unknown, status = 200) {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => response,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof stubFetch>): ImportBody {
  const init = fetchMock.mock.calls.at(-1)![1] as unknown as RequestInit;
  return JSON.parse(String(init.body)) as ImportBody;
}

/** Renders the panel and gets as far as a chosen CSV file, which is what
 *  reveals the mapping and attestation controls. */
async function setup(
  options: { csv?: string; filename?: string; lists?: { id: string; name: string }[] } = {},
) {
  const user = userEvent.setup();
  render(<ImportPanel lists={options.lists ?? LISTS} />);

  const file = new File([options.csv ?? CSV], options.filename ?? 'subscribers.csv', {
    type: 'text/csv',
  });
  await user.upload(screen.getByLabelText(/csv file/i), file);
  await waitFor(() => expect(screen.getByLabelText(/email column/i)).toBeInTheDocument());

  return {
    user,
    attestation: () => screen.getByRole('checkbox'),
    importButton: () => screen.getByRole('button', { name: /import/i }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ImportPanel — choosing a file and mapping columns', () => {
  it('offers no import until a file has been chosen', () => {
    render(<ImportPanel lists={LISTS} />);

    expect(screen.queryByRole('button', { name: /import/i })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('reads the header row and guesses the email column', async () => {
    await setup({ csv: 'full name,e-mail address,city\nAda,ada@example.com,London' });

    expect(screen.getByLabelText(/email column/i)).toHaveValue('e-mail address');
  });

  it('sends the file contents, filename and chosen list', async () => {
    const fetchMock = stubFetch(okResult());
    const { user, importButton } = await setup();

    await user.selectOptions(screen.getByLabelText(/^list$/i), LISTS[1].id);
    await user.click(importButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/admin/import');
    expect(init.method).toBe('POST');

    const body = sentBody(fetchMock);
    expect(body.listId).toBe(LISTS[1].id);
    expect(body.csv).toBe(CSV);
    expect(body.filename).toBe('subscribers.csv');
    expect(body.mapping.email).toBe('email');
  });

  it('sends only the columns the operator actually mapped', async () => {
    const fetchMock = stubFetch(okResult());
    const { user, importButton } = await setup({
      csv: 'email,first name,city\nada@example.com,Ada,London',
    });

    await user.type(screen.getByLabelText(/first name/i), 'first_name');
    // 'city' is left blank, i.e. ignored.
    await user.click(importButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sentBody(fetchMock).mapping.attributes).toEqual({ 'first name': 'first_name' });
  });

  it('lets the operator override the guessed email column', async () => {
    const fetchMock = stubFetch(okResult());
    const { user, importButton } = await setup({
      csv: 'email,contact\nnope,ada@example.com',
    });

    await user.selectOptions(screen.getByLabelText(/email column/i), 'contact');
    await user.click(importButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sentBody(fetchMock).mapping.email).toBe('contact');
  });
});

describe('ImportPanel — the prior-consent attestation (§4.3)', () => {
  it('starts unticked, so the default import lands as pending', async () => {
    await setup();

    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByText(/land as/i)).toHaveTextContent(/pending/i);
  });

  it('sends markConfirmed:false and NO attestation when it is left unticked', async () => {
    // This is the whole point of the control: 33,000 addresses must not become
    // `confirmed` unless somebody affirmatively attested to prior consent.
    const fetchMock = stubFetch(okResult());
    const { user, importButton } = await setup();

    await user.click(importButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = sentBody(fetchMock);
    expect(body.markConfirmed).toBe(false);
    expect(body.attestation).toBeUndefined();
    expect(Object.keys(body)).not.toContain('attestation');
  });

  it('requires the operator to name themselves once it is ticked', async () => {
    const fetchMock = stubFetch(okResult());
    const { user, attestation, importButton } = await setup();

    await user.click(attestation());

    const byField = await screen.findByLabelText(/your name/i);
    expect(importButton()).toBeDisabled();

    await user.click(importButton());
    expect(fetchMock).not.toHaveBeenCalled();

    await user.type(byField, 'Alex Admin');
    expect(importButton()).toBeEnabled();
  });

  it('sends exactly the attestation wording that was shown to the operator', async () => {
    // The stored text is the legal record. If the UI ever shows one sentence and
    // logs another, the record is worthless.
    const fetchMock = stubFetch(okResult({ imported: 33000, total: 33000 }));
    const { user, attestation, importButton } = await setup();

    await user.click(attestation());
    const shownText = attestation().closest('label')!.textContent!.trim();
    await user.type(await screen.findByLabelText(/your name/i), 'Alex Admin');
    await user.click(importButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = sentBody(fetchMock);
    expect(body.markConfirmed).toBe(true);
    expect(body.attestation).toEqual({ text: shownText, by: 'Alex Admin' });
    // And the wording is a real attestation, not a placeholder.
    expect(shownText).toMatch(/prior opt-in consent/i);
    expect(shownText).toMatch(/evidence/i);
  });

  it('drops the attestation again when the operator unticks it', async () => {
    const fetchMock = stubFetch(okResult());
    const { user, attestation, importButton } = await setup();

    await user.click(attestation());
    await user.type(await screen.findByLabelText(/your name/i), 'Alex Admin');
    await user.click(attestation());

    expect(attestation()).not.toBeChecked();
    await waitFor(() => expect(screen.queryByLabelText(/your name/i)).toBeNull());

    await user.click(importButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = sentBody(fetchMock);
    expect(body.markConfirmed).toBe(false);
    expect(body.attestation).toBeUndefined();
  });
});

describe('ImportPanel — reporting the outcome', () => {
  it('reports what happened to every row, including suppressed and tombstoned skips', async () => {
    stubFetch(
      okResult({
        total: 10,
        imported: 6,
        updated: 2,
        skippedSuppressed: 1,
        skippedTombstoned: 1,
      }),
    );
    const { user, importButton } = await setup();

    await user.click(importButton());

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/6 added/);
    expect(status).toHaveTextContent(/2 updated/);
    expect(status).toHaveTextContent(/1 skipped because they are suppressed/);
    expect(status).toHaveTextContent(/1 left alone because they had unsubscribed or bounced/);
  });

  it('renders every malformed row back to the operator rather than swallowing it', async () => {
    // §4.3: malformed rows are reported back, not silently dropped.
    stubFetch(
      okResult({
        total: 4,
        imported: 2,
        errors: [
          { row: 3, email: 'not-an-email', reason: 'invalid syntax' },
          { row: 4, reason: 'no email column value' },
        ],
      }),
    );
    const { user, importButton } = await setup();

    await user.click(importButton());

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/2 rows could not be imported/i);

    const rows = within(status).getAllByRole('row');
    // header + two error rows
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('3');
    expect(rows[1]).toHaveTextContent('not-an-email');
    expect(rows[1]).toHaveTextContent('invalid syntax');
    expect(rows[2]).toHaveTextContent('4');
    expect(rows[2]).toHaveTextContent('no email column value');
  });

  it('shows no error table when every row imported cleanly', async () => {
    stubFetch(okResult());
    const { user, importButton } = await setup();

    await user.click(importButton());

    const status = await screen.findByRole('status');
    expect(within(status).queryByRole('table')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('surfaces a rejected import as an error and shows no success summary', async () => {
    stubFetch({ ok: false, error: 'Importing as confirmed requires an explicit attestation.' }, 400);
    const { user, importButton } = await setup();

    await user.click(importButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /requires an explicit attestation/i,
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('cannot be double-submitted while an import is in flight', async () => {
    // Re-posting a 33,000-row file because the button stayed live is exactly the
    // kind of accident that produces duplicate confirmation emails.
    let release: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async () => pending);
    vi.stubGlobal('fetch', fetchMock);

    const { user, importButton } = await setup();
    await user.click(importButton());

    const busy = await screen.findByRole('button', { name: /importing/i });
    await waitFor(() => expect(busy).toBeDisabled());
    await user.click(busy);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release({ ok: true, status: 200, json: async () => okResult() });
    await screen.findByRole('status');
  });
});
