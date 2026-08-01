'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/** Manual suppression add (spec section 4.5). */
export function SuppressionControls() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  return (
    <form
      style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '1rem' }}
      onSubmit={async (event) => {
        event.preventDefault();
        setMessage(null);
        const response = await fetch('/api/admin/suppressions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const body = (await response.json().catch(() => ({}))) as {
          created?: boolean;
          error?: string;
        };
        if (!response.ok) {
          setMessage(body.error ?? 'Could not suppress that address.');
          return;
        }
        setMessage(body.created ? 'Suppressed.' : 'That address was already suppressed.');
        setEmail('');
        router.refresh();
      }}
    >
      <label htmlFor="suppress-email">Suppress an address</label>
      <input
        id="suppress-email"
        type="email"
        value={email}
        placeholder="person@example.com"
        onChange={(e) => setEmail(e.target.value)}
      />
      <button type="submit" disabled={!email}>
        Add
      </button>
      {message && (
        <span role="status" className="muted">
          {message}
        </span>
      )}
    </form>
  );
}
