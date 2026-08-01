'use client';

import { useId } from 'react';
import type { SegmentQuery, SubscriberSource } from '@/lib/types';

export interface SegmentPickerProps {
  value: SegmentQuery;
  onChange: (next: SegmentQuery) => void;
  /** Live recipient count, or null while it is being derived. */
  count: number | null;
  counting?: boolean;
  error?: string;
}

const SOURCES: { value: SubscriberSource | ''; label: string }[] = [
  { value: '', label: 'Any source' },
  { value: 'web_form', label: 'Signed up on the website' },
  { value: 'import', label: 'Imported' },
  { value: 'api', label: 'Added via the API' },
];

const ENGAGEMENT = [
  { value: '', label: 'Everyone' },
  { value: '3', label: 'Opened one of the last 3 campaigns' },
  { value: '5', label: 'Opened one of the last 5 campaigns' },
  { value: '10', label: 'Opened one of the last 10 campaigns' },
];

/**
 * Segment selection (spec §4.2).
 *
 * Deliberately a small set of dropdowns rather than a query builder. The live
 * count is advisory only — it is always re-derived at freeze time and never
 * trusted from here, which is why the label says "about".
 *
 * The engagement filter exists specifically so a migration can warm up by
 * mailing the most-engaged segment first (§10.4).
 */
export function SegmentPicker({ value, onChange, count, counting, error }: SegmentPickerProps) {
  const sourceId = useId();
  const afterId = useId();
  const beforeId = useId();
  const engagementId = useId();

  const patch = (next: Partial<SegmentQuery>) => onChange({ ...value, ...next });

  return (
    <section className="sm-segment" aria-label="Recipients">
      <div className="sm-segment-controls">
        <p>
          <label htmlFor={sourceId}>Source</label>
          <select
            id={sourceId}
            value={value.source ?? ''}
            onChange={(event) =>
              patch({ source: (event.target.value || undefined) as SubscriberSource | undefined })
            }
          >
            {SOURCES.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </p>

        <p>
          <label htmlFor={afterId}>Signed up after</label>
          <input
            id={afterId}
            type="date"
            value={(value.signedUpAfter ?? '').slice(0, 10)}
            onChange={(event) =>
              patch({
                signedUpAfter: event.target.value
                  ? new Date(`${event.target.value}T00:00:00.000Z`).toISOString()
                  : undefined,
              })
            }
          />
        </p>

        <p>
          <label htmlFor={beforeId}>Signed up before</label>
          <input
            id={beforeId}
            type="date"
            value={(value.signedUpBefore ?? '').slice(0, 10)}
            onChange={(event) =>
              patch({
                signedUpBefore: event.target.value
                  ? new Date(`${event.target.value}T00:00:00.000Z`).toISOString()
                  : undefined,
              })
            }
          />
        </p>

        <p>
          <label htmlFor={engagementId}>Engagement</label>
          <select
            id={engagementId}
            value={value.openedInLastNCampaigns ? String(value.openedInLastNCampaigns) : ''}
            onChange={(event) =>
              patch({
                openedInLastNCampaigns: event.target.value
                  ? Number(event.target.value)
                  : undefined,
              })
            }
          >
            {ENGAGEMENT.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </p>
      </div>

      {error ? (
        <p role="alert" className="sm-segment-count">
          {error}
        </p>
      ) : (
        <p role="status" aria-live="polite" className="sm-segment-count">
          {counting || count === null
            ? 'Counting recipients…'
            : `This will send to about ${count.toLocaleString('en-GB')} ${
                count === 1 ? 'person' : 'people'
              }`}
        </p>
      )}
      <p className="muted">
        Only confirmed subscribers are ever included. The exact count is recalculated when
        you send.
      </p>
    </section>
  );
}
