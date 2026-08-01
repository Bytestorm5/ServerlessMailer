'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function LoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const response = await fetch('/api/admin/session', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password }),
          });
          if (!response.ok) {
            const body = (await response.json().catch(() => ({}))) as { error?: string };
            setError(
              response.status === 429
                ? 'Too many attempts. Wait a few minutes and try again.'
                : body.error ?? 'Sign-in failed.',
            );
            return;
          }
          router.push('/admin');
          router.refresh();
        } catch {
          setError('Could not reach the server.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <label htmlFor="password" style={{ display: 'block', marginBottom: '0.35rem' }}>
        Password
      </label>
      <input
        id="password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        style={{ width: '100%', marginBottom: '0.75rem' }}
      />
      {error && (
        <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.9rem' }}>
          {error}
        </p>
      )}
      <button type="submit" className="sm-primary" disabled={busy || !password}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
