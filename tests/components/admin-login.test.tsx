// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginForm } from '@/components/admin/LoginForm';

// The router is the thing that must *not* move when a sign-in fails, so the
// mock is captured rather than anonymous.
const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, refresh: nav.refresh }),
}));

interface StubbedResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function jsonResponse(status: number, body: unknown): StubbedResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** A response whose body is not JSON at all (a proxy error page, say). */
function brokenBodyResponse(status: number): StubbedResponse {
  return {
    ok: false,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  };
}

function stubFetch(impl: (url: string, init: RequestInit) => unknown) {
  const fetchMock = vi.fn(async (url: unknown, init: unknown) =>
    impl(String(url), (init ?? {}) as RequestInit),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function lastBody(fetchMock: ReturnType<typeof stubFetch>): Record<string, unknown> {
  const init = fetchMock.mock.calls.at(-1)![1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

async function signIn(password = 'test-admin-password') {
  const user = userEvent.setup();
  render(<LoginForm />);
  await user.type(screen.getByLabelText(/password/i), password);
  await user.click(screen.getByRole('button', { name: /sign in/i }));
  return user;
}

beforeEach(() => {
  nav.push.mockClear();
  nav.refresh.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LoginForm — the request', () => {
  it('posts the typed password as JSON to the session endpoint', async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, { ok: true }));

    await signIn('hunter2');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/session');
    expect(init.method).toBe('POST');
    expect(String((init.headers as Record<string, string>)['content-type'])).toContain(
      'application/json',
    );
    expect(lastBody(fetchMock)).toEqual({ password: 'hunter2' });
  });

  it('will not submit an empty password at all', async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, { ok: true }));
    render(<LoginForm />);

    expect(screen.getByRole('button', { name: /sign in/i })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not echo the password into the DOM in readable form', async () => {
    // A shoulder-surfable admin password on a shared screen is a real risk and
    // the masking is one attribute away from being lost in a refactor.
    stubFetch(() => jsonResponse(200, { ok: true }));
    render(<LoginForm />);

    expect(screen.getByLabelText(/password/i)).toHaveAttribute('type', 'password');
  });
});

describe('LoginForm — a rejected sign-in', () => {
  it('shows the server error and does NOT navigate into the admin', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse(401, { ok: false, error: 'invalid credentials' }),
    );

    await signIn('wrong-password');

    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid credentials/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(nav.push).not.toHaveBeenCalled();
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it('falls back to a generic failure when the body is not JSON', async () => {
    stubFetch(() => brokenBodyResponse(500));

    await signIn();

    expect(await screen.findByRole('alert')).toHaveTextContent(/sign-in failed/i);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('tells the operator to wait when the attempt was rate limited (429)', async () => {
    // The endpoint rate limits per IP; without this branch the operator sees
    // "too many attempts" as a credentials problem and keeps hammering it.
    stubFetch(() => jsonResponse(429, { ok: false, error: 'too many attempts' }));

    await signIn();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/too many attempts/i);
    expect(alert).toHaveTextContent(/wait a few minutes/i);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('reports an unreachable server rather than failing silently', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });

    await signIn();

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not reach the server/i);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('re-enables the form so a second attempt is possible', async () => {
    const fetchMock = stubFetch(() => jsonResponse(401, { error: 'invalid credentials' }));

    const user = await signIn('wrong-password');
    await screen.findByRole('alert');

    const button = screen.getByRole('button', { name: /sign in/i });
    await waitFor(() => expect(button).toBeEnabled());

    await user.click(button);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('clears the previous error once a retry succeeds', async () => {
    let attempt = 0;
    stubFetch(() => {
      attempt += 1;
      return attempt === 1
        ? jsonResponse(401, { error: 'invalid credentials' })
        : jsonResponse(200, { ok: true });
    });

    const user = await signIn('wrong-password');
    await screen.findByRole('alert');

    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/admin'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('LoginForm — a successful sign-in', () => {
  it('navigates to /admin and refreshes so the new session cookie is picked up', async () => {
    stubFetch(() => jsonResponse(200, { ok: true }));

    await signIn();

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/admin'));
    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a busy state and cannot be double-submitted while in flight', async () => {
    let release: (value: StubbedResponse) => void = () => {};
    const pending = new Promise<StubbedResponse>((resolve) => {
      release = resolve;
    });
    const fetchMock = stubFetch(() => pending);

    const user = userEvent.setup();
    render(<LoginForm />);
    await user.type(screen.getByLabelText(/password/i), 'test-admin-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const button = await screen.findByRole('button', { name: /signing in/i });
    await waitFor(() => expect(button).toBeDisabled());
    await user.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release(jsonResponse(200, { ok: true }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/admin'));
  });
});
