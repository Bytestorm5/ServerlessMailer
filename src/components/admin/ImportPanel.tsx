'use client';

import { useState } from 'react';

interface ImportOutcome {
  total: number;
  imported: number;
  updated: number;
  skippedSuppressed: number;
  skippedTombstoned: number;
  errors: { row: number; email?: string; reason: string }[];
}

/**
 * CSV import with column mapping (spec §4.3).
 *
 * Importing as `confirmed` is gated behind an explicit attestation with fixed
 * wording, which is logged verbatim. The checkbox is the legal record, so it is
 * deliberately unchecked by default and its exact text is what gets stored.
 */
const ATTESTATION_TEXT =
  'I confirm that every address in this file gave prior opt-in consent to receive ' +
  'this newsletter, and that I can produce evidence of that consent on request.';

export function ImportPanel({ lists }: { lists: { id: string; name: string }[] }) {
  const [listId, setListId] = useState(lists[0]?.id ?? '');
  const [csv, setCsv] = useState('');
  const [filename, setFilename] = useState<string | undefined>();
  const [headers, setHeaders] = useState<string[]>([]);
  const [emailColumn, setEmailColumn] = useState('');
  const [attributeColumns, setAttributeColumns] = useState<Record<string, string>>({});
  const [attested, setAttested] = useState(false);
  const [attestedBy, setAttestedBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  function readHeaders(text: string) {
    const firstLine = text.replace(/^﻿/, '').split(/\r?\n/)[0] ?? '';
    // A light split purely to populate the mapping dropdowns; the server does
    // the real RFC 4180 parse.
    const cells = firstLine.split(',').map((cell) => cell.replace(/^"|"$/g, '').trim());
    setHeaders(cells);
    const guess = cells.find((cell) => /e-?mail/i.test(cell)) ?? cells[0] ?? '';
    setEmailColumn(guess);
  }

  if (lists.length === 0) {
    return (
      <section>
        <h2 style={{ fontSize: '1rem' }}>Import subscribers</h2>
        <p className="muted">Configure a list before importing subscribers.</p>
      </section>
    );
  }

  return (
    <section>
      <h2 style={{ fontSize: '1rem' }}>Import subscribers</h2>

      {lists.length > 1 && (
        <p>
          <label htmlFor="import-list">List</label>{' '}
          <select id="import-list" value={listId} onChange={(e) => setListId(e.target.value)}>
            {lists.map((list) => (
              <option key={list.id} value={list.id}>
                {list.name}
              </option>
            ))}
          </select>
        </p>
      )}

      <p>
        <label htmlFor="import-file">CSV file</label>{' '}
        <input
          id="import-file"
          type="file"
          accept=".csv,text/csv"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            const text = await file.text();
            setCsv(text);
            setFilename(file.name);
            readHeaders(text);
            setResult(null);
            setError(null);
          }}
        />
      </p>

      {headers.length > 0 && (
        <>
          <p>
            <label htmlFor="import-email-column">Email column</label>{' '}
            <select
              id="import-email-column"
              value={emailColumn}
              onChange={(e) => setEmailColumn(e.target.value)}
            >
              {headers.map((header) => (
                <option key={header} value={header}>
                  {header}
                </option>
              ))}
            </select>
          </p>

          <fieldset style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '0.75rem' }}>
            <legend>Map other columns to merge fields</legend>
            {headers
              .filter((header) => header !== emailColumn)
              .map((header) => (
                <p key={header} style={{ margin: '0.25rem 0' }}>
                  <label htmlFor={`map-${header}`}>{header}</label>{' '}
                  <input
                    id={`map-${header}`}
                    placeholder="ignored"
                    value={attributeColumns[header] ?? ''}
                    onChange={(e) =>
                      setAttributeColumns((current) => ({
                        ...current,
                        [header]: e.target.value,
                      }))
                    }
                  />
                </p>
              ))}
          </fieldset>

          <p style={{ marginTop: '1rem' }}>
            <label>
              <input
                type="checkbox"
                checked={attested}
                onChange={(e) => setAttested(e.target.checked)}
              />{' '}
              {ATTESTATION_TEXT}
            </label>
          </p>
          {attested && (
            <p>
              <label htmlFor="attested-by">Your name, for the record</label>{' '}
              <input
                id="attested-by"
                value={attestedBy}
                onChange={(e) => setAttestedBy(e.target.value)}
              />
            </p>
          )}
          <p className="muted">
            Without this attestation, imported addresses land as <strong>pending</strong> and
            receive a confirmation email.
          </p>

          <button
            type="button"
            className="sm-primary"
            disabled={busy || !csv || !emailColumn || (attested && attestedBy.trim() === '')}
            onClick={async () => {
              setBusy(true);
              setError(null);
              setResult(null);
              try {
                const attributes = Object.fromEntries(
                  Object.entries(attributeColumns).filter(([, value]) => value.trim() !== ''),
                );
                const response = await fetch('/api/admin/import', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    listId,
                    csv,
                    filename,
                    mapping: { email: emailColumn, attributes },
                    markConfirmed: attested,
                    attestation: attested
                      ? { text: ATTESTATION_TEXT, by: attestedBy }
                      : undefined,
                  }),
                });
                // A 33,000-row CSV is posted inline, so a proxy 413/502/504
                // returning HTML is entirely plausible. Unguarded, the reject
                // would escape this handler and the operator would see nothing
                // but the button flipping back — and press it again.
                const body = (await response.json().catch(() => null)) as
                  | (ImportOutcome & { error?: string })
                  | null;
                if (!body) {
                  setError(
                    `The server returned an unreadable response (${response.status}). ` +
                      'The import may not have run — check the subscriber count before retrying.',
                  );
                  return;
                }
                if (!response.ok) {
                  setError(body.error ?? 'Import failed.');
                  return;
                }
                setResult(body);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Importing…' : 'Import'}
          </button>
        </>
      )}

      {error && (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      {result && (
        <div role="status" style={{ marginTop: '1rem' }}>
          <p>
            {result.imported} added, {result.updated} updated,{' '}
            {result.skippedSuppressed} skipped because they are suppressed,{' '}
            {result.skippedTombstoned} left alone because they had unsubscribed or bounced.
          </p>
          {result.errors.length > 0 && (
            <>
              {/* Malformed rows are reported, never silently dropped. */}
              <p>{result.errors.length} rows could not be imported:</p>
              <table className="sm-table">
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Value</th>
                    <th>Problem</th>
                  </tr>
                </thead>
                <tbody>
                  {result.errors.slice(0, 200).map((rowError) => (
                    <tr key={`${rowError.row}`}>
                      <td>{rowError.row}</td>
                      <td>{rowError.email ?? ''}</td>
                      <td>{rowError.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </section>
  );
}
