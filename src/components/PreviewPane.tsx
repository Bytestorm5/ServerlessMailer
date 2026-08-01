'use client';

import { useState } from 'react';
import { clsx } from '@/lib/clsx';

/**
 * Side-by-side live preview (§6.3).
 *
 * Desktop/mobile width toggle, a plain-text tab, and rendering with a real
 * subscriber's merge data so fallbacks get exercised rather than assumed.
 *
 * The HTML goes into a sandboxed iframe. Campaign bodies contain author-
 * supplied markup and merge values; giving that a `srcdoc` with no `allow-
 * scripts` means it can never touch the admin page around it.
 */

export interface PreviewData {
  subject: string;
  html: string;
  text: string;
  warnings?: string[];
}

export function PreviewPane({
  preview,
  samples,
  sampleId,
  onSampleChange,
  refreshing,
}: {
  preview: PreviewData | null;
  samples: { id: string; email: string }[];
  sampleId: string | null;
  onSampleChange: (id: string | null) => void;
  refreshing: boolean;
}) {
  const [width, setWidth] = useState<'desktop' | 'mobile'>('desktop');
  const [tab, setTab] = useState<'html' | 'text'>('html');

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 pb-2">
        <div className="flex rounded border border-ink-200 p-0.5">
          {(['html', 'text'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={clsx(
                'rounded px-2.5 py-1 text-xs font-medium transition',
                tab === value ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-100',
              )}
            >
              {value === 'html' ? 'HTML' : 'Plain text'}
            </button>
          ))}
        </div>

        {tab === 'html' ? (
          <div className="flex rounded border border-ink-200 p-0.5">
            {(['desktop', 'mobile'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setWidth(value)}
                className={clsx(
                  'rounded px-2.5 py-1 text-xs font-medium capitalize transition',
                  width === value ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-100',
                )}
              >
                {value}
              </button>
            ))}
          </div>
        ) : null}

        <select
          className="rounded border border-ink-200 bg-white px-2 py-1 text-xs"
          value={sampleId ?? ''}
          onChange={(event) => onSampleChange(event.target.value || null)}
        >
          <option value="">Preview with fallbacks</option>
          {samples.map((sample) => (
            <option key={sample.id} value={sample.id}>
              {sample.email}
            </option>
          ))}
        </select>

        {refreshing ? <span className="text-xs text-ink-400">rendering…</span> : null}
      </div>

      {preview?.warnings && preview.warnings.length > 0 ? (
        <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {preview.warnings.slice(0, 3).map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      ) : null}

      <div className="mt-3 flex-1 overflow-auto rounded border border-ink-200 bg-ink-100 p-3">
        {!preview ? (
          <p className="p-6 text-center text-sm text-ink-500">Preview will appear here.</p>
        ) : tab === 'text' ? (
          <pre className="whitespace-pre-wrap rounded bg-white p-4 font-mono text-xs leading-relaxed text-ink-800">
            {preview.text}
          </pre>
        ) : (
          <div className="mx-auto transition-all" style={{ maxWidth: width === 'mobile' ? 375 : 700 }}>
            <div className="mb-2 rounded bg-white px-3 py-2 text-xs text-ink-600 shadow-sm">
              <span className="font-medium text-ink-800">Subject:</span> {preview.subject || '(empty)'}
            </div>
            <iframe
              title="Email preview"
              className="preview-frame h-[70vh] rounded shadow-sm"
              sandbox=""
              srcDoc={preview.html}
            />
          </div>
        )}
      </div>
    </div>
  );
}
