'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorSurface, EditorToolbar, useNewsletterEditor } from '@/components/Editor';
import { PreviewPane, type PreviewData } from '@/components/PreviewPane';
import { SegmentBuilder } from '@/components/SegmentBuilder';
import { ChecklistPanel, SendDialog, type GateResponse } from '@/components/SendDialog';
import { Button, Card, ErrorNote, Spinner, StatusBadge, inputClass } from '@/components/ui';
import { api, formatDate } from '@/lib/client';
import { clsx } from '@/lib/clsx';
import type { CampaignDoc, ListDoc, SegmentQuery, TiptapDoc } from '@/lib/types';

/**
 * The daily-use surface (§6).
 *
 * Autosave on a debounce with a visible saved-state indicator, side-by-side
 * live preview, and every send control behind the pre-send gate.
 */

const AUTOSAVE_DEBOUNCE_MS = 1200;
const PREVIEW_DEBOUNCE_MS = 700;

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

interface CampaignResponse {
  campaign: CampaignDoc;
  list: ListDoc;
}

export function CampaignEditor({ campaignId }: { campaignId: string }) {
  const [campaign, setCampaign] = useState<CampaignDoc | null>(null);
  const [list, setList] = useState<ListDoc | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [subject, setSubject] = useState('');
  const [preheader, setPreheader] = useState('');
  const [name, setName] = useState('');
  const [segmentQuery, setSegmentQuery] = useState<SegmentQuery>({});
  const [trackOpens, setTrackOpens] = useState(false);
  const [trackClicks, setTrackClicks] = useState(false);

  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [samples, setSamples] = useState<{ id: string; email: string }[]>([]);
  const [sampleId, setSampleId] = useState<string | null>(null);

  const [gate, setGate] = useState<GateResponse | null>(null);
  const [gateRunning, setGateRunning] = useState(false);
  const [showSendDialog, setShowSendDialog] = useState(false);

  const [tab, setTab] = useState<'write' | 'audience' | 'settings' | 'history'>('write');

  const bodyRef = useRef<TiptapDoc | null>(null);
  const loadedRef = useRef(false);

  const editable = campaign?.status === 'draft' || campaign?.status === 'scheduled';

  // --- Load ----------------------------------------------------------------
  useEffect(() => {
    void (async () => {
      try {
        const data = await api<CampaignResponse>(`/api/admin/campaigns/${campaignId}`);
        setCampaign(data.campaign);
        setList(data.list);
        setSubject(data.campaign.subject);
        setPreheader(data.campaign.preheader);
        setName(data.campaign.name);
        setSegmentQuery(data.campaign.segmentQuery ?? {});
        setTrackOpens(data.campaign.trackOpens);
        setTrackClicks(data.campaign.trackClicks);
        bodyRef.current = data.campaign.bodySource;
        loadedRef.current = true;

        const previewSamples = await api<{ samples: { id: string; email: string }[] }>(
          `/api/admin/campaigns/${campaignId}/preview`,
        );
        setSamples(previewSamples.samples);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [campaignId]);

  // --- Autosave ------------------------------------------------------------
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleSave = useCallback(() => {
    if (!loadedRef.current || !editable) return;
    setSaveState('dirty');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void (async () => {
        setSaveState('saving');
        try {
          const result = await api<{ savedAt: string }>(`/api/admin/campaigns/${campaignId}`, {
            method: 'PATCH',
            json: {
              name,
              subject,
              preheader,
              bodySource: bodyRef.current,
              segmentQuery,
              trackOpens,
              trackClicks,
            },
          });
          setSavedAt(result.savedAt);
          setSaveState('saved');
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          setSaveState('error');
        }
      })();
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [campaignId, editable, name, preheader, segmentQuery, subject, trackClicks, trackOpens]);

  useEffect(() => {
    scheduleSave();
    // Intentionally re-runs whenever any saved field changes.
  }, [scheduleSave]);

  // Nothing is lost when the tab closes mid-debounce.
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (saveState === 'dirty' || saveState === 'saving') {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [saveState]);

  const onBodyChange = useCallback(
    (doc: TiptapDoc) => {
      bodyRef.current = doc;
      scheduleSave();
      schedulePreview();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scheduleSave],
  );

  const editor = useNewsletterEditor({
    initialContent: campaign?.bodySource ?? { type: 'doc', content: [{ type: 'paragraph' }] },
    onChange: onBodyChange,
    placeholder: 'Write something worth reading…',
  });

  // Content arrives after the editor is constructed, so it is applied once the
  // campaign loads rather than by rebuilding the editor.
  useEffect(() => {
    if (editor && campaign && !editor.isDestroyed) {
      const current = JSON.stringify(editor.getJSON());
      const incoming = JSON.stringify(campaign.bodySource);
      if (current !== incoming) editor.commands.setContent(campaign.bodySource, false);
      editor.setEditable(Boolean(editable));
    }
  }, [editor, campaign, editable]);

  // --- Preview -------------------------------------------------------------
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runPreview = useCallback(async () => {
    setPreviewing(true);
    try {
      // Preview reads the saved document, so flush any pending edit first.
      if (loadedRef.current && editable) {
        await api(`/api/admin/campaigns/${campaignId}`, {
          method: 'PATCH',
          json: { name, subject, preheader, bodySource: bodyRef.current, segmentQuery, trackOpens, trackClicks },
        });
      }
      const data = await api<PreviewData>(`/api/admin/campaigns/${campaignId}/preview`, {
        method: 'POST',
        json: { sampleSubscriberId: sampleId },
      });
      setPreview(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewing(false);
    }
  }, [campaignId, editable, name, preheader, sampleId, segmentQuery, subject, trackClicks, trackOpens]);

  const schedulePreview = useCallback(() => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => void runPreview(), PREVIEW_DEBOUNCE_MS);
  }, [runPreview]);

  useEffect(() => {
    if (campaign) schedulePreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign?._id, sampleId, subject, preheader, trackOpens, trackClicks]);

  // --- Gate ----------------------------------------------------------------
  const runGate = useCallback(
    async (quick: boolean) => {
      setGateRunning(true);
      try {
        const result = await api<GateResponse>(
          `/api/admin/campaigns/${campaignId}/validate${quick ? '?quick=1' : ''}`,
          { method: 'POST' },
        );
        setGate(result);
        return result;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setGateRunning(false);
      }
    },
    [campaignId],
  );

  const reload = useCallback(async () => {
    const data = await api<CampaignResponse>(`/api/admin/campaigns/${campaignId}`);
    setCampaign(data.campaign);
    setList(data.list);
  }, [campaignId]);

  const control = async (action: string) => {
    try {
      await api(`/api/admin/campaigns/${campaignId}/control`, { method: 'POST', json: { action } });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const mergeFields = useMemo(
    () => (list ? ['first_name', 'last_name', 'email', ...(list.mergeFields ?? [])] : []),
    [list],
  );

  if (error && !campaign) return <ErrorNote>{error}</ErrorNote>;
  if (!campaign || !list) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-500">
        <Spinner /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header ------------------------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <input
              className="min-w-0 flex-1 border-0 bg-transparent p-0 text-lg font-semibold outline-none focus:ring-0"
              value={name}
              disabled={!editable}
              onChange={(event) => setName(event.target.value)}
              placeholder="Campaign name (internal)"
            />
            <StatusBadge status={campaign.status} />
          </div>
          <p className="text-xs text-ink-500">
            {list.name} · <SaveIndicator state={saveState} savedAt={savedAt} />
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {campaign.status === 'sending' ? (
            <Button variant="danger" onClick={() => void control('pause')}>
              Pause sending
            </Button>
          ) : null}
          {campaign.status === 'paused' ? (
            <>
              <Button variant="primary" onClick={() => void control('resume')}>
                Resume
              </Button>
              <Button variant="danger" onClick={() => void control('cancel')}>
                Abort
              </Button>
            </>
          ) : null}
          {campaign.status === 'scheduled' ? (
            <Button onClick={() => void control('unschedule')}>Unschedule</Button>
          ) : null}
          {campaign.status !== 'draft' ? (
            <Link
              href={`/admin/campaigns/${campaignId}/report`}
              className="rounded border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50"
            >
              Report
            </Link>
          ) : null}
          {editable ? (
            <Button
              variant="primary"
              onClick={async () => {
                const result = await runGate(false);
                if (result) setShowSendDialog(true);
              }}
              disabled={gateRunning}
            >
              {gateRunning ? <Spinner /> : null} Review &amp; send
            </Button>
          ) : null}
        </div>
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {campaign.status === 'paused' && campaign.pauseReason ? (
        <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>Paused.</strong> {campaign.pauseReason}
        </div>
      ) : null}

      {/* Tabs -------------------------------------------------------------- */}
      <div className="flex gap-1 border-b border-ink-200">
        {(['write', 'audience', 'settings', 'history'] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={clsx(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium capitalize transition',
              tab === value
                ? 'border-ink-900 text-ink-900'
                : 'border-transparent text-ink-500 hover:text-ink-800',
            )}
          >
            {value}
          </button>
        ))}
      </div>

      {tab === 'write' ? (
        <div className="grid gap-5 xl:grid-cols-2">
          <div className="space-y-3">
            <input
              className={clsx(inputClass, 'text-base font-medium')}
              value={subject}
              disabled={!editable}
              onChange={(event) => setSubject(event.target.value)}
              placeholder="Subject line"
            />
            <input
              className={inputClass}
              value={preheader}
              disabled={!editable}
              onChange={(event) => setPreheader(event.target.value)}
              placeholder="Preheader — the line shown after the subject in most inboxes"
            />
            <EditorToolbar editor={editor} mergeFields={mergeFields} />
            <EditorSurface editor={editor} />
            <p className="text-xs text-ink-500">
              Merge fields need a fallback: <code>{'{{ first_name | default: "there" }}'}</code>. The unsubscribe
              link and postal address are added to every email automatically.
            </p>
          </div>

          <div className="xl:sticky xl:top-4 xl:h-[calc(100vh-8rem)]">
            <PreviewPane
              preview={preview}
              samples={samples}
              sampleId={sampleId}
              onSampleChange={setSampleId}
              refreshing={previewing}
            />
          </div>
        </div>
      ) : null}

      {tab === 'audience' ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">Audience</h2>
            <SegmentBuilder
              listId={String(campaign.listId)}
              value={segmentQuery}
              onChange={setSegmentQuery}
              mergeFields={list.mergeFields ?? []}
              disabled={!editable}
            />
          </Card>
          <Card>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">Pre-send checks</h2>
            <div className="mb-3">
              <Button onClick={() => void runGate(true)} disabled={gateRunning}>
                {gateRunning ? <Spinner /> : null} Run checks
              </Button>
            </div>
            <ChecklistPanel gate={gate} running={gateRunning} />
            <p className="mt-3 text-xs text-ink-500">
              Every check must pass before a campaign can start sending. There is no override.
            </p>
          </Card>
        </div>
      ) : null}

      {tab === 'settings' ? (
        <SettingsTab
          campaignId={campaignId}
          list={list}
          samples={samples}
          sampleId={sampleId}
          trackOpens={trackOpens}
          trackClicks={trackClicks}
          editable={Boolean(editable)}
          onTrackOpens={setTrackOpens}
          onTrackClicks={setTrackClicks}
        />
      ) : null}

      {tab === 'history' ? <HistoryTab campaignId={campaignId} editable={Boolean(editable)} onRestored={reload} /> : null}

      {showSendDialog && gate ? (
        <SendDialog
          campaignId={campaignId}
          gate={gate}
          onClose={() => setShowSendDialog(false)}
          onSent={async () => {
            setShowSendDialog(false);
            await reload();
          }}
        />
      ) : null}
    </div>
  );
}

function SaveIndicator({ state, savedAt }: { state: SaveState; savedAt: string | null }) {
  const label: Record<SaveState, string> = {
    idle: savedAt ? `Saved ${formatDate(savedAt)}` : 'Not saved yet',
    dirty: 'Unsaved changes…',
    saving: 'Saving…',
    saved: savedAt ? `Saved ${formatDate(savedAt)}` : 'Saved',
    error: 'Save failed — check your connection',
  };
  return (
    <span className={state === 'error' ? 'text-red-700' : state === 'dirty' ? 'text-amber-700' : 'text-ink-500'}>
      {label[state]}
    </span>
  );
}

function SettingsTab({
  campaignId,
  list,
  samples,
  sampleId,
  trackOpens,
  trackClicks,
  editable,
  onTrackOpens,
  onTrackClicks,
}: {
  campaignId: string;
  list: ListDoc;
  samples: { id: string; email: string }[];
  sampleId: string | null;
  trackOpens: boolean;
  trackClicks: boolean;
  editable: boolean;
  onTrackOpens: (value: boolean) => void;
  onTrackClicks: (value: boolean) => void;
}) {
  const [recipients, setRecipients] = useState('');
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const sendTest = async (useSeedList: boolean) => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api<{ sent: number; failed: number; errors: string[] }>(
        `/api/admin/campaigns/${campaignId}/test`,
        {
          method: 'POST',
          json: {
            useSeedList,
            recipients: useSeedList
              ? []
              : recipients
                  .split(/[,\n]/)
                  .map((value) => value.trim())
                  .filter(Boolean),
            sampleSubscriberId: sampleId,
          },
        },
      );
      setTestResult(
        `Sent ${result.sent}, failed ${result.failed}${result.errors.length ? `: ${result.errors.join(', ')}` : ''}`,
      );
    } catch (e) {
      setTestResult(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">Test send</h2>
        <p className="mb-3 text-sm text-ink-600">
          A test uses the real render path — same code, same merge, same headers — and is excluded from every
          campaign count.
        </p>
        <textarea
          className={clsx(inputClass, 'h-24 font-mono text-xs')}
          value={recipients}
          onChange={(event) => setRecipients(event.target.value)}
          placeholder="one@example.com, two@example.com"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={() => void sendTest(false)} disabled={testing || recipients.trim() === ''}>
            {testing ? <Spinner /> : null} Send test
          </Button>
          <Button onClick={() => void sendTest(true)} disabled={testing || (list.seedEmails ?? []).length === 0}>
            Send to seed list ({(list.seedEmails ?? []).length})
          </Button>
        </div>
        {testResult ? <p className="mt-3 text-sm text-ink-700">{testResult}</p> : null}
        {samples.length > 0 ? (
          <p className="mt-2 text-xs text-ink-500">
            Merge data comes from the subscriber selected in the preview pane, so fallbacks get exercised.
          </p>
        ) : null}
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">Tracking</h2>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={trackOpens}
            disabled={!editable}
            onChange={(event) => onTrackOpens(event.target.checked)}
          />
          <span>
            <span className="font-medium">Track opens</span>
            <span className="block text-xs text-ink-500">
              Apple Mail Privacy Protection pre-fetches images and inflates open rates substantially. Treat the
              number as a trend, never as a precise figure.
            </span>
          </span>
        </label>
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={trackClicks}
            disabled={!editable}
            onChange={(event) => onTrackClicks(event.target.checked)}
          />
          <span>
            <span className="font-medium">Track clicks</span>
            <span className="block text-xs text-ink-500">
              Links are rewritten through a signed redirect. Only URLs signed at send time can be emitted.
            </span>
          </span>
        </label>
        <p className="mt-4 text-xs text-ink-500">Some sends should go untracked. Both toggles default to off.</p>
      </Card>
    </div>
  );
}

interface VersionDoc {
  _id: string;
  subject: string;
  preheader: string;
  createdAt: string;
}

function HistoryTab({
  campaignId,
  editable,
  onRestored,
}: {
  campaignId: string;
  editable: boolean;
  onRestored: () => Promise<void>;
}) {
  const [versions, setVersions] = useState<VersionDoc[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const data = await api<{ versions: VersionDoc[] }>(`/api/admin/campaigns/${campaignId}/versions`);
    setVersions(data.versions);
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async (versionId: string) => {
    setBusy(true);
    try {
      await api(`/api/admin/campaigns/${campaignId}/versions`, { method: 'POST', json: { versionId } });
      await onRestored();
      await load();
      window.location.reload();
    } finally {
      setBusy(false);
    }
  };

  if (!versions) {
    return (
      <p className="flex items-center gap-2 text-sm text-ink-500">
        <Spinner /> Loading history…
      </p>
    );
  }

  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-ink-500">Version history</h2>
      <p className="mb-4 text-xs text-ink-500">The last 20 saves. Restoring is itself a save, so it can be undone.</p>
      {versions.length === 0 ? (
        <p className="text-sm text-ink-500">No earlier versions yet.</p>
      ) : (
        <ul className="divide-y divide-ink-100">
          {versions.map((version) => (
            <li key={version._id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{version.subject || '(no subject)'}</p>
                <p className="text-xs text-ink-500">{formatDate(version.createdAt)}</p>
              </div>
              <Button disabled={!editable || busy} onClick={() => void restore(version._id)}>
                Restore
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
