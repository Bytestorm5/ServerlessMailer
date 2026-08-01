'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { NewsletterEditor } from '@/components/editor/NewsletterEditor';
import type { MergeFieldOption } from '@/components/editor/EditorToolbar';
import { CampaignPreview, type PreviewSubscriber } from '@/components/campaign/CampaignPreview';
import { SendConfirmationModal } from '@/components/campaign/SendConfirmationModal';
import { SegmentPicker } from '@/components/campaign/SegmentPicker';
import { useAutosave } from '@/hooks/useAutosave';
import type { EditorDoc, PresendResult, SegmentQuery } from '@/lib/types';

export interface CampaignDraft {
  subject: string;
  preheader: string;
  bodySource: EditorDoc;
  segmentQuery?: SegmentQuery;
}

export interface CampaignVersionSummary {
  id: string;
  createdAt: string;
  subject: string;
}

export interface CampaignEditorScreenProps {
  initialDraft: CampaignDraft;
  listName: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  mergeFields: MergeFieldOption[];
  previewSubscribers: PreviewSubscriber[];
  versions: CampaignVersionSummary[];
  typedConfirmationThreshold: number;
  onSave: (draft: CampaignDraft) => Promise<void>;
  onRenderPreview: (
    draft: CampaignDraft,
    subscriberId?: string,
  ) => Promise<{ html: string; text: string }>;
  onValidate: () => Promise<PresendResult>;
  onSend: () => Promise<void>;
  onTestSend: (addresses: string[]) => Promise<void>;
  onRestoreVersion: (versionId: string) => Promise<void>;
  /** When supplied, the segment dropdowns and their live count are shown (§4.2). */
  onCountSegment?: (query: SegmentQuery) => Promise<number>;
}

const SAVE_LABELS: Record<string, string> = {
  idle: 'All changes saved',
  pending: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Not saved',
};

/**
 * The campaign composition screen (spec §6).
 *
 * Writing surface on the left, live preview on the right, autosave running
 * underneath, and a send button that cannot be reached without passing the
 * pre-send gate.
 */
export function CampaignEditorScreen(props: CampaignEditorScreenProps) {
  const [draft, setDraft] = useState<CampaignDraft>(props.initialDraft);
  const [previewSubscriberId, setPreviewSubscriberId] = useState<string | undefined>(
    props.previewSubscribers[0]?.id,
  );
  const [preview, setPreview] = useState({ html: '', text: '' });
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | undefined>();
  const [gate, setGate] = useState<PresendResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [testAddress, setTestAddress] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [segmentCount, setSegmentCount] = useState<number | null>(null);
  const [segmentError, setSegmentError] = useState<string | undefined>();

  const { status, savedAt, error: saveError, saveNow } = useAutosave({
    value: draft,
    onSave: props.onSave,
    delayMs: 1200,
  });

  // Re-render the preview whenever the draft or the chosen subscriber changes.
  useEffect(() => {
    let cancelled = false;
    setPreviewLoading(true);
    props
      .onRenderPreview(draft, previewSubscriberId)
      .then((next) => {
        if (cancelled) return;
        setPreview(next);
        setPreviewError(undefined);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPreviewError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, previewSubscriberId]);

  // Re-count whenever the segment changes. Advisory only — the number that
  // actually governs the send is re-derived at freeze time.
  const countSegment = props.onCountSegment;
  useEffect(() => {
    if (!countSegment) return;
    let cancelled = false;
    setSegmentCount(null);
    countSegment(draft.segmentQuery ?? {})
      .then((next) => {
        if (cancelled) return;
        setSegmentCount(next);
        setSegmentError(undefined);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSegmentError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [countSegment, draft.segmentQuery]);

  const update = useCallback((patch: Partial<CampaignDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  }, []);

  const openSendDialog = useCallback(async () => {
    // Save first: sending a campaign whose latest edit never reached the server
    // is exactly the mistake this screen exists to prevent.
    await saveNow();
    const result = await props.onValidate();
    setGate(result);
    setConfirming(true);
  }, [props, saveNow]);

  const saveLabel = useMemo(() => {
    if (status === 'saved' && savedAt) {
      return `Saved at ${savedAt.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
      })}`;
    }
    return SAVE_LABELS[status] ?? '';
  }, [status, savedAt]);

  return (
    <div className="sm-screen">
      <header className="sm-screen-head">
        <input
          aria-label="Subject line"
          className="sm-subject"
          placeholder="Subject line"
          value={draft.subject}
          onChange={(event) => update({ subject: event.target.value })}
        />
        <input
          aria-label="Preheader"
          className="sm-preheader"
          placeholder="Preheader — the line shown after the subject in the inbox"
          value={draft.preheader}
          onChange={(event) => update({ preheader: event.target.value })}
        />

        <div className="sm-screen-status">
          <span
            role="status"
            aria-live="polite"
            className={status === 'error' ? 'sm-save-error' : 'muted'}
          >
            {saveLabel}
            {status === 'error' && saveError ? `: ${saveError}` : ''}
          </span>
          <button type="button" onClick={openSendDialog}>
            Review and send
          </button>
        </div>
      </header>

      {props.onCountSegment && (
        <SegmentPicker
          value={draft.segmentQuery ?? {}}
          onChange={(segmentQuery) => update({ segmentQuery })}
          count={segmentCount}
          error={segmentError}
        />
      )}

      <div className="sm-screen-body">
        <div className="sm-screen-write">
          <NewsletterEditor
            initialDoc={props.initialDraft.bodySource}
            mergeFields={props.mergeFields}
            onChange={(bodySource) => update({ bodySource })}
          />

          <section className="sm-test-send" aria-label="Test send">
            <label htmlFor="sm-test-address">Send a test to</label>
            <input
              id="sm-test-address"
              type="email"
              value={testAddress}
              placeholder="you@example.com"
              onChange={(event) => setTestAddress(event.target.value)}
            />
            <button
              type="button"
              disabled={!testAddress}
              onClick={async () => {
                await saveNow();
                await props.onTestSend([testAddress]);
                setNotice(`Test sent to ${testAddress}`);
              }}
            >
              Send test
            </button>
            {notice && (
              <p role="status" className="muted">
                {notice}
              </p>
            )}
          </section>

          {props.versions.length > 0 && (
            <details className="sm-versions">
              <summary>Version history ({props.versions.length})</summary>
              <ul>
                {props.versions.map((version) => (
                  <li key={version.id}>
                    <span>{new Date(version.createdAt).toLocaleString('en-GB')}</span>
                    <button
                      type="button"
                      onClick={() => props.onRestoreVersion(version.id)}
                    >
                      Restore
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>

        <CampaignPreview
          html={preview.html}
          text={preview.text}
          subscribers={props.previewSubscribers}
          selectedSubscriberId={previewSubscriberId}
          onSelectSubscriber={setPreviewSubscriberId}
          loading={previewLoading}
          error={previewError}
        />
      </div>

      <SendConfirmationModal
        open={confirming}
        recipientCount={gate?.recipientCount ?? 0}
        listName={props.listName}
        fromName={props.fromName}
        fromEmail={props.fromEmail}
        replyTo={props.replyTo}
        subject={draft.subject}
        typedConfirmationThreshold={props.typedConfirmationThreshold}
        checks={gate?.checks ?? []}
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          setConfirming(false);
          await props.onSend();
        }}
      />
    </div>
  );
}
