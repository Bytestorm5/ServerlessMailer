'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface TemplateListOption {
  id: string;
  name: string;
  /** False when the list is still on the built-in layout. */
  stored: boolean;
  html: string;
  updatedAt: string | null;
}

export interface TemplatePlaceholderOption {
  key: string;
  label: string;
  description: string;
}

export interface TemplateManagerProps {
  lists: TemplateListOption[];
  /** The starting point, and what "Reset" restores. */
  defaultHtml: string;
  placeholders: TemplatePlaceholderOption[];
}

type Width = 'desktop' | 'mobile';

const WIDTHS: Record<Width, string> = { desktop: '100%', mobile: '375px' };

const SAVE_LABELS: Record<string, string> = {
  idle: '',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Not saved',
};

async function jsonOrThrow(response: Response) {
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    errors?: string[];
  };
  if (!response.ok) {
    const detail = body.errors?.length ? body.errors.join('; ') : body.error;
    throw new Error(detail ?? `Request failed (${response.status})`);
  }
  return body as Record<string, unknown>;
}

/**
 * The template editor (spec §6.2a).
 *
 * Source on the left, live preview on the right — the same shape as the
 * campaign screen, because it is the same job at a different altitude. What is
 * deliberately *not* here is a visual builder: the point of this page is that
 * the operator gets the actual HTML, so anything that stands between them and
 * the document is working against it.
 *
 * The preview is a sandboxed iframe for the same reason the campaign preview
 * is: the document is operator-authored, but the admin origin holds the session
 * cookie and there is no reason to let template content run there.
 */
export function TemplateManager({ lists, defaultHtml, placeholders }: TemplateManagerProps) {
  const [listId, setListId] = useState(lists[0]?.id ?? '');
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(lists.map((list) => [list.id, list.html])),
  );
  const [stored, setStored] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(lists.map((list) => [list.id, list.stored])),
  );
  const [status, setStatus] = useState<keyof typeof SAVE_LABELS>('idle');
  const [errors, setErrors] = useState<string[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [preview, setPreview] = useState('');
  const [previewError, setPreviewError] = useState<string | undefined>();
  const [width, setWidth] = useState<Width>('desktop');
  const sourceRef = useRef<HTMLTextAreaElement>(null);

  const html = drafts[listId] ?? defaultHtml;
  const selected = useMemo(() => lists.find((list) => list.id === listId), [lists, listId]);

  /**
   * A list on the built-in layout is told so until it saves. Which of the two
   * states you are in is the thing most easily got wrong on this page: the
   * editor looks identical either way.
   */
  const statusLabel = [
    SAVE_LABELS[status] ?? '',
    stored[listId] ? '' : 'Using the built-in layout — save to switch this list over',
  ]
    .filter((part) => part !== '')
    .join(' · ');

  /**
   * Re-render on a debounce. The template is a whole document and the render
   * runs MJML-free but still inlines CSS, so firing on every keystroke would
   * queue requests behind each other.
   */
  useEffect(() => {
    if (!listId) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void fetch(`/api/admin/templates/${listId}/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ html }),
      })
        .then(async (response) => {
          const body = (await response.json().catch(() => ({}))) as {
            html?: string;
            errors?: string[];
            removed?: string[];
          };
          if (cancelled) return;
          if (!response.ok) {
            setPreviewError(body.errors?.join('; ') ?? `Request failed (${response.status})`);
            return;
          }
          setPreview(body.html ?? '');
          setRemoved(body.removed ?? []);
          setPreviewError(undefined);
        })
        .catch((err: unknown) => {
          if (!cancelled) setPreviewError(err instanceof Error ? err.message : String(err));
        });
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [listId, html]);

  const update = useCallback(
    (next: string) => {
      setDrafts((current) => ({ ...current, [listId]: next }));
      setStatus('dirty');
      setErrors([]);
    },
    [listId],
  );

  /** Inserts at the cursor rather than at the end: a template is 200 lines long. */
  const insertPlaceholder = useCallback(
    (key: string) => {
      const field = sourceRef.current;
      const token = `{{${key}}}`;
      if (!field) {
        update(html + token);
        return;
      }
      const start = field.selectionStart;
      const end = field.selectionEnd;
      update(html.slice(0, start) + token + html.slice(end));
      requestAnimationFrame(() => {
        field.focus();
        field.setSelectionRange(start + token.length, start + token.length);
      });
    },
    [html, update],
  );

  async function save() {
    setStatus('saving');
    setErrors([]);
    try {
      const body = await jsonOrThrow(
        await fetch(`/api/admin/templates/${listId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ html }),
        }),
      );
      setStored((current) => ({ ...current, [listId]: true }));
      setRemoved((body.removed as string[]) ?? []);
      setStatus('saved');
    } catch (err) {
      setStatus('error');
      setErrors(err instanceof Error ? err.message.split('; ') : [String(err)]);
    }
  }

  async function revertToBuiltIn() {
    setStatus('saving');
    setErrors([]);
    try {
      await jsonOrThrow(
        await fetch(`/api/admin/templates/${listId}`, { method: 'DELETE' }),
      );
      setStored((current) => ({ ...current, [listId]: false }));
      setDrafts((current) => ({ ...current, [listId]: defaultHtml }));
      setStatus('idle');
    } catch (err) {
      setStatus('error');
      setErrors([err instanceof Error ? err.message : String(err)]);
    }
  }

  if (lists.length === 0) {
    return (
      <p className="muted">
        Templates belong to a list. Create one on the Lists page first — it holds the
        newsletter name and the postal address this page renders into the footer.
      </p>
    );
  }

  return (
    <div className="sm-template">
      <header className="sm-template-head">
        {lists.length > 1 && (
          <label>
            Template for{' '}
            <select value={listId} onChange={(event) => setListId(event.target.value)}>
              {lists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <span role="status" className={status === 'error' ? 'sm-save-error' : 'muted'}>
          {statusLabel}
        </span>

        <div className="sm-template-actions">
          <button type="button" onClick={() => update(defaultHtml)}>
            Reset to default
          </button>
          {stored[listId] && (
            <button type="button" onClick={() => void revertToBuiltIn()}>
              Use built-in layout
            </button>
          )}
          <button
            type="button"
            className="sm-primary"
            disabled={status === 'saving'}
            onClick={() => void save()}
          >
            Save template
          </button>
        </div>
      </header>

      {errors.length > 0 && (
        <ul role="alert" className="sm-template-errors">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}

      {removed.length > 0 && (
        <p className="sm-template-warning">
          Removed before sending: {removed.join(', ')}. Mailbox providers strip these
          anyway, and shipping them costs sender reputation.
        </p>
      )}

      <div className="sm-template-body">
        <div className="sm-template-source">
          <label htmlFor="sm-template-html">Template HTML</label>
          <textarea
            id="sm-template-html"
            ref={sourceRef}
            spellCheck={false}
            value={html}
            onChange={(event) => update(event.target.value)}
          />

          <details className="sm-template-fields">
            <summary>Placeholders ({placeholders.length})</summary>
            <ul>
              {placeholders.map((placeholder) => (
                <li key={placeholder.key}>
                  <button type="button" onClick={() => insertPlaceholder(placeholder.key)}>
                    {'{{'}
                    {placeholder.key}
                    {'}}'}
                  </button>
                  <span>
                    <strong>{placeholder.label}</strong> — {placeholder.description}
                  </span>
                </li>
              ))}
            </ul>
            <p className="muted">
              Subscriber attributes work too, and need a fallback:{' '}
              {'{{ first_name | default: "there" }}'}
            </p>
          </details>
        </div>

        <section className="sm-preview" aria-label="Template preview">
          <header className="sm-preview-bar">
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
            <p className="muted">
              Sample content, {selected?.name ?? 'this list'}&rsquo;s footer.
            </p>
          </header>

          {previewError ? (
            <p role="alert" className="sm-preview-error">
              This template does not currently render: {previewError}
            </p>
          ) : (
            <div className="sm-preview-stage">
              <iframe
                title="Template preview"
                sandbox=""
                srcDoc={preview}
                style={{ width: WIDTHS[width] }}
                className="sm-preview-frame"
              />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
