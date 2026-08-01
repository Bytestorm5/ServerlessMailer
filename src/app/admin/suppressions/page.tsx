'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Card, EmptyState, ErrorNote, Spinner, inputClass } from '@/components/ui';
import { api, formatDate, formatNumber } from '@/lib/client';
import type { SuppressionDoc } from '@/lib/types';

/**
 * Suppression list view with reason and origin, and a manual add (§4.5).
 *
 * The wording here is deliberate: this list is global, and removing an entry
 * is the single most dangerous action in the application.
 */
export default function SuppressionsPage() {
  const [data, setData] = useState<{ suppressions: SuppressionDoc[]; total: number } | null>(null);
  const [query, setQuery] = useState('');
  const [reason, setReason] = useState('');
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [bulk, setBulk] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: String(page), limit: '50' });
      if (query.trim()) params.set('q', query.trim());
      if (reason) params.set('reason', reason);
      setData(await api(`/api/admin/suppressions?${params.toString()}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [page, query, reason]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  const add = async () => {
    const emails = bulk
      .split(/[\s,;]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (emails.length === 0) return;
    setBusy(true);
    try {
      const result = await api<{ added: number; invalid: number }>('/api/admin/suppressions', {
        method: 'POST',
        json: { emails, reason: 'manual' },
      });
      setNote(`Added ${result.added}, skipped ${result.invalid} malformed.`);
      setBulk('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (email: string) => {
    if (
      !window.confirm(
        `Remove ${email} from the global suppression list?\n\n` +
          'It will become mailable again on every list and every domain. ' +
          'Do this only if you are certain the original bounce or complaint was wrong.',
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await api('/api/admin/suppressions', { method: 'DELETE', json: { email } });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Suppressions</h1>
          <p className="text-sm text-ink-500">
            Global across every list and domain — SES reputation thresholds are account-level.
          </p>
        </div>
        <a href="/api/admin/export/suppressions" className="rounded border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50">
          Export CSV
        </a>
      </div>

      <Card>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-500">Add addresses</h2>
        <p className="mb-2 text-xs text-ink-500">
          Paste addresses separated by commas, spaces or newlines. Import the suppression list from your previous
          provider here <em>before</em> importing any subscribers (§14).
        </p>
        <textarea
          className={`${inputClass} h-24 font-mono text-xs`}
          value={bulk}
          onChange={(event) => setBulk(event.target.value)}
          placeholder="one@example.com&#10;two@example.com"
        />
        <div className="mt-2 flex items-center gap-3">
          <Button variant="primary" disabled={busy || bulk.trim() === ''} onClick={() => void add()}>
            {busy ? <Spinner /> : null} Add to suppression list
          </Button>
          {note ? <span className="text-sm text-ink-600">{note}</span> : null}
        </div>
      </Card>

      <Card className="flex flex-wrap items-end gap-3">
        <label className="block min-w-[240px] flex-1">
          <span className="mb-1 block text-xs font-medium text-ink-600">Search</span>
          <input
            className={inputClass}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
            placeholder="exact email address"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-600">Reason</span>
          <select
            className={inputClass}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              setPage(0);
            }}
          >
            <option value="">All</option>
            {['hard_bounce', 'complaint', 'manual', 'import'].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </Card>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {!data ? (
        <div className="flex items-center gap-2 text-sm text-ink-500">
          <Spinner /> Loading…
        </div>
      ) : data.suppressions.length === 0 ? (
        <EmptyState title="No suppressions match." />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-ink-100 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Reason</th>
                <th className="px-4 py-2">Added</th>
                <th className="px-4 py-2">Detail</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {data.suppressions.map((suppression) => (
                <tr key={String(suppression._id)}>
                  <td className="px-4 py-2 font-mono text-xs">{suppression.email}</td>
                  <td className="px-4 py-2">{suppression.reason}</td>
                  <td className="px-4 py-2 text-ink-600">{formatDate(suppression.createdAt as unknown as string)}</td>
                  <td className="max-w-xs truncate px-4 py-2 text-xs text-ink-500" title={suppression.detail ?? ''}>
                    {suppression.detail ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button variant="ghost" disabled={busy} onClick={() => void remove(suppression.email)}>
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {data ? (
        <div className="flex items-center justify-between text-sm text-ink-600">
          <span>{formatNumber(data.total)} total</span>
          <span className="flex gap-2">
            <Button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              Previous
            </Button>
            <Button disabled={(page + 1) * 50 >= data.total} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </span>
        </div>
      ) : null}
    </div>
  );
}
