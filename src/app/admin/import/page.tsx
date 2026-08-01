'use client';

import Papa from 'papaparse';
import { useEffect, useMemo, useState } from 'react';
import { Button, Card, ErrorNote, Field, Spinner, inputClass } from '@/components/ui';
import { api, formatNumber } from '@/lib/client';
import type { ImportJobDoc, ListDoc } from '@/lib/types';

/**
 * CSV import (§4.3).
 *
 * Parsing happens in the browser and rows are posted in chunks: 33,000 rows
 * will not process inside one serverless invocation, and chunking gives a live
 * progress count and a per-row error report rather than a silent partial
 * success.
 */

const CHUNK_SIZE = 500;
const TARGET_FIELDS = ['email', 'first_name', 'last_name'];

interface ParsedFile {
  filename: string;
  headers: string[];
  rows: Record<string, string>[];
}

export default function ImportPage() {
  const [lists, setLists] = useState<ListDoc[]>([]);
  const [listId, setListId] = useState('');
  const [file, setFile] = useState<ParsedFile | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [attested, setAttested] = useState(false);
  const [attestationText, setAttestationText] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [job, setJob] = useState<ImportJobDoc | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [listsResponse, jobsResponse] = await Promise.all([
        api<{ lists: ListDoc[] }>('/api/admin/lists'),
        api<{ attestationText: string }>('/api/admin/imports'),
      ]);
      setLists(listsResponse.lists);
      if (listsResponse.lists.length > 0) setListId(String(listsResponse.lists[0]!._id));
      setAttestationText(jobsResponse.attestationText);
    })();
  }, []);

  const selectedList = useMemo(() => lists.find((list) => String(list._id) === listId), [lists, listId]);
  const targetFields = useMemo(
    () => [...TARGET_FIELDS, ...(selectedList?.mergeFields ?? [])],
    [selectedList],
  );

  const onFile = (input: File) => {
    setError(null);
    setJob(null);
    Papa.parse<Record<string, string>>(input, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        const headers = result.meta.fields ?? [];
        setFile({ filename: input.name, headers, rows: result.data });
        // Guess the mapping from the header names — most exports use
        // recognisable ones, and a wrong guess is visible and correctable.
        const guessed: Record<string, string> = {};
        for (const field of TARGET_FIELDS) {
          const match = headers.find((header) => {
            const normalized = header.toLowerCase().replace(/[^a-z]/g, '');
            if (field === 'email') return normalized === 'email' || normalized === 'emailaddress';
            if (field === 'first_name') return normalized === 'firstname' || normalized === 'fname';
            if (field === 'last_name') return normalized === 'lastname' || normalized === 'lname' || normalized === 'surname';
            return false;
          });
          if (match) guessed[field] = match;
        }
        setMapping(guessed);
      },
      error: (parseError: Error) => setError(parseError.message),
    });
  };

  const run = async () => {
    if (!file || !listId || !mapping.email) return;
    setRunning(true);
    setError(null);
    setProgress(0);

    try {
      const created = await api<{ jobId: string }>('/api/admin/imports', {
        method: 'POST',
        json: { listId, filename: file.filename, mapping, attested },
      });

      for (let index = 0; index < file.rows.length; index += CHUNK_SIZE) {
        const rows = file.rows.slice(index, index + CHUNK_SIZE);
        await api(`/api/admin/imports/${created.jobId}`, {
          method: 'POST',
          json: { action: 'chunk', rows, startingRowNumber: index + 2 },
        });
        setProgress(Math.min(file.rows.length, index + rows.length));
      }

      const finished = await api<{ job: ImportJobDoc }>(`/api/admin/imports/${created.jobId}`, {
        method: 'POST',
        json: { action: 'complete' },
      });
      setJob(finished.job);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Import subscribers</h1>
        <p className="text-sm text-ink-500">
          Every address is checked against the suppression list and skipped on a match. Import your suppression list
          first.
        </p>
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <Card className="space-y-4">
        <Field label="Target list">
          <select className={inputClass} value={listId} onChange={(event) => setListId(event.target.value)}>
            {lists.map((list) => (
              <option key={String(list._id)} value={String(list._id)}>
                {list.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="CSV file">
          <input
            type="file"
            accept=".csv,text/csv"
            className="block w-full text-sm"
            onChange={(event) => {
              const selected = event.target.files?.[0];
              if (selected) onFile(selected);
            }}
          />
        </Field>

        {file ? (
          <>
            <p className="text-sm text-ink-600">
              {formatNumber(file.rows.length)} rows in <span className="font-medium">{file.filename}</span>
            </p>

            <div>
              <p className="mb-2 text-sm font-medium text-ink-700">Column mapping</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {targetFields.map((field) => (
                  <label key={field} className="flex items-center gap-2 text-sm">
                    <span className="w-24 shrink-0 text-ink-600">{field}</span>
                    <select
                      className={inputClass}
                      value={mapping[field] ?? ''}
                      onChange={(event) => setMapping({ ...mapping, [field]: event.target.value })}
                    >
                      <option value="">— not imported —</option>
                      {file.headers.map((header) => (
                        <option key={header} value={header}>
                          {header}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              {!mapping.email ? (
                <p className="mt-2 text-xs text-red-700">An email column is required.</p>
              ) : null}
            </div>

            <div className="rounded border border-amber-300 bg-amber-50 p-4">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={attested}
                  onChange={(event) => setAttested(event.target.checked)}
                />
                <span>
                  <span className="font-medium">{attestationText}</span>
                  <span className="mt-1 block text-xs text-amber-900">
                    Ticked: addresses are imported as <strong>confirmed</strong> and this attestation is recorded
                    against every one of them. Unticked: they are imported as <strong>pending</strong> and each
                    receives a confirmation email.
                  </span>
                </span>
              </label>
            </div>

            <Button variant="primary" disabled={running || !mapping.email} onClick={() => void run()}>
              {running ? <Spinner /> : null} Import {formatNumber(file.rows.length)} rows
            </Button>

            {running ? (
              <div>
                <div className="h-2 w-full overflow-hidden rounded bg-ink-100">
                  <div
                    className="h-full bg-ink-800 transition-all"
                    style={{ width: `${Math.round((progress / file.rows.length) * 100)}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-ink-500">
                  {formatNumber(progress)} / {formatNumber(file.rows.length)} rows
                </p>
              </div>
            ) : null}
          </>
        ) : null}
      </Card>

      {job ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">Import result</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            <Stat label="Rows" value={job.counts.rows} />
            <Stat label="Created" value={job.counts.created} />
            <Stat label="Updated" value={job.counts.updated} />
            <Stat label="Suppressed" value={job.counts.suppressed} />
            <Stat label="Invalid" value={job.counts.invalid} />
          </div>
          {job.errors.length > 0 ? (
            <div className="mt-4">
              <p className="mb-2 text-sm font-medium text-ink-700">
                Rows not imported (showing the most recent {job.errors.length})
              </p>
              <div className="max-h-64 overflow-auto rounded border border-ink-200">
                <table className="w-full text-xs">
                  <thead className="bg-ink-50 text-left text-ink-500">
                    <tr>
                      <th className="px-3 py-1.5">Row</th>
                      <th className="px-3 py-1.5">Email</th>
                      <th className="px-3 py-1.5">Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {job.errors.map((row, index) => (
                      <tr key={`${row.row}-${index}`}>
                        <td className="px-3 py-1.5">{row.row}</td>
                        <td className="px-3 py-1.5 font-mono">{row.email || '—'}</td>
                        <td className="px-3 py-1.5">{row.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-ink-500">{label}</p>
      <p className="text-xl font-semibold">{formatNumber(value)}</p>
    </div>
  );
}
