'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, ErrorNote, Spinner, StatusBadge } from '@/components/ui';
import { api, formatDate, formatNumber, formatPercent } from '@/lib/client';
import type { CampaignBatchDoc, CampaignDoc, ListDoc } from '@/lib/types';

interface ReportResponse {
  campaign: CampaignDoc;
  list: ListDoc | null;
  batches: Record<string, { batches: number; recipients: number }>;
  failedBatches: CampaignBatchDoc[];
  sentTotal: number;
  topLinks: { _id: string; clicks: number; uniqueSubscribers: number }[];
  rates: {
    openRate: number;
    clickRate: number;
    bounceRate: number;
    complaintRate: number;
    unsubscribeRate: number;
  };
}

export function CampaignReport({ campaignId }: { campaignId: string }) {
  const [data, setData] = useState<ReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<ReportResponse>(`/api/admin/campaigns/${campaignId}/report`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const control = async (action: string) => {
    setBusy(true);
    try {
      await api(`/api/admin/campaigns/${campaignId}/control`, { method: 'POST', json: { action } });
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

  const { campaign, counts } = { campaign: data.campaign, counts: data.campaign.counts };
  const progress =
    counts.recipients > 0 ? Math.min(100, Math.round(((counts.sent + counts.failed) / counts.recipients) * 100)) : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-xl font-semibold">{campaign.subject || campaign.name}</h1>
            <StatusBadge status={campaign.status} />
          </div>
          <p className="text-xs text-ink-500">
            {data.list?.name} · started {formatDate(campaign.startedAt as unknown as string)}
            {campaign.completedAt ? ` · completed ${formatDate(campaign.completedAt as unknown as string)}` : ''}
          </p>
        </div>
        <Link href={`/admin/campaigns/${campaignId}`} className="rounded border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50">
          Open campaign
        </Link>
        {campaign.status === 'sending' ? (
          <Button variant="danger" disabled={busy} onClick={() => void control('pause')}>
            Pause
          </Button>
        ) : null}
        {campaign.status === 'paused' ? (
          <>
            <Button variant="primary" disabled={busy} onClick={() => void control('resume')}>
              Resume
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void control('cancel')}>
              Abort
            </Button>
          </>
        ) : null}
      </div>

      {campaign.pauseReason ? (
        <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>Paused.</strong> {campaign.pauseReason}
        </div>
      ) : null}

      {campaign.status === 'sending' || campaign.status === 'paused' ? (
        <Card>
          <div className="flex items-baseline justify-between">
            <p className="text-sm font-medium">Progress</p>
            <p className="text-sm text-ink-600">
              {formatNumber(counts.sent + counts.failed)} / {formatNumber(counts.recipients)} ({progress}%)
            </p>
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded bg-ink-100">
            <div className="h-full bg-ink-800 transition-all" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-2 text-xs text-ink-500">
            {formatNumber(data.batches.pending?.batches ?? 0)} batches waiting ·{' '}
            {formatNumber(data.batches.claimed?.batches ?? 0)} in flight ·{' '}
            {formatNumber(data.batches.sent?.batches ?? 0)} done
          </p>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Recipients" value={formatNumber(counts.recipients)} />
        <Metric label="Sent" value={formatNumber(data.sentTotal)} />
        <Metric label="Delivered" value={formatNumber(counts.delivered)} />
        <Metric label="Failed" value={formatNumber(counts.failed)} tone={counts.failed > 0 ? 'bad' : undefined} />
        <Metric
          label="Bounced"
          value={`${formatNumber(counts.bounced)} (${formatPercent(data.rates.bounceRate)})`}
          tone={data.rates.bounceRate > 0.05 ? 'bad' : undefined}
        />
        <Metric
          label="Complaints"
          value={`${formatNumber(counts.complained)} (${formatPercent(data.rates.complaintRate, 3)})`}
          tone={data.rates.complaintRate > 0.001 ? 'bad' : undefined}
        />
        <Metric label="Unsubscribed" value={formatNumber(counts.unsubscribed)} />
        <Metric
          label="Opens (approx.)"
          value={campaign.trackOpens ? `${formatNumber(counts.opened)} (${formatPercent(data.rates.openRate, 1)})` : 'untracked'}
          hint={campaign.trackOpens ? 'Inflated by Apple Mail Privacy Protection' : undefined}
        />
      </div>

      {campaign.trackClicks ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">Top clicked links</h2>
          {data.topLinks.length === 0 ? (
            <p className="text-sm text-ink-500">No clicks recorded yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-500">
                  <th className="pb-2">URL</th>
                  <th className="pb-2 text-right">Clicks</th>
                  <th className="pb-2 text-right">People</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {data.topLinks.map((link) => (
                  <tr key={link._id}>
                    <td className="max-w-0 truncate py-2 pr-4">
                      <a href={link._id} target="_blank" rel="noopener noreferrer" className="hover:underline">
                        {link._id}
                      </a>
                    </td>
                    <td className="py-2 text-right">{formatNumber(link.clicks)}</td>
                    <td className="py-2 text-right">{formatNumber(link.uniqueSubscribers)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      ) : null}

      {data.failedBatches.length > 0 ? (
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-red-700">Failed batches</h2>
            <Button disabled={busy} onClick={() => void control('retry_failed_batches')}>
              Re-queue failed batches
            </Button>
          </div>
          <ul className="space-y-2 text-sm">
            {data.failedBatches.map((batch) => (
              <li key={String(batch._id)} className="rounded border border-red-200 bg-red-50 p-3">
                <p className="font-mono text-xs text-ink-600">
                  {String(batch._id)} · {batch.subscriberIds.length} recipients · {batch.attempts} attempts
                </p>
                <p className="mt-1 text-red-900">{batch.lastError ?? 'No error recorded'}</p>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: 'bad';
  hint?: string;
}) {
  return (
    <Card>
      <p className="text-xs uppercase tracking-wide text-ink-500">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${tone === 'bad' ? 'text-red-700' : 'text-ink-900'}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-ink-500">{hint}</p> : null}
    </Card>
  );
}
