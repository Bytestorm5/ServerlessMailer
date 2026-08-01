'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CampaignEditorScreen,
  type CampaignDraft,
  type CampaignVersionSummary,
} from '@/components/campaign/CampaignEditorScreen';
import type { MergeFieldOption } from '@/components/editor/EditorToolbar';
import type { PreviewSubscriber } from '@/components/campaign/CampaignPreview';
import type { CampaignCounts, CampaignStatus, PresendResult } from '@/lib/types';

export interface FailedBatchSummary {
  id: string;
  recipients: number;
  attempts: number;
  lastError: string;
}

export interface CampaignWorkspaceProps {
  campaignId: string;
  status: CampaignStatus;
  pausedReason: string | null;
  counts: CampaignCounts;
  /** Report extras; all optional so a caller can render progress alone. */
  trackOpens?: boolean;
  trackClicks?: boolean;
  failedBatches?: FailedBatchSummary[];
  topLinks?: { url: string; clicks: number }[];
  initialDraft: CampaignDraft;
  list: { name: string; fromName: string; fromEmail: string; replyTo: string };
  mergeFields: MergeFieldOption[];
  previewSubscribers: PreviewSubscriber[];
  versions: CampaignVersionSummary[];
  typedConfirmationThreshold: number;
}

async function jsonOrThrow(response: Response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      (body as { error?: string }).error ?? `Request failed (${response.status})`,
    );
  }
  return body;
}

/**
 * Wires the composition screen to the admin API, and replaces it with a
 * progress view once the campaign is no longer editable — after freeze the body
 * and recipient set are immutable (spec §7.1), so offering an editor would be a
 * lie.
 */
export function CampaignWorkspace(props: CampaignWorkspaceProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const editable = props.status === 'draft' || props.status === 'scheduled';

  async function action(body: Record<string, unknown>) {
    setBusy(true);
    try {
      await jsonOrThrow(
        await fetch(`/api/admin/campaigns/${props.campaignId}/actions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const failedBatches = props.failedBatches ?? [];
  const topLinks = props.topLinks ?? [];

  if (!editable) {
    const percent =
      props.counts.recipients > 0
        ? Math.round((props.counts.sent / props.counts.recipients) * 100)
        : 0;

    return (
      <section>
        <h1 style={{ fontSize: '1.25rem' }}>{props.initialDraft.subject}</h1>
        <p>
          <span className={`sm-badge is-${props.status}`}>{props.status}</span>
        </p>
        {props.pausedReason && (
          <p role="alert" className="sm-modal-blockers">
            {props.pausedReason}
          </p>
        )}

        <dl className="sm-cards">
          <div className="sm-card">
            <dt>Progress</dt>
            <dd>{percent}%</dd>
            <p className="muted">
              {props.counts.sent.toLocaleString('en-GB')} of{' '}
              {props.counts.recipients.toLocaleString('en-GB')}
            </p>
          </div>
          <div className="sm-card">
            <dt>Delivered</dt>
            <dd>{props.counts.delivered.toLocaleString('en-GB')}</dd>
          </div>
          <div className={`sm-card${props.counts.bounced > 0 ? ' is-warning' : ''}`}>
            <dt>Bounced</dt>
            <dd>{props.counts.bounced.toLocaleString('en-GB')}</dd>
          </div>
          <div className={`sm-card${props.counts.complained > 0 ? ' is-warning' : ''}`}>
            <dt>Complained</dt>
            <dd>{props.counts.complained.toLocaleString('en-GB')}</dd>
          </div>
          <div className="sm-card">
            <dt>Unsubscribed</dt>
            <dd>{props.counts.unsubscribed.toLocaleString('en-GB')}</dd>
          </div>
          <div className={`sm-card${props.counts.failed > 0 ? ' is-warning' : ''}`}>
            <dt>Failed</dt>
            <dd>{props.counts.failed.toLocaleString('en-GB')}</dd>
          </div>
          {props.trackOpens && (
            <div className="sm-card">
              <dt>Opened</dt>
              <dd>{props.counts.opened.toLocaleString('en-GB')}</dd>
              {/* Apple Mail Privacy Protection pre-fetches images, so this is a
                  soft signal rather than a precise figure (spec section 13). */}
              <p className="muted">Inflated by Apple Mail Privacy Protection — treat as approximate</p>
            </div>
          )}
          {props.trackClicks && (
            <div className="sm-card">
              <dt>Clicked</dt>
              <dd>{props.counts.clicked.toLocaleString('en-GB')}</dd>
            </div>
          )}
        </dl>

        {topLinks.length > 0 && (
          <>
            <h2 style={{ fontSize: '1rem' }}>Top clicked links</h2>
            <table className="sm-table">
              <tbody>
                {topLinks.map((link) => (
                  <tr key={link.url}>
                    <td style={{ wordBreak: 'break-all' }}>{link.url}</td>
                    <td>{link.clicks.toLocaleString('en-GB')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {failedBatches.length > 0 && (
          <section aria-label="Failed batches">
            <h2 style={{ fontSize: '1rem' }}>Failed batches</h2>
            <p className="muted">
              These reached the retry limit and were not sent. Inspect the error, fix the
              cause, and re-send to the remaining recipients.
            </p>
            <table className="sm-table">
              <thead>
                <tr>
                  <th>Recipients</th>
                  <th>Attempts</th>
                  <th>Last error</th>
                </tr>
              </thead>
              <tbody>
                {failedBatches.map((batch) => (
                  <tr key={batch.id}>
                    <td>{batch.recipients}</td>
                    <td>{batch.attempts}</td>
                    <td>{batch.lastError}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {/* A single prominent control (§7.7). Pausing stops sending within one
            minute with no in-flight work lost. */}
        {props.status === 'sending' && (
          <button
            type="button"
            className="sm-primary"
            disabled={busy}
            onClick={() => action({ action: 'pause', reason: 'Paused by an operator' })}
          >
            Pause sending
          </button>
        )}
        {props.status === 'paused' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => action({ action: 'resume' })}
          >
            Resume sending
          </button>
        )}
      </section>
    );
  }

  return (
    <CampaignEditorScreen
      initialDraft={props.initialDraft}
      listName={props.list.name}
      fromName={props.list.fromName}
      fromEmail={props.list.fromEmail}
      replyTo={props.list.replyTo}
      mergeFields={props.mergeFields}
      previewSubscribers={props.previewSubscribers}
      versions={props.versions}
      typedConfirmationThreshold={props.typedConfirmationThreshold}
      onSave={async (draft) => {
        await jsonOrThrow(
          await fetch(`/api/admin/campaigns/${props.campaignId}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(draft),
          }),
        );
      }}
      onRenderPreview={async (draft, subscriberId) => {
        const body = await jsonOrThrow(
          await fetch(`/api/admin/campaigns/${props.campaignId}/preview`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...draft, subscriberId }),
          }),
        );
        return { html: (body as { html: string }).html, text: (body as { text: string }).text };
      }}
      onValidate={async () => {
        const body = await jsonOrThrow(
          await fetch(`/api/admin/campaigns/${props.campaignId}/validate`),
        );
        return body as PresendResult;
      }}
      onSend={async () => {
        await action({ action: 'send' });
      }}
      onTestSend={async (addresses) => {
        await jsonOrThrow(
          await fetch(`/api/admin/campaigns/${props.campaignId}/actions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'test', to: addresses }),
          }),
        );
      }}
      onRestoreVersion={async (versionId) => {
        await action({ action: 'restore', versionId });
      }}
    />
  );
}
