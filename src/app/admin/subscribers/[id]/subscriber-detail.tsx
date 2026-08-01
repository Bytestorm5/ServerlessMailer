'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, ErrorNote, Spinner, StatusBadge } from '@/components/ui';
import { api, formatDate } from '@/lib/client';
import type { CampaignDoc, EventDoc, ListDoc, SentLogDoc, SubscriberDoc, SuppressionDoc } from '@/lib/types';

interface DetailResponse {
  subscriber: SubscriberDoc;
  list: ListDoc | null;
  sent: SentLogDoc[];
  events: EventDoc[];
  campaigns: CampaignDoc[];
  suppression: SuppressionDoc | null;
}

/** Individual subscriber detail (§4.5): status, consent evidence, campaigns, events. */
export function SubscriberDetail({ subscriberId }: { subscriberId: string }) {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<DetailResponse>(`/api/admin/subscribers/${subscriberId}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [subscriberId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: 'unsubscribe' | 'resubscribe') => {
    setBusy(true);
    try {
      await api(`/api/admin/subscribers/${subscriberId}`, { method: 'PATCH', json: { action } });
      await load();
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !data) return <ErrorNote>{error}</ErrorNote>;
  if (!data) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-500">
        <Spinner /> Loading…
      </div>
    );
  }

  const { subscriber } = data;
  const campaignsById = new Map(data.campaigns.map((campaign) => [String(campaign._id), campaign]));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-xl font-semibold">{subscriber.email}</h1>
            <StatusBadge status={subscriber.status} />
          </div>
          <p className="text-xs text-ink-500">{data.list?.name}</p>
        </div>
        {subscriber.status !== 'unsubscribed' ? (
          <Button disabled={busy} onClick={() => void act('unsubscribe')}>
            Unsubscribe
          </Button>
        ) : (
          <Button disabled={busy} onClick={() => void act('resubscribe')}>
            Resubscribe
          </Button>
        )}
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {data.suppression ? (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
          <strong>Globally suppressed</strong> ({data.suppression.reason}) on{' '}
          {formatDate(data.suppression.createdAt as unknown as string)}.{' '}
          {data.suppression.detail ? <span className="block text-xs">{data.suppression.detail}</span> : null}
          <span className="mt-1 block text-xs">
            This address is excluded from every list on every domain. Removing a suppression is done from{' '}
            <Link href="/admin/suppressions" className="underline">
              Suppressions
            </Link>
            .
          </span>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">Consent evidence</h2>
          <p className="mb-3 text-xs text-ink-500">
            Append-only. This is the record you produce if a complaint is ever escalated.
          </p>
          <dl className="space-y-2 text-sm">
            <Row label="Signed up">{formatDate(subscriber.createdAt as unknown as string)}</Row>
            <Row label="Source">{subscriber.source}</Row>
            <Row label="Confirmed">{formatDate(subscriber.confirmedAt as unknown as string)}</Row>
            <Row label="Confirm IP">{subscriber.confirmIp ?? '—'}</Row>
            <Row label="User agent">
              <span className="break-words text-xs">{subscriber.confirmUserAgent ?? '—'}</span>
            </Row>
            {subscriber.confirmAttestationId ? (
              <Row label="Consent basis">
                Imported under an operator attestation of prior opt-in (job {String(subscriber.confirmAttestationId)})
              </Row>
            ) : null}
            <Row label="Unsubscribed">
              {formatDate(subscriber.unsubscribedAt as unknown as string)}
              {subscriber.unsubscribeSource ? ` (${subscriber.unsubscribeSource})` : ''}
            </Row>
            <Row label="Bounced">{formatDate(subscriber.bouncedAt as unknown as string)}</Row>
            <Row label="Complained">{formatDate(subscriber.complainedAt as unknown as string)}</Row>
          </dl>
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">Attributes</h2>
          {Object.keys(subscriber.attributes ?? {}).length === 0 ? (
            <p className="text-sm text-ink-500">No merge attributes stored.</p>
          ) : (
            <dl className="space-y-2 text-sm">
              {Object.entries(subscriber.attributes).map(([key, value]) => (
                <Row key={key} label={key}>
                  {value}
                </Row>
              ))}
            </dl>
          )}
        </Card>
      </div>

      <Card>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">Campaigns sent</h2>
        {data.sent.length === 0 ? (
          <p className="text-sm text-ink-500">None yet.</p>
        ) : (
          <ul className="divide-y divide-ink-100 text-sm">
            {data.sent.map((entry) => {
              const campaign = campaignsById.get(String(entry.campaignId));
              return (
                <li key={String(entry._id)} className="flex items-center justify-between gap-3 py-2">
                  <Link href={`/admin/campaigns/${String(entry.campaignId)}`} className="truncate hover:underline">
                    {campaign?.subject ?? String(entry.campaignId)}
                  </Link>
                  <span className="shrink-0 text-xs text-ink-500">{formatDate(entry.sentAt as unknown as string)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">Events</h2>
        {data.events.length === 0 ? (
          <p className="text-sm text-ink-500">No events received.</p>
        ) : (
          <ul className="divide-y divide-ink-100 text-sm">
            {data.events.map((event) => (
              <li key={String(event._id)} className="flex items-baseline gap-3 py-2">
                <span className="w-24 shrink-0 font-medium capitalize">{event.type}</span>
                <span className="min-w-0 flex-1 truncate text-ink-600">
                  {event.url ?? event.detail ?? ''}
                </span>
                <span className="shrink-0 text-xs text-ink-500">{formatDate(event.ts as unknown as string)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-32 shrink-0 text-ink-500">{label}</dt>
      <dd className="min-w-0 flex-1 text-ink-900">{children}</dd>
    </div>
  );
}
