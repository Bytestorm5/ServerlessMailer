'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Card, ErrorNote, Field, Spinner, inputClass } from '@/components/ui';
import { api } from '@/lib/client';
import type { ListDoc } from '@/lib/types';

export function ListEditor({ listId }: { listId: string }) {
  const [list, setList] = useState<ListDoc | null>(null);
  const [identityVerified, setIdentityVerified] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api<{ list: ListDoc; identityVerified: boolean | null }>(`/api/admin/lists/${listId}`);
      setList(data.list);
      setIdentityVerified(data.identityVerified);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [listId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!list) return;
    setSaving(true);
    setSaved(false);
    try {
      await api(`/api/admin/lists/${listId}`, {
        method: 'PATCH',
        json: {
          name: list.name,
          sendingDomain: list.sendingDomain,
          fromName: list.fromName,
          fromEmail: list.fromEmail,
          replyTo: list.replyTo,
          physicalAddress: list.physicalAddress,
          sesConfigurationSet: list.sesConfigurationSet,
          welcomeUrl: list.welcomeUrl ?? '',
          mergeFields: list.mergeFields ?? [],
          seedEmails: list.seedEmails ?? [],
          active: list.active,
        },
      });
      setSaved(true);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (error && !list) return <ErrorNote>{error}</ErrorNote>;
  if (!list) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-500">
        <Spinner /> Loading…
      </div>
    );
  }

  const patch = (partial: Partial<ListDoc>) => setList({ ...list, ...partial } as ListDoc);
  const signupUrl = typeof window !== 'undefined' ? `${window.location.origin}/subscribe/${listId}` : '';

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">{list.name}</h1>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {identityVerified === false ? (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
          SES does not report <strong>{list.fromEmail}</strong> as verified for sending. Campaigns from this list
          will not pass the pre-send gate until the identity is verified with DKIM (§10.1).
        </div>
      ) : null}

      <Card>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Name">
            <input className={inputClass} value={list.name} onChange={(e) => patch({ name: e.target.value })} />
          </Field>
          <Field label="Sending domain">
            <input
              className={inputClass}
              value={list.sendingDomain}
              onChange={(e) => patch({ sendingDomain: e.target.value })}
            />
          </Field>
          <Field label="From name">
            <input className={inputClass} value={list.fromName} onChange={(e) => patch({ fromName: e.target.value })} />
          </Field>
          <Field label="From email">
            <input
              className={inputClass}
              value={list.fromEmail}
              onChange={(e) => patch({ fromEmail: e.target.value })}
            />
          </Field>
          <Field label="Reply-to">
            <input className={inputClass} value={list.replyTo} onChange={(e) => patch({ replyTo: e.target.value })} />
          </Field>
          <Field label="SES configuration set">
            <input
              className={inputClass}
              value={list.sesConfigurationSet}
              onChange={(e) => patch({ sesConfigurationSet: e.target.value })}
            />
          </Field>
          <Field label="Welcome URL" hint="Where a confirmed subscriber lands. Defaults to the built-in page.">
            <input
              className={inputClass}
              value={list.welcomeUrl ?? ''}
              onChange={(e) => patch({ welcomeUrl: e.target.value })}
              placeholder="https://domain-a.com/thanks"
            />
          </Field>
          <Field label="Active">
            <select
              className={inputClass}
              value={list.active ? 'yes' : 'no'}
              onChange={(e) => patch({ active: e.target.value === 'yes' })}
            >
              <option value="yes">Accepting signups</option>
              <option value="no">Closed to new signups</option>
            </select>
          </Field>
          <div className="md:col-span-2">
            <Field label="Physical postal address">
              <textarea
                className={`${inputClass} h-20`}
                value={list.physicalAddress}
                onChange={(e) => patch({ physicalAddress: e.target.value })}
              />
            </Field>
          </div>
          <Field
            label="Custom merge fields"
            hint="Comma-separated, lowercase with underscores. These become available in the editor and as segment filters."
          >
            <input
              className={inputClass}
              value={(list.mergeFields ?? []).join(', ')}
              onChange={(e) =>
                patch({
                  mergeFields: e.target.value
                    .split(',')
                    .map((v) => v.trim())
                    .filter(Boolean),
                })
              }
              placeholder="city, plan"
            />
          </Field>
          <Field label="Seed addresses" hint="Comma-separated. Used by the one-click test send.">
            <input
              className={inputClass}
              value={(list.seedEmails ?? []).join(', ')}
              onChange={(e) =>
                patch({
                  seedEmails: e.target.value
                    .split(',')
                    .map((v) => v.trim())
                    .filter(Boolean),
                })
              }
              placeholder="you@example.com, seed@example.com"
            />
          </Field>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            {saving ? <Spinner /> : null} Save
          </Button>
          {saved ? <span className="text-sm text-emerald-700">Saved.</span> : null}
        </div>
      </Card>

      <Card>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-500">Signup</h2>
        <p className="text-sm text-ink-600">
          Hosted signup form:{' '}
          <a href={`/subscribe/${listId}`} className="underline" target="_blank" rel="noreferrer">
            {signupUrl || `/subscribe/${listId}`}
          </a>
        </p>
        <p className="mt-2 text-xs text-ink-500">
          To embed your own form, POST JSON to <code>/api/subscribe</code> with{' '}
          <code>{`{ "listId": "${listId}", "email": "…", "website": "" }`}</code>. Keep the empty{' '}
          <code>website</code> honeypot field in your markup, visually hidden.
        </p>
      </Card>
    </div>
  );
}
