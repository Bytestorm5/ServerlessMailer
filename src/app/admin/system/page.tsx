'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Card, ErrorNote, Spinner } from '@/components/ui';
import { api } from '@/lib/client';

interface SystemResponse {
  invariants: {
    sentLogUniqueIndex: boolean;
    suppressionsUniqueIndex: boolean;
    subscribersUniqueIndex: boolean;
  };
  config: Record<string, string | number | boolean>;
}

/**
 * Operational status.
 *
 * The invariants block is the answer to "duplicate sends reported" in the
 * runbook (§15): the unique index on `sent_log` is what makes a double-send
 * impossible, so its existence is checkable in one click rather than by
 * connecting to the database.
 */
export default function SystemPage() {
  const [data, setData] = useState<SystemResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<SystemResponse>('/api/admin/system'));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const ensureIndexes = async () => {
    setBusy(true);
    setNote(null);
    try {
      const result = await api<{ indexes: string[] }>('/api/admin/system', {
        method: 'POST',
        json: { action: 'ensure_indexes' },
      });
      setNote(`${result.indexes.length} indexes asserted.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-500">
        <Spinner /> Loading…
      </div>
    );
  }

  const invariants: [string, boolean, string][] = [
    [
      'sent_log unique on (campaignId, subscriberId)',
      data.invariants.sentLogUniqueIndex,
      'The database-level guarantee against double-sends. Everything else is an optimisation.',
    ],
    [
      'suppressions unique on (email)',
      data.invariants.suppressionsUniqueIndex,
      'Makes suppression writes idempotent under at-least-once SNS delivery.',
    ],
    [
      'subscribers unique on (listId, email)',
      data.invariants.subscribersUniqueIndex,
      'Makes import idempotent and prevents duplicate consent records.',
    ],
  ];

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">System</h1>

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Invariants</h2>
          <Button disabled={busy} onClick={() => void ensureIndexes()}>
            {busy ? <Spinner /> : null} Assert indexes
          </Button>
        </div>
        <ul className="space-y-3">
          {invariants.map(([label, ok, why]) => (
            <li key={label} className="flex gap-3">
              <span className={ok ? 'text-emerald-600' : 'text-red-600'}>{ok ? '✓' : '✕'}</span>
              <span>
                <span className={ok ? 'text-ink-800' : 'font-medium text-red-800'}>{label}</span>
                <span className="block text-xs text-ink-500">{why}</span>
              </span>
            </li>
          ))}
        </ul>
        {note ? <p className="mt-3 text-sm text-emerald-700">{note}</p> : null}
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">Runtime configuration</h2>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          {Object.entries(data.config).map(([key, value]) => (
            <div key={key} className="flex gap-3">
              <dt className="w-56 shrink-0 text-ink-500">{key}</dt>
              <dd className="min-w-0 break-words font-mono text-xs text-ink-900">{String(value)}</dd>
            </div>
          ))}
        </dl>
        {data.config.mailerDriver === 'console' ? (
          <p className="mt-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            The mailer driver is <strong>console</strong>: messages are written to the logs, not sent. Set{' '}
            <code>MAILER_DRIVER=ses</code> to send for real.
          </p>
        ) : null}
      </Card>
    </div>
  );
}
