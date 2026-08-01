'use client';

import { useEffect, useState } from 'react';
import { Button, Field, inputClass } from '@/components/ui';
import { api, formatNumber } from '@/lib/client';
import type { AttributeFilter, SegmentQuery, SubscriberSource } from '@/lib/types';

/**
 * Segment controls (§4.2).
 *
 * A small set of dropdowns, deliberately not a query builder. The live count
 * updates as filters change — and is re-derived at freeze time, never trusted
 * from here.
 */

const SOURCES: SubscriberSource[] = ['web_form', 'import', 'api'];

export function SegmentBuilder({
  listId,
  value,
  onChange,
  mergeFields,
  disabled,
}: {
  listId: string;
  value: SegmentQuery;
  onChange: (query: SegmentQuery) => void;
  mergeFields: string[];
  disabled?: boolean;
}) {
  const [count, setCount] = useState<number | null>(null);
  const [description, setDescription] = useState('');
  const [counting, setCounting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCounting(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await api<{ count: number; description: string }>('/api/admin/segments/count', {
            method: 'POST',
            json: { listId, query: value },
          });
          if (!cancelled) {
            setCount(result.count);
            setDescription(result.description);
          }
        } catch {
          if (!cancelled) setCount(null);
        } finally {
          if (!cancelled) setCounting(false);
        }
      })();
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [listId, value]);

  const patch = (partial: Partial<SegmentQuery>) => onChange({ ...value, ...partial });

  const attributes = value.attributes ?? [];
  const setAttribute = (index: number, next: AttributeFilter | null) => {
    const copy = [...attributes];
    if (next === null) copy.splice(index, 1);
    else copy[index] = next;
    patch({ attributes: copy.length > 0 ? copy : null });
  };

  return (
    <div className="space-y-4">
      <div className="rounded border border-ink-200 bg-white px-4 py-3">
        <p className="text-sm text-ink-600">
          {counting ? (
            'Counting…'
          ) : count === null ? (
            'Count unavailable'
          ) : (
            <>
              This will send to <span className="font-semibold text-ink-900">{formatNumber(count)}</span>{' '}
              {count === 1 ? 'person' : 'people'}.
            </>
          )}
        </p>
        {description ? <p className="mt-1 text-xs text-ink-500">{description}</p> : null}
        <p className="mt-1 text-xs text-ink-400">
          Recounted at send time. Suppressed and unsubscribed addresses are excluded there too.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Signed up on or after">
          <input
            type="date"
            className={inputClass}
            disabled={disabled}
            value={value.signupAfter?.slice(0, 10) ?? ''}
            onChange={(event) => patch({ signupAfter: event.target.value || null })}
          />
        </Field>
        <Field label="Signed up on or before">
          <input
            type="date"
            className={inputClass}
            disabled={disabled}
            value={value.signupBefore?.slice(0, 10) ?? ''}
            onChange={(event) => patch({ signupBefore: event.target.value || null })}
          />
        </Field>
      </div>

      <Field label="Signup source">
        <div className="flex flex-wrap gap-3">
          {SOURCES.map((source) => {
            const selected = value.sources?.includes(source) ?? false;
            return (
              <label key={source} className="flex items-center gap-1.5 text-sm text-ink-700">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={selected}
                  onChange={(event) => {
                    const current = new Set(value.sources ?? []);
                    if (event.target.checked) current.add(source);
                    else current.delete(source);
                    patch({ sources: current.size > 0 ? [...current] : null });
                  }}
                />
                {source}
              </label>
            );
          })}
        </div>
      </Field>

      <Field
        label="Engagement"
        hint="Opened at least one of the most recent campaigns. Use this to ramp a new sending domain, most-engaged first (§10.4)."
      >
        <select
          className={inputClass}
          disabled={disabled}
          value={value.openedInLastNCampaigns ?? ''}
          onChange={(event) =>
            patch({ openedInLastNCampaigns: event.target.value ? Number(event.target.value) : null })
          }
        >
          <option value="">Everyone</option>
          {[1, 3, 5, 10].map((n) => (
            <option key={n} value={n}>
              Opened one of the last {n} campaigns
            </option>
          ))}
        </select>
      </Field>

      <div>
        <p className="mb-1 text-sm font-medium text-ink-700">Attributes</p>
        <div className="space-y-2">
          {attributes.map((attribute, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <select
                className="rounded border border-ink-200 bg-white px-2 py-1.5 text-sm"
                disabled={disabled}
                value={attribute.key}
                onChange={(event) => setAttribute(index, { ...attribute, key: event.target.value })}
              >
                {[attribute.key, ...mergeFields.filter((f) => f !== attribute.key)].map((field) => (
                  <option key={field} value={field}>
                    {field}
                  </option>
                ))}
              </select>
              <select
                className="rounded border border-ink-200 bg-white px-2 py-1.5 text-sm"
                disabled={disabled}
                value={attribute.op}
                onChange={(event) =>
                  setAttribute(index, { ...attribute, op: event.target.value as AttributeFilter['op'] })
                }
              >
                <option value="eq">is</option>
                <option value="ne">is not</option>
                <option value="exists">is set</option>
                <option value="not_exists">is not set</option>
              </select>
              {attribute.op === 'eq' || attribute.op === 'ne' ? (
                <input
                  className="rounded border border-ink-200 px-2 py-1.5 text-sm"
                  disabled={disabled}
                  value={attribute.value ?? ''}
                  onChange={(event) => setAttribute(index, { ...attribute, value: event.target.value })}
                  placeholder="value"
                />
              ) : null}
              <Button variant="ghost" disabled={disabled} onClick={() => setAttribute(index, null)}>
                Remove
              </Button>
            </div>
          ))}
        </div>
        {mergeFields.length > 0 ? (
          <Button
            className="mt-2"
            disabled={disabled}
            onClick={() =>
              patch({ attributes: [...attributes, { key: mergeFields[0] as string, op: 'exists' }] })
            }
          >
            Add attribute filter
          </Button>
        ) : (
          <p className="mt-1 text-xs text-ink-500">
            Define custom fields on the list to filter by attribute.
          </p>
        )}
      </div>
    </div>
  );
}
