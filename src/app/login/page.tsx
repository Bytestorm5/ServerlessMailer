'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Button, ErrorNote, Field, Spinner, inputClass } from '@/components/ui';
import { api } from '@/lib/client';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/login', { method: 'POST', json: { email, password } });
      router.push(params.get('next') ?? '/admin');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border border-ink-200 bg-white p-6 shadow-sm">
      <div>
        <h1 className="text-lg font-semibold">ServerlessMailer</h1>
        <p className="text-sm text-ink-500">Sign in to continue.</p>
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <Field label="Email">
        <input
          className={inputClass}
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </Field>
      <Field label="Password">
        <input
          className={inputClass}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </Field>
      <Button type="submit" variant="primary" disabled={busy} className="w-full justify-center">
        {busy ? <Spinner /> : null} Sign in
      </Button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Suspense fallback={<Spinner />}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
