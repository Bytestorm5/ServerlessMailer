import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_COOKIE_NAME, createSessionToken } from '@/lib/auth';

// next/headers and next/navigation only resolve inside a request scope, which
// is exactly why the server-side guard lives apart from the pure auth helpers.
const cookieStore = vi.hoisted(() => ({ get: vi.fn() }));
const redirect = vi.hoisted(() =>
  vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
);

vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));
vi.mock('next/navigation', () => ({ redirect }));

const { getAdminSession, requireAdminPage } = await import('@/lib/auth-server');

beforeEach(() => {
  cookieStore.get.mockReset();
  redirect.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getAdminSession', () => {
  it('returns the session for a valid cookie', async () => {
    cookieStore.get.mockReturnValue({ value: createSessionToken('admin') });

    const session = await getAdminSession();

    expect(session?.user).toBe('admin');
    expect(cookieStore.get).toHaveBeenCalledWith(ADMIN_COOKIE_NAME);
  });

  it('returns null when the cookie is absent', async () => {
    cookieStore.get.mockReturnValue(undefined);
    expect(await getAdminSession()).toBeNull();
  });

  it('returns null for a tampered cookie', async () => {
    cookieStore.get.mockReturnValue({ value: `${createSessionToken('admin')}x` });
    expect(await getAdminSession()).toBeNull();
  });

  it('returns null for an expired session', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    cookieStore.get.mockReturnValue({ value: createSessionToken('admin', eightDaysAgo) });

    expect(await getAdminSession()).toBeNull();
  });
});

describe('requireAdminPage', () => {
  it('returns the session when signed in', async () => {
    cookieStore.get.mockReturnValue({ value: createSessionToken('admin') });

    const session = await requireAdminPage();

    expect(session.user).toBe('admin');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('redirects to the sign-in page when not signed in', async () => {
    // Every admin page is wrapped in this; without it the admin UI would be a
    // public write path to campaigns and subscribers.
    cookieStore.get.mockReturnValue(undefined);

    await expect(requireAdminPage()).rejects.toThrow('NEXT_REDIRECT:/login');
    expect(redirect).toHaveBeenCalledWith('/login');
  });
});
