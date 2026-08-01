'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button, ErrorNote, Spinner } from '@/components/ui';
import { api } from '@/lib/client';

interface State {
  ok: boolean;
  email: string;
  status: string;
  listName: string;
}

export function PreferencesForm({ mode }: { mode: 'unsubscribe' | 'preferences' }) {
  const token = useSearchParams().get('t') ?? '';
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'unsubscribed' | 'resubscribed' | null>(null);

  useEffect(() => {
    if (!token) {
      setError('This link is missing its code. Use the link from the bottom of any of our emails.');
      return;
    }
    void (async () => {
      try {
        setState(await api<State>(`/api/preferences?t=${encodeURIComponent(token)}`));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [token]);

  const act = async (action: 'unsubscribe' | 'resubscribe') => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/preferences', { method: 'POST', json: { t: token, action } });
      setDone(action === 'unsubscribe' ? 'unsubscribed' : 'resubscribed');
      setState((current) =>
        current ? { ...current, status: action === 'unsubscribe' ? 'unsubscribed' : 'confirmed' } : current,
      );
    } catch (e) {
      setError(
        e instanceof Error && e.message.includes('suppressed')
          ? 'This address can no longer receive our email because a previous message bounced or was reported as spam.'
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setBusy(false);
    }
  };

  if (error && !state) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <ErrorNote>{error}</ErrorNote>
      </div>
    );
  }

  if (!state) {
    return (
      <p className="flex items-center justify-center gap-2 text-sm text-ink-500">
        <Spinner /> Loading…
      </p>
    );
  }

  const isSubscribed = state.status === 'confirmed' || state.status === 'pending';

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">
          {done === 'unsubscribed'
            ? "You're unsubscribed"
            : done === 'resubscribed'
              ? "You're subscribed again"
              : mode === 'unsubscribe'
                ? 'Unsubscribe'
                : 'Email preferences'}
        </h1>
        <p className="mt-1 text-sm text-ink-600">
          {state.email} · {state.listName}
        </p>
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {done === 'unsubscribed' ? (
        <p className="text-ink-600">
          You won&rsquo;t receive any more email from this list. If that was a mistake, you can resubscribe below.
        </p>
      ) : done === 'resubscribed' ? (
        <p className="text-ink-600">Welcome back. You&rsquo;ll receive the next issue.</p>
      ) : isSubscribed ? (
        <p className="text-ink-600">
          You&rsquo;re currently subscribed. Unsubscribing takes effect immediately.
        </p>
      ) : (
        <p className="text-ink-600">You&rsquo;re not currently subscribed to this list.</p>
      )}

      <div className="flex flex-wrap gap-2">
        {isSubscribed ? (
          <Button variant="danger" disabled={busy} onClick={() => void act('unsubscribe')}>
            {busy ? <Spinner /> : null} Unsubscribe
          </Button>
        ) : (
          <Button variant="primary" disabled={busy} onClick={() => void act('resubscribe')}>
            {busy ? <Spinner /> : null} Resubscribe
          </Button>
        )}
      </div>
    </div>
  );
}
