// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ListsManager, type ListRow } from '@/components/admin/ListsManager';

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

const ROW: ListRow = {
  id: '507f1f77bcf86cd799439011',
  name: 'Domain A Weekly',
  sendingDomain: 'news.domain-a.com',
  fromName: 'Domain A',
  fromEmail: 'hello@news.domain-a.com',
  replyTo: 'hello@domain-a.com',
  physicalAddress: '1 Example Street, London',
  sesConfigurationSet: 'domain-a-config',
  active: true,
  welcomeUrl: null,
  counts: { confirmed: 12, pending: 3, unsubscribed: 1, campaigns: 2 },
};

beforeEach(() => {
  nav.push.mockClear();
  nav.refresh.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Finds the actions cell for a named list. */
function rowFor(name: string) {
  return screen.getByRole('row', { name: new RegExp(name) });
}

describe('ListsManager', () => {
  it('says plainly that nothing can be sent with no lists', () => {
    render(<ListsManager lists={[]} />);
    expect(screen.getByText(/Nothing can be sent until one exists/)).toBeInTheDocument();
  });

  it('shows the counts that decide whether a list can be deleted', () => {
    render(<ListsManager lists={[ROW]} />);
    const row = rowFor('Domain A Weekly');
    expect(within(row).getByText(/12/)).toBeInTheDocument();
    expect(within(row).getByText(/3 pending/)).toBeInTheDocument();
    expect(within(row).getByText('active')).toBeInTheDocument();
  });

  it('creates a list from the new-list form', async () => {
    const fetchMock = stubFetch(() => json(201, { ok: true, list: { id: 'new-list' } }));
    const user = userEvent.setup();
    render(<ListsManager lists={[]} />);

    await user.click(screen.getByRole('button', { name: 'New list' }));
    await user.type(screen.getByLabelText('Name'), 'Domain B Monthly');
    await user.type(screen.getByLabelText('Sending domain'), 'news.domain-b.com');
    await user.type(screen.getByLabelText('From name'), 'Domain B');
    await user.type(screen.getByLabelText('From email'), 'hello@news.domain-b.com');
    await user.type(screen.getByLabelText('Reply-to'), 'hello@domain-b.com');
    await user.type(screen.getByLabelText('Physical address'), '2 Example Road, Bristol');
    await user.type(screen.getByLabelText('SES configuration set'), 'domain-b-config');
    await user.click(screen.getByRole('button', { name: 'Create list' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/admin/lists');
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('POST');
    expect(bodyOf(fetchMock)).toMatchObject({
      name: 'Domain B Monthly',
      sendingDomain: 'news.domain-b.com',
      fromEmail: 'hello@news.domain-b.com',
      active: true,
    });
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(screen.getByRole('status')).toHaveTextContent('List created.');
  });

  it('surfaces a validation failure and keeps the form open', async () => {
    const fetchMock = stubFetch(() =>
      json(400, { ok: false, error: 'fromEmail must be at news.domain-b.com or a subdomain' }),
    );
    const user = userEvent.setup();
    render(<ListsManager lists={[]} />);

    await user.click(screen.getByRole('button', { name: 'New list' }));
    await user.type(screen.getByLabelText('Name'), 'Bad list');
    await user.click(screen.getByRole('button', { name: 'Create list' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByRole('alert')).toHaveTextContent(/must be at news.domain-b.com/);
    // The operator's typing is not thrown away by a rejection.
    expect(screen.getByLabelText('Name')).toHaveValue('Bad list');
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it('pre-fills the edit form and PATCHes the changed field', async () => {
    const fetchMock = stubFetch(() => json(200, { ok: true, list: { id: ROW.id } }));
    const user = userEvent.setup();
    render(<ListsManager lists={[ROW]} />);

    await user.click(within(rowFor('Domain A Weekly')).getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Sending domain')).toHaveValue('news.domain-a.com');
    expect(screen.getByLabelText('SES configuration set')).toHaveValue('domain-a-config');

    await user.clear(screen.getByLabelText('From name'));
    await user.type(screen.getByLabelText('From name'), 'Domain A News');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/admin/lists/${ROW.id}`);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('PATCH');
    expect(bodyOf(fetchMock)).toMatchObject({ fromName: 'Domain A News' });
    expect(screen.getByRole('status')).toHaveTextContent('List saved.');
  });

  it('deactivates without touching subscribers', async () => {
    const fetchMock = stubFetch(() => json(200, { ok: true, list: { id: ROW.id } }));
    const user = userEvent.setup();
    render(<ListsManager lists={[ROW]} />);

    await user.click(
      within(rowFor('Domain A Weekly')).getByRole('button', { name: 'Deactivate' }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(bodyOf(fetchMock)).toEqual({ active: false });
    expect(screen.getByRole('status')).toHaveTextContent('"Domain A Weekly" deactivated.');
  });

  it('carries the optional welcome URL and an unchecked active box', async () => {
    const fetchMock = stubFetch(() => json(201, { ok: true, list: { id: 'new-list' } }));
    const user = userEvent.setup();
    render(<ListsManager lists={[]} />);

    await user.click(screen.getByRole('button', { name: 'New list' }));
    await user.type(screen.getByLabelText('Name'), 'Staged list');
    await user.type(screen.getByLabelText(/Welcome URL/), 'https://domain-b.com/welcome');
    // Creating a list inactive is how an operator stages one before launch.
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Create list' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOf(fetchMock)).toMatchObject({
      welcomeUrl: 'https://domain-b.com/welcome',
      active: false,
    });
  });

  it('closes the form on Cancel without sending anything', async () => {
    const fetchMock = stubFetch(() => json(200, {}));
    const user = userEvent.setup();
    render(<ListsManager lists={[ROW]} />);

    await user.click(within(rowFor('Domain A Weekly')).getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Name')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a failed activation change', async () => {
    stubFetch(() => json(500, { ok: false, error: 'internal error' }));
    const user = userEvent.setup();
    render(<ListsManager lists={[ROW]} />);

    await user.click(
      within(rowFor('Domain A Weekly')).getByRole('button', { name: 'Deactivate' }),
    );

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('internal error'));
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it('offers Activate for an inactive list', async () => {
    const fetchMock = stubFetch(() => json(200, { ok: true, list: { id: ROW.id } }));
    const user = userEvent.setup();
    render(<ListsManager lists={[{ ...ROW, active: false }]} />);

    await user.click(within(rowFor('Domain A Weekly')).getByRole('button', { name: 'Activate' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOf(fetchMock)).toEqual({ active: true });
  });

  it('requires a second click before deleting', async () => {
    const fetchMock = stubFetch(() => json(200, { ok: true, deleted: true }));
    const user = userEvent.setup();
    render(<ListsManager lists={[ROW]} />);

    await user.click(screen.getByRole('button', { name: 'Delete Domain A Weekly' }));
    // The first click only arms the confirmation.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('Delete permanently?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('DELETE');
    expect(screen.getByRole('status')).toHaveTextContent('"Domain A Weekly" deleted.');
  });

  it('cancels an armed delete', async () => {
    const fetchMock = stubFetch(() => json(200, { ok: true }));
    const user = userEvent.setup();
    render(<ListsManager lists={[ROW]} />);

    await user.click(screen.getByRole('button', { name: 'Delete Domain A Weekly' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete Domain A Weekly' })).toBeInTheDocument();
  });

  it("shows the server's refusal verbatim when a populated list cannot be deleted", async () => {
    const refusal =
      '"Domain A Weekly" still has 12 subscriber(s) and 2 campaign(s). Deactivate the list instead.';
    stubFetch(() => json(409, { ok: false, error: refusal, subscribers: 12, campaigns: 2 }));
    const user = userEvent.setup();
    render(<ListsManager lists={[ROW]} />);

    await user.click(screen.getByRole('button', { name: 'Delete Domain A Weekly' }));
    await user.click(screen.getByRole('button', { name: 'Confirm delete' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/still has 12/));
    expect(screen.getByRole('alert')).toHaveTextContent(/Deactivate the list instead/);
    expect(nav.refresh).not.toHaveBeenCalled();
  });
});

describe('list test sends', () => {
  it('sends a test from the row without opening the edit form', async () => {
    const fetchMock = stubFetch(() => json(200, { ok: true, sent: 1 }));
    const user = userEvent.setup();
    render(<ListsManager lists={[ROW]} />);

    await user.click(screen.getByRole('button', { name: 'Send test from Domain A Weekly' }));
    // The test panel is not the edit form.
    expect(screen.queryByLabelText('Sending domain')).toBeNull();

    await user.type(screen.getByLabelText('Send to'), 'operator@example.com');
    await user.click(screen.getByRole('button', { name: 'Send test' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/admin/lists/${ROW.id}/test`);
    expect(bodyOf(fetchMock)).toEqual({ to: ['operator@example.com'] });
    // Arrival is the operator's check, so the message says what to look for.
    expect(screen.getByRole('status')).toHaveTextContent(/Confirm it arrived/);
  });

  it('shows why a test send was refused', async () => {
    stubFetch(() => json(400, { ok: false, error: 'That address is on the suppression list' }));
    const user = userEvent.setup();
    render(<ListsManager lists={[ROW]} />);

    await user.click(screen.getByRole('button', { name: 'Send test from Domain A Weekly' }));
    await user.type(screen.getByLabelText('Send to'), 'burned@example.com');
    await user.click(screen.getByRole('button', { name: 'Send test' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/suppression list/),
    );
    // The panel stays open so the operator can try another address.
    expect(screen.getByLabelText('Send to')).toBeInTheDocument();
  });

  it('closes the test panel on Cancel', async () => {
    const fetchMock = stubFetch(() => json(200, {}));
    const user = userEvent.setup();
    render(<ListsManager lists={[ROW]} />);

    await user.click(screen.getByRole('button', { name: 'Send test from Domain A Weekly' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByLabelText('Send to')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
