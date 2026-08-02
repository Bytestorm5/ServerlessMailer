// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TemplateManager } from '@/components/template/TemplateManager';

/**
 * The template editor (§6.2a).
 *
 * What matters here is that the operator is never lied to: the preview is the
 * real render, a save that failed says so with every reason, and a list still
 * on the built-in layout is told which state it is in.
 */

const DEFAULT_HTML = '<html><body><h1>{{list_name}}</h1>{{content}}</body></html>';

const LISTS = [
  { id: 'list-1', name: 'Domain A Weekly', stored: false, html: DEFAULT_HTML, updatedAt: null },
  {
    id: 'list-2',
    name: 'Domain B Monthly',
    stored: true,
    html: '<html><body>B{{content}}</body></html>',
    updatedAt: '2026-07-31T10:00:00.000Z',
  },
];

const PLACEHOLDERS = [
  { key: 'content', label: 'Campaign body', description: 'Required.' },
  { key: 'list_name', label: 'Newsletter name', description: 'The list name.' },
];

function mockFetch(overrides: Record<string, () => Response> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = `${init?.method ?? 'GET'} ${url.replace(/^.*\/api/, '/api')}`;
    const override = overrides[key];
    if (override) return override();
    if (url.endsWith('/preview')) {
      return Response.json({ ok: true, html: '<html><body>rendered</body></html>', removed: [] });
    }
    return Response.json({ ok: true, removed: [], stored: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function setup(overrides: Partial<React.ComponentProps<typeof TemplateManager>> = {}) {
  render(
    <TemplateManager
      lists={LISTS}
      defaultHtml={DEFAULT_HTML}
      placeholders={PLACEHOLDERS}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TemplateManager — the source', () => {
  it('opens on the first list with its HTML in the editor', () => {
    mockFetch();
    setup();

    expect(screen.getByLabelText(/template html/i)).toHaveValue(DEFAULT_HTML);
  });

  it('says when a list is still on the built-in layout', () => {
    mockFetch();
    setup();

    expect(screen.getByRole('status')).toHaveTextContent(/built-in layout/i);
  });

  it('switches lists without losing the other list’s draft', async () => {
    const user = userEvent.setup();
    mockFetch();
    setup();

    await user.type(screen.getByLabelText(/template html/i), 'x');
    await user.selectOptions(screen.getByRole('combobox'), 'list-2');
    expect(screen.getByLabelText(/template html/i)).toHaveValue(LISTS[1].html);

    await user.selectOptions(screen.getByRole('combobox'), 'list-1');
    expect(screen.getByLabelText(/template html/i)).toHaveValue(`${DEFAULT_HTML}x`);
  });

  it('hides the list picker when there is only one list', () => {
    mockFetch();
    setup({ lists: [LISTS[0]] });

    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('explains itself when there are no lists at all', () => {
    mockFetch();
    setup({ lists: [] });

    expect(screen.getByText(/create one on the lists page/i)).toBeInTheDocument();
  });

  it('inserts a placeholder at the cursor rather than at the end', async () => {
    const user = userEvent.setup();
    mockFetch();
    setup({ lists: [{ ...LISTS[0], html: 'AB' }] });

    const field = screen.getByLabelText(/template html/i) as HTMLTextAreaElement;
    await user.click(screen.getByText(/placeholders/i));
    field.setSelectionRange(1, 1);
    await user.click(
      within(screen.getByRole('list')).getByRole('button', { name: /list_name/i }),
    );

    expect(field).toHaveValue('A{{list_name}}B');
  });
});

describe('TemplateManager — the preview', () => {
  it('renders the draft through the server, in a sandboxed frame', async () => {
    const fetchMock = mockFetch();
    setup();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const frame = await screen.findByTitle(/template preview/i);

    expect(frame.getAttribute('sandbox')).toBe('');
    await waitFor(() => expect(frame.getAttribute('srcdoc')).toContain('rendered'));
  });

  it('surfaces a render failure instead of showing a stale preview', async () => {
    mockFetch({
      'POST /api/admin/templates/list-1/preview': () =>
        Response.json({ ok: false, errors: ['template must contain {{content}}'] }, { status: 422 }),
    });
    setup();

    expect(await screen.findByRole('alert')).toHaveTextContent('{{content}}');
    expect(screen.queryByTitle(/template preview/i)).toBeNull();
  });

  it('reports what the sanitizer will strip', async () => {
    mockFetch({
      'POST /api/admin/templates/list-1/preview': () =>
        Response.json({ ok: true, html: '<html></html>', removed: ['<script>'] }),
    });
    setup();

    expect(await screen.findByText(/removed before sending: <script>/i)).toBeInTheDocument();
  });
});

describe('TemplateManager — saving', () => {
  it('stores the draft and reports the saved state', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch();
    setup();

    await user.click(screen.getByRole('button', { name: /save template/i }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/saved/i));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/templates/list-1',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('shows every reason a save was refused, not just the first', async () => {
    const user = userEvent.setup();
    mockFetch({
      'PUT /api/admin/templates/list-1': () =>
        Response.json(
          { ok: false, errors: ['unknown placeholder {{nonsense}}', '{{first_name}} needs a fallback'] },
          { status: 400 },
        ),
    });
    setup();

    await user.click(screen.getByRole('button', { name: /save template/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('nonsense');
    expect(alert).toHaveTextContent('needs a fallback');
  });

  it('restores the default without saving it', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch();
    setup();

    await user.type(screen.getByLabelText(/template html/i), 'edited');
    await user.click(screen.getByRole('button', { name: /reset to default/i }));

    expect(screen.getByLabelText(/template html/i)).toHaveValue(DEFAULT_HTML);
    expect(
      fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT'),
    ).toBe(false);
  });

  it('offers the way back to the built-in layout only when there is one to leave', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch();
    setup();

    expect(screen.queryByRole('button', { name: /use built-in layout/i })).toBeNull();

    await user.selectOptions(screen.getByRole('combobox'), 'list-2');
    await user.click(screen.getByRole('button', { name: /use built-in layout/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/templates/list-2',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
    expect(screen.getByLabelText(/template html/i)).toHaveValue(DEFAULT_HTML);
  });
});
