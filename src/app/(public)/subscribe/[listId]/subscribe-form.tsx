'use client';

import { useState } from 'react';
import { Button, Spinner, inputClass } from '@/components/ui';

export function SubscribeForm({
  listId,
  listName,
  turnstileSiteKey,
}: {
  listId: string;
  listName: string;
  turnstileSiteKey: string | null;
}) {
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [website, setWebsite] = useState(''); // honeypot
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          listId,
          email,
          website,
          attributes: firstName.trim() ? { first_name: firstName.trim() } : undefined,
        }),
      });
    } finally {
      // The response is identical whatever the address's state, so the UI
      // shows the same thing in every case (§5.1).
      setDone(true);
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="space-y-3 text-center">
        <h1 className="text-xl font-semibold">Check your inbox</h1>
        <p className="text-ink-600">
          If that address can be subscribed, a confirmation link is on its way. You need to click it before you
          receive anything else — that&rsquo;s how we keep the list honest.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Subscribe to {listName}</h1>
        <p className="mt-1 text-sm text-ink-600">
          We&rsquo;ll email you a link to confirm. One click to unsubscribe, always.
        </p>
      </div>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-700">First name (optional)</span>
        <input className={inputClass} value={firstName} onChange={(event) => setFirstName(event.target.value)} />
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-700">Email address</span>
        <input
          className={inputClass}
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>

      {/* Honeypot. Hidden from people, irresistible to naive bots. */}
      <div aria-hidden="true" className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
        <label>
          Website
          <input
            tabIndex={-1}
            autoComplete="off"
            value={website}
            onChange={(event) => setWebsite(event.target.value)}
          />
        </label>
      </div>

      {turnstileSiteKey ? (
        <div className="cf-turnstile" data-sitekey={turnstileSiteKey} />
      ) : null}

      <Button type="submit" variant="primary" disabled={busy} className="w-full justify-center">
        {busy ? <Spinner /> : null} Subscribe
      </Button>
    </form>
  );
}
