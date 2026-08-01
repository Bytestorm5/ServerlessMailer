'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button, Card, EmptyState, ErrorNote, Field, Spinner, inputClass } from '@/components/ui';
import { api, formatNumber } from '@/lib/client';
import type { ListDoc } from '@/lib/types';

type ListWithCounts = ListDoc & { counts: Record<string, number> };

export default function ListsPage() {
  const router = useRouter();
  const [lists, setLists] = useState<ListWithCounts[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    name: '',
    sendingDomain: '',
    fromName: '',
    fromEmail: '',
    replyTo: '',
    physicalAddress: '',
    sesConfigurationSet: '',
  });

  const load = async () => {
    try {
      const data = await api<{ lists: ListWithCounts[] }>('/api/admin/lists');
      setLists(data.lists);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const result = await api<{ id: string }>('/api/admin/lists', { method: 'POST', json: form });
      router.push(`/admin/lists/${result.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Lists</h1>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {!lists ? (
        <div className="flex items-center gap-2 text-sm text-ink-500">
          <Spinner /> Loading…
        </div>
      ) : lists.length === 0 ? (
        <EmptyState title="No lists yet.">One list per newsletter, i.e. per sending domain.</EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {lists.map((list) => (
            <Card key={String(list._id)}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Link href={`/admin/lists/${String(list._id)}`} className="font-medium hover:underline">
                    {list.name}
                  </Link>
                  <p className="text-xs text-ink-500">{list.sendingDomain}</p>
                </div>
                {!list.active ? <span className="text-xs text-amber-700">inactive</span> : null}
              </div>
              <p className="mt-3 text-sm text-ink-600">
                {formatNumber(list.counts.confirmed ?? 0)} confirmed · {formatNumber(list.counts.pending ?? 0)} pending ·{' '}
                {formatNumber(list.counts.unsubscribed ?? 0)} unsubscribed
              </p>
              <p className="mt-1 text-xs text-ink-500">
                From {list.fromName} &lt;{list.fromEmail}&gt; · reply-to {list.replyTo}
              </p>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">New list</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Name" hint="Shown in the admin UI and in the email header.">
            <input
              className={inputClass}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Domain A Weekly"
            />
          </Field>
          <Field label="Sending domain" hint="A dedicated subdomain keeps bulk reputation off your root domain.">
            <input
              className={inputClass}
              value={form.sendingDomain}
              onChange={(e) => setForm({ ...form, sendingDomain: e.target.value })}
              placeholder="news.domain-a.com"
            />
          </Field>
          <Field label="From name">
            <input
              className={inputClass}
              value={form.fromName}
              onChange={(e) => setForm({ ...form, fromName: e.target.value })}
              placeholder="Domain A"
            />
          </Field>
          <Field label="From email">
            <input
              className={inputClass}
              value={form.fromEmail}
              onChange={(e) => setForm({ ...form, fromEmail: e.target.value })}
              placeholder="hello@news.domain-a.com"
            />
          </Field>
          <Field label="Reply-to" hint="A real, monitored address on the root domain (§11).">
            <input
              className={inputClass}
              value={form.replyTo}
              onChange={(e) => setForm({ ...form, replyTo: e.target.value })}
              placeholder="hello@domain-a.com"
            />
          </Field>
          <Field label="SES configuration set" hint="Needed for bounce and complaint feedback.">
            <input
              className={inputClass}
              value={form.sesConfigurationSet}
              onChange={(e) => setForm({ ...form, sesConfigurationSet: e.target.value })}
              placeholder="domain-a-newsletter"
            />
          </Field>
          <div className="md:col-span-2">
            <Field label="Physical postal address" hint="Legally required in every email. Appears in the footer.">
              <textarea
                className={`${inputClass} h-20`}
                value={form.physicalAddress}
                onChange={(e) => setForm({ ...form, physicalAddress: e.target.value })}
                placeholder="Company Ltd, 1 Example Street, Town, Country"
              />
            </Field>
          </div>
        </div>
        <Button
          className="mt-4"
          variant="primary"
          disabled={creating || !form.name || !form.fromEmail || !form.physicalAddress}
          onClick={() => void create()}
        >
          {creating ? <Spinner /> : null} Create list
        </Button>
      </Card>
    </div>
  );
}
