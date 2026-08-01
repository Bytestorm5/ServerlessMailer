'use client';

import { useEffect, useId, useState } from 'react';
import type { PresendCheck } from '@/lib/types';

export interface SendConfirmationModalProps {
  open: boolean;
  recipientCount: number;
  listName: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  subject: string;
  typedConfirmationThreshold: number;
  checks: PresendCheck[];
  onConfirm: () => void;
  onCancel: () => void;
}

const formatCount = (count: number) => count.toLocaleString('en-GB');

/**
 * The last human checkpoint before 19,000 people receive something (spec §6.7).
 *
 * It restates the facts in plain language rather than asking "Are you sure?",
 * because the failure this prevents is not hesitancy — it is sending the right
 * email to the wrong list, or the wrong draft to the right one.
 *
 * The pre-send gate (§6.6) is a hard block with **no override**: there is
 * deliberately no "send anyway" affordance anywhere in this component.
 */
export function SendConfirmationModal({
  open,
  recipientCount,
  listName,
  fromName,
  fromEmail,
  replyTo,
  subject,
  typedConfirmationThreshold,
  checks,
  onConfirm,
  onCancel,
}: SendConfirmationModalProps) {
  const [typed, setTyped] = useState('');
  const titleId = useId();
  const inputId = useId();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  useEffect(() => {
    if (!open) setTyped('');
  }, [open]);

  if (!open) return null;

  const failed = checks.filter((check) => !check.passed);
  const gatePassed = failed.length === 0;
  const needsTypedConfirmation = recipientCount > typedConfirmationThreshold;
  // Accept the number as displayed, with or without separators.
  const typedMatches =
    typed.replace(/[\s,.]/g, '') === String(recipientCount) && recipientCount > 0;

  const canSend =
    gatePassed && recipientCount > 0 && (!needsTypedConfirmation || typedMatches);

  return (
    <div className="sm-modal-backdrop">
      <div className="sm-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>Send this campaign?</h2>

        <dl className="sm-modal-facts">
          <div>
            <dt>Recipients</dt>
            <dd>
              <strong>{formatCount(recipientCount)}</strong> people
            </dd>
          </div>
          <div>
            <dt>List</dt>
            <dd>{listName}</dd>
          </div>
          <div>
            <dt>From</dt>
            <dd>
              {fromName} &lt;{fromEmail}&gt;
            </dd>
          </div>
          <div>
            <dt>Replies go to</dt>
            <dd>{replyTo}</dd>
          </div>
          <div>
            <dt>Subject</dt>
            <dd>{subject}</dd>
          </div>
        </dl>

        {!gatePassed && (
          <div className="sm-modal-blockers" role="alert">
            <p>
              This campaign cannot be sent until these are fixed:
            </p>
            <ul>
              {failed.map((check) => (
                <li key={check.id}>
                  {check.label}
                  {check.detail && <span className="muted"> — {check.detail}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {gatePassed && recipientCount === 0 && (
          <p role="alert" className="sm-modal-blockers">
            This segment currently matches nobody, so there is nothing to send.
          </p>
        )}

        {needsTypedConfirmation && gatePassed && recipientCount > 0 && (
          <p className="sm-modal-typed">
            <label htmlFor={inputId}>
              This is a large send. Type <strong>{formatCount(recipientCount)}</strong> to
              confirm.
            </label>
            <input
              id={inputId}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </p>
        )}

        <div className="sm-modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="sm-primary"
            disabled={!canSend}
            onClick={() => {
              if (canSend) onConfirm();
            }}
          >
            Send to {formatCount(recipientCount)} people
          </button>
        </div>
      </div>
    </div>
  );
}
