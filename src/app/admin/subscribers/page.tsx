'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, EmptyState, ErrorNote, Spinner, StatusBadge, inputClass } from '@/components/ui';
import { api, formatDate, formatNumber } from '@/lib/client';
import type { ListDoc, SubscriberDoc } from '@/lib/types';

/** Subscriber list with search, status filter and sorting (§4.5). */
export default function SubscribersPage() {
  const [lists, setLists] = useState<ListDoc[]>([]);
  const [listId, setListId] = useState('');
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'createdAt' | 'email'>('createdAt');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);

  const [data, setData] = useState<{ subscribers: SubscriberDoc[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const response = await api<{ lists: ListDoc[] }>('/api/admin/lists');
      setLists(response.lists);
      if (response.lists.length > 0) setListId(String(response.lists[0]!._id));
    })();
  }, []);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ sort, dir, page: String(page), limit: '50' });
      if (listId) params.set('listId', listId);
      if (status) params.set('status', status);
      if (query.trim()) params.set('q', query.trim());
      setData(await api(`/api/admin/subscribers?${params.toString()}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [dir, listId, page, query, sort, status]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  const exportUrl = () => {
    const params = new URLSearchParams({ listId });
    if (status) params.set('status', status);
    return `/api/admin/export/subscribers?${params.toString()}`;
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Subscribers</h1>
        {listId ? (
          <a href={exportUrl()} className="rounded border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50">
            Export CSV
          </a>
        ) : null}
      </div>

      <Card className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-600">List</span>
          <select className={inputClass} value={listId} onChange={(e) => { setListId(e.target.value); setPage(0); }}>
            {lists.map((list) => (
              <option key={String(list._id)} value={String(list._id)}>
                {list.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-600">Status</span>
          <select className={inputClass} value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
            <option value="">All</option>
            {['confirmed', 'pending', 'unsubscribed', 'bounced', 'complained'].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="block min-w-[240px] flex-1">
          <span className="mb-1 block text-xs font-medium text-ink-600">Search by email</span>
          <input
            className={inputClass}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(0); }}
            placeholder="exact address, or the start of one"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-600">Sort</span>
          <select
            className={inputClass}
            value={`${sort}:${dir}`}
            onChange={(e) => {
              const [nextSort, nextDir] = e.target.value.split(':');
              setSort(nextSort as 'createdAt' | 'email');
              setDir(nextDir as 'asc' | 'desc');
            }}
          >
            <option value="createdAt:desc">Newest first</option>
            <option value="createdAt:asc">Oldest first</option>
            <option value="email:asc">Email A→Z</option>
            <option value="email:desc">Email Z→A</option>
          </select>
        </label>
      </Card>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {!data ? (
        <div className="flex items-center gap-2 text-sm text-ink-500">
          <Spinner /> Loading…
        </div>
      ) : data.subscribers.length === 0 ? (
        <EmptyState title="No subscribers match." />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-ink-100 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Source</th>
                <th className="px-4 py-2">Signed up</th>
                <th className="px-4 py-2">Confirmed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {data.subscribers.map((subscriber) => (
                <tr key={String(subscriber._id)} className="hover:bg-ink-50">
                  <td className="px-4 py-2">
                    <Link href={`/admin/subscribers/${String(subscriber._id)}`} className="hover:underline">
                      {subscriber.email}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={subscriber.status} />
                  </td>
                  <td className="px-4 py-2 text-ink-600">{subscriber.source}</td>
                  <td className="px-4 py-2 text-ink-600">{formatDate(subscriber.createdAt as unknown as string)}</td>
                  <td className="px-4 py-2 text-ink-600">
                    {formatDate(subscriber.confirmedAt as unknown as string)}
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
