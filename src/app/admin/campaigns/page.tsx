'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button, Card, EmptyState, ErrorNote, Spinner, StatusBadge } from '@/components/ui';
import { api, formatDate, formatNumber } from '@/lib/client';
import type { CampaignDoc, ListDoc } from '@/lib/types';

interface CampaignsResponse {
  campaigns: CampaignDoc[];
  listNames: Record<string, string>;
}

export default function CampaignsPage() {
  const router = useRouter();
  const [data, setData] = useState<CampaignsResponse | null>(null);
  const [lists, setLists] = useState<ListDoc[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [campaigns, listsResponse] = await Promise.all([
          api<CampaignsResponse>('/api/admin/campaigns'),
          api<{ lists: ListDoc[] }>('/api/admin/lists'),
        ]);
        setData(campaigns);
        setLists(listsResponse.lists);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const create = async (listId: string) => {
    setCreating(true);
    try {
      const result = await api<{ id: string }>('/api/admin/campaigns', {
        method: 'POST',
        json: { listId, name: 'Untitled campaign', subject: '' },
      });
      router.push(`/admin/campaigns/${result.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCreating(false);
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Campaigns</h1>
        <div className="flex items-center gap-2">
          {lists.length === 0 ? (
            <Link href="/admin/lists" className="text-sm underline">
              Create a list first
            </Link>
          ) : lists.length === 1 ? (
            <Button variant="primary" disabled={creating} onClick={() => void create(String(lists[0]!._id))}>
              {creating ? <Spinner /> : null} New campaign
            </Button>
          ) : (
            <select
              className="rounded border border-ink-200 bg-white px-3 py-1.5 text-sm"
              defaultValue=""
              disabled={creating}
              onChange={(event) => {
                if (event.target.value) void create(event.target.value);
              }}
            >
              <option value="">New campaign in…</option>
              {lists.map((list) => (
                <option key={String(list._id)} value={String(list._id)}>
                  {list.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {data.campaigns.length === 0 ? (
        <EmptyState title="No campaigns yet.">Start one and it saves as you type.</EmptyState>
      ) : (
        <div className="space-y-2">
          {data.campaigns.map((campaign) => (
            <Card key={String(campaign._id)} className="flex flex-wrap items-center gap-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Link href={`/admin/campaigns/${String(campaign._id)}`} className="truncate font-medium hover:underline">
                    {campaign.subject || campaign.name || 'Untitled'}
                  </Link>
                  <StatusBadge status={campaign.status} />
                </div>
                <p className="mt-0.5 text-xs text-ink-500">
                  {data.listNames[String(campaign.listId)] ?? 'Unknown list'} · updated{' '}
                  {formatDate(campaign.updatedAt as unknown as string)}
                  {campaign.counts.recipients > 0
                    ? ` · ${formatNumber(campaign.counts.sent)}/${formatNumber(campaign.counts.recipients)} sent`
                    : ''}
                </p>
              </div>
              {campaign.status !== 'draft' ? (
                <Link
                  href={`/admin/campaigns/${String(campaign._id)}/report`}
                  className="rounded border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50"
                >
                  Report
                </Link>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
