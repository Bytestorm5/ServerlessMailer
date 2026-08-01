'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Card, EmptyState, ErrorNote, Spinner, StatusBadge } from '@/components/ui';
import { api, formatDate, formatNumber, formatPercent } from '@/lib/client';
import { clsx } from '@/lib/clsx';
import type { CampaignDoc } from '@/lib/types';
import type { PipelineHealth, ReputationWindow } from '@/lib/reputation';

interface DashboardData {
  reputation: ReputationWindow[];
  health: PipelineHealth;
  lists: { id: string; name: string; active: boolean; confirmed: number; pending: number; unsubscribed: number }[];
  activeCampaigns: CampaignDoc[];
  recentCampaigns: CampaignDoc[];
  suppressionCount: number;
}

const RISK_TONE: Record<string, string> = {
  ok: 'text-emerald-700',
  warning: 'text-amber-700',
  critical: 'text-red-700',
};

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setData(await api<DashboardData>('/api/admin/dashboard'));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
    // A send in flight changes these numbers every minute.
    const timer = setInterval(() => void load(), 20_000);
    return () => clearInterval(timer);
  }, []);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-500">
        <Spinner /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Reputation goes at the top, not in a metrics tab (§8.3). */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">Sender reputation</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {data.reputation.map((window) => (
            <Card key={window.label}>
              <p className="text-sm font-medium text-ink-700">{window.label}</p>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs uppercase tracking-wide text-ink-500">Bounce</p>
                  <p className={clsx('text-2xl font-semibold', RISK_TONE[window.bounceStatus])}>
                    {formatPercent(window.bounceRate)}
                  </p>
                  <p className="text-xs text-ink-500">SES review at 5%, paused at 10%</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-ink-500">Complaint</p>
                  <p className={clsx('text-2xl font-semibold', RISK_TONE[window.complaintStatus])}>
                    {formatPercent(window.complaintRate, 3)}
                  </p>
                  <p className="text-xs text-ink-500">SES review at 0.1%, paused at 0.5%</p>
                </div>
              </div>
              <p className="mt-3 text-xs text-ink-500">
                {formatNumber(window.sent)} sent · {formatNumber(window.delivered)} delivered ·{' '}
                {formatNumber(window.bounced)} bounced · {formatNumber(window.complained)} complaints
              </p>
            </Card>
          ))}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">Send pipeline</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Sending" value={data.health.sendingCampaigns} />
            <Stat label="Paused" value={data.health.pausedCampaigns} tone={data.health.pausedCampaigns > 0 ? 'warn' : undefined} />
            <Stat label="Pending batches" value={data.health.pendingBatches} />
            <Stat label="In flight" value={data.health.claimedBatches} />
            <Stat
              label="Stale leases"
              value={data.health.staleBatches}
              tone={data.health.staleBatches > 0 ? 'warn' : undefined}
            />
            <Stat
              label="Failed batches"
              value={data.health.failedBatches}
              tone={data.health.failedBatches > 0 ? 'bad' : undefined}
            />
            <Stat label="Rate (msg/s)" value={data.health.sendRate} />
            <Stat label="Batches / run" value={data.health.maxBatchesPerRun} />
          </div>
          {data.health.staleBatches > 0 ? (
            <p className="mt-3 text-xs text-ink-500">
              Stale leases recover automatically on the next tick — that is the design, not a fault.
            </p>
          ) : null}
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">Lists</h2>
          <div className="space-y-3">
            {data.lists.map((list) => (
              <div key={list.id} className="flex items-baseline justify-between gap-3">
                <Link href={`/admin/lists/${list.id}`} className="text-sm font-medium hover:underline">
                  {list.name}
                </Link>
                <span className="text-sm text-ink-600">
                  {formatNumber(list.confirmed)}
                  <span className="text-ink-400"> confirmed</span>
                </span>
              </div>
            ))}
            {data.lists.length === 0 ? (
              <p className="text-sm text-ink-500">
                No lists yet. <Link href="/admin/lists" className="underline">Create one</Link>.
              </p>
            ) : null}
            <div className="border-t border-ink-100 pt-3 text-sm text-ink-600">
              <Link href="/admin/suppressions" className="hover:underline">
                {formatNumber(data.suppressionCount)} suppressed addresses
              </Link>
            </div>
          </div>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">In flight</h2>
        {data.activeCampaigns.length === 0 ? (
          <EmptyState title="Nothing sending right now." />
        ) : (
          <div className="space-y-3">
            {data.activeCampaigns.map((campaign) => (
              <CampaignRow key={String(campaign._id)} campaign={campaign} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">Recently completed</h2>
        {data.recentCampaigns.length === 0 ? (
          <EmptyState title="No completed campaigns yet." />
        ) : (
          <div className="space-y-3">
            {data.recentCampaigns.map((campaign) => (
              <CampaignRow key={String(campaign._id)} campaign={campaign} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'warn' | 'bad' }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-ink-500">{label}</p>
      <p
        className={clsx(
          'text-xl font-semibold',
          tone === 'bad' ? 'text-red-700' : tone === 'warn' ? 'text-amber-700' : 'text-ink-900',
        )}
      >
        {formatNumber(value)}
      </p>
    </div>
  );
}

function CampaignRow({ campaign }: { campaign: CampaignDoc }) {
  const progress =
    campaign.counts.recipients > 0
      ? Math.min(100, Math.round(((campaign.counts.sent + campaign.counts.failed) / campaign.counts.recipients) * 100))
      : 0;

  return (
    <Card className="flex flex-wrap items-center gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Link href={`/admin/campaigns/${String(campaign._id)}`} className="truncate font-medium hover:underline">
            {campaign.subject || campaign.name || 'Untitled'}
          </Link>
          <StatusBadge status={campaign.status} />
        </div>
        <p className="mt-1 text-xs text-ink-500">
          {formatNumber(campaign.counts.sent)} / {formatNumber(campaign.counts.recipients)} sent
          {campaign.counts.failed > 0 ? ` · ${formatNumber(campaign.counts.failed)} failed` : ''}
          {campaign.startedAt ? ` · started ${formatDate(campaign.startedAt as unknown as string)}` : ''}
          {campaign.scheduledFor && campaign.status === 'scheduled'
            ? ` · scheduled for ${formatDate(campaign.scheduledFor as unknown as string)}`
            : ''}
        </p>
        {campaign.pauseReason ? (
          <p className="mt-1 text-xs text-amber-800">Paused: {campaign.pauseReason}</p>
        ) : null}
        {campaign.status === 'sending' || campaign.status === 'paused' ? (
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-ink-100">
            <div className="h-full bg-ink-800 transition-all" style={{ width: `${progress}%` }} />
          </div>
        ) : null}
      </div>
      <Link
        href={`/admin/campaigns/${String(campaign._id)}/report`}
        className="rounded border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50"
      >
        Report
      </Link>
    </Card>
  );
}
