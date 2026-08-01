'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * List configuration (spec §3.1).
 *
 * A list is the sending identity for one newsletter, so every field here ends
 * up in a real email or in the SES call that carries it. Two consequences shape
 * this screen:
 *
 *  - **Deactivate is offered before delete.** Deactivating closes signups and
 *    removes the list from the campaign picker while leaving subscribers and
 *    history intact. It is the reversible operation and the one an operator
 *    almost always wants.
 *  - **Delete is refused by the server** for a list that has subscribers or
 *    campaigns. The counts sit next to the button so the refusal is visible
 *    before it is triggered, and the server's explanation is shown verbatim.
 *  - **The join endpoint is shown, not documented elsewhere.** A list is only
 *    useful once something can post to it, and the one piece of the signup call
 *    an operator cannot guess is the list id. It lives on this row, so the curl
 *    command is built here.
 */

export interface ListRow {
  id: string;
  name: string;
  sendingDomain: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  physicalAddress: string;
  sesConfigurationSet: string;
  active: boolean;
  welcomeUrl: string | null;
  counts: { confirmed: number; pending: number; unsubscribed: number; campaigns: number };
}

type FormState = {
  name: string;
  sendingDomain: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  physicalAddress: string;
  sesConfigurationSet: string;
  welcomeUrl: string;
  active: boolean;
};

const EMPTY: FormState = {
  name: '',
  sendingDomain: '',
  fromName: '',
  fromEmail: '',
  replyTo: '',
  physicalAddress: '',
  sesConfigurationSet: '',
  welcomeUrl: '',
  active: true,
};

function toForm(row: ListRow): FormState {
  return {
    name: row.name,
    sendingDomain: row.sendingDomain,
    fromName: row.fromName,
    fromEmail: row.fromEmail,
    replyTo: row.replyTo,
    physicalAddress: row.physicalAddress,
    sesConfigurationSet: row.sesConfigurationSet,
    welcomeUrl: row.welcomeUrl ?? '',
    active: row.active,
  };
}

const num = (value: number) => value.toLocaleString('en-GB');

/** Single-quoted for the shell, with any embedded quote closed and reopened. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The signup call for one list, as a command that runs as-is.
 *
 * This is exactly what a public form posts (§5.1) — nothing about the endpoint
 * is admin-only. What an operator cannot obtain anywhere else is `listId`, and
 * a request without it is refused with the same "Unknown list." that an
 * inactive list produces, which is a confusing way to learn the field exists.
 *
 * The address is deliberately a placeholder: `/api/subscribe` does an MX lookup
 * on the domain, so `example.com` is rejected outright, and the confirmation
 * email has to land in a mailbox the operator can actually open.
 */
export function buildJoinCurl(input: {
  baseUrl: string;
  listId: string;
  turnstileRequired: boolean;
}): string {
  const body: Record<string, string> = {
    listId: input.listId,
    email: 'you@example.com',
  };
  // On a Turnstile-protected deployment the call is a flat 400 without this, so
  // the field is shown rather than left to be discovered by failing.
  if (input.turnstileRequired) body.turnstileToken = '<token from the Turnstile widget>';

  const url = `${input.baseUrl.replace(/\/+$/, '')}/api/subscribe`;
  return [
    `curl -X POST ${shellQuote(url)} \\`,
    `  -H 'content-type: application/json' \\`,
    `  -d ${shellQuote(JSON.stringify(body))}`,
  ].join('\n');
}

export function ListsManager({
  lists,
  baseUrl,
  turnstileRequired,
}: {
  lists: ListRow[];
  /** `APP_BASE_URL`, so the command targets the same origin the emails do. */
  baseUrl: string;
  turnstileRequired: boolean;
}) {
  const router = useRouter();
  // `null` = closed, `'new'` = creating, otherwise the id being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [testing, setTesting] = useState<ListRow | null>(null);
  const [testAddress, setTestAddress] = useState('');
  const [joining, setJoining] = useState<ListRow | null>(null);

  function openCreate() {
    setEditing('new');
    setTesting(null);
    setJoining(null);
    setForm(EMPTY);
    setError(null);
    setStatus(null);
  }

  function openEdit(row: ListRow) {
    setEditing(row.id);
    setTesting(null);
    setJoining(null);
    setForm(toForm(row));
    setError(null);
    setStatus(null);
  }

  function close() {
    setEditing(null);
    setError(null);
  }

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setStatus(null);

    const creating = editing === 'new';
    const response = await fetch(creating ? '/api/admin/lists' : `/api/admin/lists/${editing}`, {
      method: creating ? 'POST' : 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(form),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    setBusy(false);

    if (!response.ok) {
      setError(body.error ?? 'Could not save that list.');
      return;
    }
    setStatus(creating ? 'List created.' : 'List saved.');
    setEditing(null);
    router.refresh();
  }

  async function toggleActive(row: ListRow) {
    setBusy(true);
    setError(null);
    setStatus(null);
    const response = await fetch(`/api/admin/lists/${row.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ active: !row.active }),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    setBusy(false);

    if (!response.ok) {
      setError(body.error ?? 'Could not change that list.');
      return;
    }
    setStatus(row.active ? `"${row.name}" deactivated.` : `"${row.name}" activated.`);
    router.refresh();
  }

  async function sendTest(event: React.FormEvent) {
    event.preventDefault();
    if (!testing) return;

    setBusy(true);
    setError(null);
    setStatus(null);
    const response = await fetch(`/api/admin/lists/${testing.id}/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: [testAddress] }),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    setBusy(false);

    if (!response.ok) {
      setError(body.error ?? 'Could not send the test.');
      return;
    }
    // Arrival is the operator's check, not something this screen can assert.
    setStatus(
      `Test sent to ${testAddress}. Confirm it arrived, passed DKIM, and produced a delivery event.`,
    );
    setTesting(null);
    setTestAddress('');
  }

  async function copyJoinCurl(command: string) {
    setError(null);
    setStatus(null);
    try {
      await navigator.clipboard.writeText(command);
      setStatus('curl command copied.');
    } catch {
      // A denied permission, or a page served over plain HTTP. The command is
      // on screen either way, so say what happened instead of claiming a copy.
      setError('Could not reach the clipboard. Select the command above and copy it.');
    }
  }

  async function remove(row: ListRow) {
    setBusy(true);
    setError(null);
    setStatus(null);
    const response = await fetch(`/api/admin/lists/${row.id}`, { method: 'DELETE' });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    setConfirmingDelete(null);

    if (!response.ok) {
      // A 409 carries the server's explanation of what still references the
      // list; it is more useful than anything this component could invent.
      setError(body.error ?? 'Could not delete that list.');
      return;
    }
    setStatus(`"${row.name}" deleted.`);
    router.refresh();
  }

  return (
    <>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', margin: '1rem 0' }}>
        <button type="button" onClick={openCreate} disabled={busy}>
          New list
        </button>
        {status && (
          <span role="status" className="muted">
            {status}
          </span>
        )}
      </div>

      {error && (
        <p role="alert" className="sm-card is-warning" style={{ padding: '0.75rem' }}>
          {error}
        </p>
      )}

      {editing !== null && (
        <form onSubmit={submit} style={{ margin: '1rem 0', display: 'grid', gap: '0.75rem' }}>
          <h2 style={{ fontSize: '1rem', margin: 0 }}>
            {editing === 'new' ? 'New list' : `Edit ${form.name || 'list'}`}
          </h2>

          <Field
            id="list-name"
            label="Name"
            value={form.name}
            onChange={(v) => set('name', v)}
            hint="Shown in the campaign picker and in the send confirmation."
          />
          <Field
            id="list-sending-domain"
            label="Sending domain"
            value={form.sendingDomain}
            onChange={(v) => set('sendingDomain', v)}
            hint="Must be a verified SES identity, e.g. news.example.com. Sending is blocked until it is verified."
          />
          <Field
            id="list-from-name"
            label="From name"
            value={form.fromName}
            onChange={(v) => set('fromName', v)}
          />
          <Field
            id="list-from-email"
            label="From email"
            type="email"
            value={form.fromEmail}
            onChange={(v) => set('fromEmail', v)}
            hint="Must sit inside the sending domain — SES rejects a From address outside the verified identity."
          />
          <Field
            id="list-reply-to"
            label="Reply-to"
            type="email"
            value={form.replyTo}
            onChange={(v) => set('replyTo', v)}
            hint="A monitored mailbox. It needs no relationship to the sending domain."
          />
          <Field
            id="list-physical-address"
            label="Physical address"
            value={form.physicalAddress}
            onChange={(v) => set('physicalAddress', v)}
            hint="Legally required in every email. The pre-send gate checks it appears in the rendered body."
          />
          <Field
            id="list-config-set"
            label="SES configuration set"
            value={form.sesConfigurationSet}
            onChange={(v) => set('sesConfigurationSet', v)}
            hint="Routes bounce and complaint events to the webhook. Without it, reputation goes unmeasured."
          />
          <Field
            id="list-welcome-url"
            label="Welcome URL (optional)"
            value={form.welcomeUrl}
            onChange={(v) => set('welcomeUrl', v)}
            hint="Where a subscriber lands after confirming."
          />

          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => set('active', e.target.checked)}
            />
            Active — accepts new signups and appears in the campaign picker
          </label>

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="submit" disabled={busy}>
              {editing === 'new' ? 'Create list' : 'Save changes'}
            </button>
            <button type="button" onClick={close} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {testing && (
        <form onSubmit={sendTest} style={{ margin: '1rem 0', display: 'grid', gap: '0.5rem' }}>
          <h2 style={{ fontSize: '1rem', margin: 0 }}>Send a test from {testing.name}</h2>
          <p className="muted" style={{ margin: 0 }}>
            Sends a rendered message from {testing.fromEmail} through the{' '}
            {testing.sesConfigurationSet} configuration set. No campaign needed, nothing is
            recorded against any campaign, and the unsubscribe link in it is inert.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <label htmlFor="list-test-address">Send to</label>
            <input
              id="list-test-address"
              type="email"
              value={testAddress}
              placeholder="you@example.com"
              onChange={(e) => setTestAddress(e.target.value)}
            />
            <button type="submit" disabled={busy || !testAddress}>
              Send test
            </button>
            <button
              type="button"
              onClick={() => {
                setTesting(null);
                setError(null);
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {joining && (
        <section style={{ margin: '1rem 0', display: 'grid', gap: '0.5rem' }}>
          <h2 style={{ fontSize: '1rem', margin: 0 }}>Join endpoint for {joining.name}</h2>
          <p className="muted" style={{ margin: 0 }}>
            The request a signup form makes. It starts double opt-in: the address is stored
            as pending and a confirmation email goes out — nobody is subscribed by this call
            alone. The response is identical for a new, pending, confirmed or suppressed
            address, so it cannot be used to find out who is on the list.
          </p>

          <pre className="sm-code">
            {buildJoinCurl({ baseUrl, listId: joining.id, turnstileRequired })}
          </pre>

          <ul className="muted" style={{ margin: 0, paddingLeft: '1.1rem' }}>
            <li>
              Replace the address with a mailbox you can open. The domain needs an MX
              record, and the confirmation link arrives there.
            </li>
            <li>
              Merge fields go in an <code>attributes</code> object alongside{' '}
              <code>email</code>.
            </li>
            <li>
              Calls are rate-limited per IP, and a repeat for the same address inside the
              resend window returns the same success without sending anything.
            </li>
            {turnstileRequired && (
              <li>
                Turnstile is configured on this deployment, so the token has to be a real
                one issued by the widget.
              </li>
            )}
            {!joining.active && (
              <li>
                This list is inactive, so the endpoint answers &ldquo;Unknown list.&rdquo;
                until it is activated.
              </li>
            )}
          </ul>

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              type="button"
              onClick={() =>
                copyJoinCurl(
                  buildJoinCurl({ baseUrl, listId: joining.id, turnstileRequired }),
                )
              }
            >
              Copy command
            </button>
            <button
              type="button"
              onClick={() => {
                setJoining(null);
                setError(null);
              }}
            >
              Close
            </button>
          </div>
        </section>
      )}

      <div className="sm-scroll">
        <table className="sm-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Sending domain</th>
              <th>From</th>
              <th>Status</th>
              <th>Subscribers</th>
              <th>Campaigns</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {lists.map((row) => (
              <tr key={row.id}>
                <td>{row.name}</td>
                <td>{row.sendingDomain}</td>
                <td className="muted">
                  {row.fromName} &lt;{row.fromEmail}&gt;
                </td>
                <td>
                  <span className={`sm-badge${row.active ? ' is-confirmed' : ''}`}>
                    {row.active ? 'active' : 'inactive'}
                  </span>
                </td>
                <td>
                  {num(row.counts.confirmed)}
                  <span className="muted"> confirmed · {num(row.counts.pending)} pending</span>
                </td>
                <td>{num(row.counts.campaigns)}</td>
                <td>
                  {confirmingDelete === row.id ? (
                    <span style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
                      <span className="muted">Delete permanently?</span>
                      <button type="button" onClick={() => remove(row)} disabled={busy}>
                        Confirm delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmingDelete(null)}
                        disabled={busy}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    // Wrapping keeps Delete on screen at a narrow width instead
                    // of pushing it behind a horizontal scroll.
                    <span style={{ display: 'inline-flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        onClick={() => {
                          setTesting(row);
                          setEditing(null);
                          setJoining(null);
                          setError(null);
                          setStatus(null);
                        }}
                        disabled={busy}
                        aria-label={`Send test from ${row.name}`}
                      >
                        Send test
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setJoining(row);
                          setEditing(null);
                          setTesting(null);
                          setError(null);
                          setStatus(null);
                        }}
                        disabled={busy}
                        aria-label={`Join endpoint for ${row.name}`}
                      >
                        Join endpoint
                      </button>
                      <button type="button" onClick={() => openEdit(row)} disabled={busy}>
                        Edit
                      </button>
                      <button type="button" onClick={() => toggleActive(row)} disabled={busy}>
                        {row.active ? 'Deactivate' : 'Activate'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmingDelete(row.id);
                          setError(null);
                          setStatus(null);
                        }}
                        disabled={busy}
                        aria-label={`Delete ${row.name}`}
                      >
                        Delete
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {lists.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  No lists configured yet. Nothing can be sent until one exists.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  hint,
  type = 'text',
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  type?: string;
}) {
  return (
    <div style={{ display: 'grid', gap: '0.25rem' }}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...(hint ? { 'aria-describedby': `${id}-hint` } : {})}
      />
      {hint && (
        <span id={`${id}-hint`} className="muted" style={{ fontSize: '0.85em' }}>
          {hint}
        </span>
      )}
    </div>
  );
}
