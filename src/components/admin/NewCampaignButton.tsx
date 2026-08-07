'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';

export function NewCampaignButton({ lists }: { lists: { id: string; name: string }[] }) {
  const router = useRouter();
  const [listId, setListId] = useState(lists[0]?.id ?? '');
  const [busy, setBusy] = useState(false);

  if (lists.length === 0) return null;

  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
      {lists.length > 1 && (
        <select
          aria-label="List"
          value={listId}
          onChange={(event) => setListId(event.target.value)}
        >
          {lists.map((list) => (
            <option key={list.id} value={list.id}>
              {list.name}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        className="sm-primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const response = await fetch('/api/admin/campaigns', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ listId }),
            });
            const body = (await response.json()) as { id?: string };
            if (body.id) router.push(`/admin/campaigns/${body.id}`);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Plus aria-hidden />
        New campaign
      </button>
    </div>
  );
}
