'use client';

import { useState } from 'react';
import { Button, ErrorNote, Spinner, inputClass } from '@/components/ui';
import { api, formatNumber } from '@/lib/client';
import { clsx } from '@/lib/clsx';

/**
 * Pre-send gate results and the send confirmation modal (§6.6, §6.7).
 *
 * The modal restates, in plain language, the recipient count, the list, the
 * from address, the reply-to address and the subject line. Above a configured
 * threshold it also requires the operator to type the list name.
 *
 * This is the last human checkpoint before 19,000 people receive something.
 */

export interface GateCheck {
  id: string;
  label: string;
  passed: boolean;
  detail?: string;
  warning?: boolean;
}

export interface GateResponse {
  passed: boolean;
  checks: GateCheck[];
  recipientCount: number;
  confirmation: {
    recipientCount: number;
    listName: string;
    fromName: string;
    fromEmail: string;
    replyTo: string;
    subject: string;
    segment: string;
    typedConfirmationRequired: boolean;
    typedConfirmationPhrase: string;
  };
}

export function ChecklistPanel({ gate, running }: { gate: GateResponse | null; running: boolean }) {
  if (running && !gate) {
    return (
      <p className="flex items-center gap-2 text-sm text-ink-500">
        <Spinner /> Running pre-send checks…
      </p>
    );
  }
  if (!gate) return <p className="text-sm text-ink-500">Run the pre-send checks to see the status.</p>;

  return (
    <ul className="space-y-1.5">
      {gate.checks.map((check) => (
        <li key={check.id} className="flex gap-2 text-sm">
          <span
            className={clsx(
              'mt-0.5 select-none',
              check.warning ? 'text-amber-600' : check.passed ? 'text-emerald-600' : 'text-red-600',
            )}
          >
            {check.warning ? '!' : check.passed ? '✓' : '✕'}
          </span>
          <span>
            <span className={check.passed ? 'text-ink-700' : 'font-medium text-red-800'}>{check.label}</span>
            {check.detail ? <span className="block text-xs text-ink-500">{check.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function SendDialog({
  campaignId,
  gate,
  onClose,
  onSent,
}: {
  campaignId: string;
  gate: GateResponse;
  onClose: () => void;
  onSent: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [scheduleFor, setScheduleFor] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { confirmation } = gate;
  const typedOk = !confirmation.typedConfirmationRequired || typed.trim() === confirmation.typedConfirmationPhrase;

  const submit = async (schedule: boolean) => {
    setSending(true);
    setError(null);
    try {
      await api('/api/admin/campaigns/' + campaignId + '/send', {
        method: 'POST',
        json: {
          typedConfirmation: typed,
          scheduledFor: schedule && scheduleFor ? new Date(scheduleFor).toISOString() : null,
        },
      });
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4">
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold">Send this campaign?</h2>

        <dl className="mt-4 space-y-2 rounded border border-ink-200 bg-ink-50 p-4 text-sm">
          <Row label="Recipients">
            <span className="text-base font-semibold">{formatNumber(confirmation.recipientCount)} people</span>
          </Row>
          <Row label="List">{confirmation.listName}</Row>
          <Row label="Segment">{confirmation.segment}</Row>
          <Row label="From">
            {confirmation.fromName} &lt;{confirmation.fromEmail}&gt;
          </Row>
          <Row label="Reply-to">{confirmation.replyTo}</Row>
          <Row label="Subject">{confirmation.subject || <em className="text-red-700">empty</em>}</Row>
        </dl>

        {confirmation.typedConfirmationRequired ? (
          <div className="mt-4">
            <label className="block text-sm font-medium text-ink-700">
              Type the list name to confirm: <code className="rounded bg-ink-100 px-1">{confirmation.typedConfirmationPhrase}</code>
            </label>
            <input
              className={clsx(inputClass, 'mt-1')}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder={confirmation.typedConfirmationPhrase}
              autoFocus
            />
          </div>
        ) : null}

        <div className="mt-4">
          <label className="block text-sm font-medium text-ink-700">Or schedule for later (your local time)</label>
          <input
            type="datetime-local"
            className={clsx(inputClass, 'mt-1')}
            value={scheduleFor}
            onChange={(event) => setScheduleFor(event.target.value)}
          />
        </div>

        {error ? <div className="mt-4"><ErrorNote>{error}</ErrorNote></div> : null}

        <p className="mt-4 text-xs text-ink-500">
          Sending is paced over roughly {Math.max(1, Math.ceil(confirmation.recipientCount / 700))} minute(s). You can
          pause at any point and everything already sent stays sent.
        </p>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          {scheduleFor ? (
            <Button variant="primary" disabled={!typedOk || sending} onClick={() => void submit(true)}>
              {sending ? <Spinner /> : null} Schedule
            </Button>
          ) : (
            <Button variant="primary" disabled={!typedOk || sending} onClick={() => void submit(false)}>
              {sending ? <Spinner /> : null} Send now
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-24 shrink-0 text-ink-500">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-ink-900">{children}</dd>
    </div>
  );
}
