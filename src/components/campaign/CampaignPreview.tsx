'use client';

import { useId, useState } from 'react';

export interface PreviewSubscriber {
  id: string;
  email: string;
  label: string;
}

export interface CampaignPreviewProps {
  html: string;
  text: string;
  subscribers: PreviewSubscriber[];
  selectedSubscriberId?: string;
  onSelectSubscriber: (id: string) => void;
  loading?: boolean;
  error?: string;
}

type Tab = 'html' | 'text';
type Width = 'desktop' | 'mobile';

const WIDTHS: Record<Width, string> = {
  desktop: '100%',
  mobile: '375px',
};

/**
 * Side-by-side preview (spec §6.3).
 *
 * Renders with a real subscriber's merge data so fallbacks actually get
 * exercised — a preview that shows `{{first_name}}` has told you nothing about
 * what 19,000 people will see.
 *
 * The HTML goes into a fully sandboxed iframe. The body is operator-authored,
 * but it can embed arbitrary markup, and the admin origin holds the session
 * cookie; there is no reason to let preview content run there.
 */
export function CampaignPreview({
  html,
  text,
  subscribers,
  selectedSubscriberId,
  onSelectSubscriber,
  loading,
  error,
}: CampaignPreviewProps) {
  const [tab, setTab] = useState<Tab>('html');
  const [width, setWidth] = useState<Width>('desktop');
  const selectId = useId();

  return (
    <section className="sm-preview" aria-label="Preview">
      <header className="sm-preview-bar">
        <div role="tablist" aria-label="Preview format">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'html'}
            onClick={() => setTab('html')}
          >
            HTML
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'text'}
            onClick={() => setTab('text')}
          >
            Plain text
          </button>
        </div>

        <div role="radiogroup" aria-label="Preview width">
          {(['desktop', 'mobile'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={width === option}
              aria-label={option}
              onClick={() => setWidth(option)}
            >
              {option === 'desktop' ? 'Desktop' : 'Mobile'}
            </button>
          ))}
        </div>

        <div className="sm-preview-as">
          {subscribers.length === 0 ? (
            <p className="muted">
              No confirmed subscribers yet, so merge fields show their fallbacks.
            </p>
          ) : (
            <>
              <label htmlFor={selectId}>Preview as</label>
              <select
                id={selectId}
                value={selectedSubscriberId ?? ''}
                onChange={(event) => onSelectSubscriber(event.target.value)}
              >
                {subscribers.map((subscriber) => (
                  <option key={subscriber.id} value={subscriber.id}>
                    {subscriber.label}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>

        {loading && (
          <p role="status" className="muted">
            Updating preview…
          </p>
        )}
      </header>

      {error ? (
        // Showing the last good render instead would let someone send a
        // campaign whose current body does not render at all.
        <p role="alert" className="sm-preview-error">
          This campaign does not currently render: {error}
        </p>
      ) : (
        <div className="sm-preview-stage" role="tabpanel">
          {tab === 'html' ? (
            <iframe
              title="Email preview"
              sandbox=""
              srcDoc={html}
              style={{ width: WIDTHS[width] }}
              className="sm-preview-frame"
            />
          ) : (
            <pre className="sm-preview-text" style={{ width: WIDTHS[width] }}>
              {text}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}
