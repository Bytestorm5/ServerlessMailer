import { config } from '@/lib/config';
import { renderMergeFields } from '@/lib/merge';
import { escapeHtml } from '@/lib/pages';
import { renderEmailDocument } from '@/lib/render/template';
import { htmlToPlainText } from '@/lib/render/text';
import type { EmailContent } from '@/lib/ses/types';
import type { ListDoc } from '@/lib/types';

/**
 * The double opt-in confirmation email (spec §5.4).
 *
 * Plain, short, and obviously transactional. One clear call to action, no
 * marketing content and no tracking. It deliberately looks nothing like a
 * campaign, because its deliverability requirements are different and its job
 * is singular: get one link clicked.
 *
 * This is sent immediately via SES on signup — it does **not** go through the
 * campaign cron (§5.1 step 7) — and it goes out as a single `sendSimple`, so
 * unlike a campaign there is no SES template doing per-recipient substitution.
 * Every merge field is therefore resolved here, before rendering.
 *
 * A list may replace the whole thing with a `confirmation` template (§6.2a).
 * The built-in below is the fallback for a list that has not, and it is
 * deliberately the plainest thing that works.
 */

export function confirmationUrl(token: string): string {
  return `${config.appBaseUrl()}/api/confirm?token=${encodeURIComponent(token)}`;
}

export interface ConfirmationInput {
  list: ListDoc;
  token: string;
  /** The list's stored confirmation template, or `null` for the built-in one. */
  templateHtml?: string | null;
  /** Subscriber attributes, so a template can greet by name. */
  attributes?: Record<string, string>;
  /** The address this copy is going to, for `{{email}}`. */
  email?: string;
}

function subjectFor(list: ListDoc): string {
  return `Confirm your subscription to ${list.name}`;
}

/**
 * The built-in confirmation email.
 *
 * Intentionally a single anchor: a second link competes with the call to
 * action, and every extra element is another thing a spam filter can dislike.
 */
function builtIn(list: ListDoc, url: string): EmailContent {
  const safeUrl = escapeHtml(url);
  const safeName = escapeHtml(list.name);

  const text = [
    subjectFor(list),
    '',
    'Click the link below to confirm you want to receive these emails:',
    '',
    url,
    '',
    "If you didn't ask to subscribe, ignore this email and nothing will happen.",
    '',
    list.physicalAddress,
  ].join('\n');

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Confirm your subscription</title></head>
<body style="margin:0;padding:24px;background:#ffffff;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1c1a;">
<div style="max-width:32rem;margin:0 auto;">
<p style="margin:0 0 1rem;">Please confirm you want to receive <strong>${safeName}</strong>.</p>
<p style="margin:0 0 1.5rem;"><a href="${safeUrl}" style="color:#0b5cff;">Confirm your subscription</a></p>
<p style="margin:0 0 1rem;color:#57564f;font-size:14px;">If you didn&#39;t ask to subscribe, ignore this email and nothing will happen.</p>
<p style="margin:1.5rem 0 0;color:#8a887f;font-size:12px;">${escapeHtml(list.physicalAddress)}</p>
</div>
</body>
</html>`;

  return { subject: subjectFor(list), html, text };
}

/**
 * Builds the confirmation email, through the list's template when it has one.
 *
 * The plain-text part is derived from the rendered HTML rather than written
 * separately, so a template that changed the copy cannot leave the text part
 * saying something else. The confirmation URL survives that conversion: an
 * anchor renders as `text (url)`.
 */
export async function buildConfirmationEmail(
  input: ConfirmationInput,
): Promise<EmailContent> {
  const { list, token, templateHtml } = input;
  const url = confirmationUrl(token);

  if (!templateHtml) return builtIn(list, url);

  // No SES templating on this path, so every merge field resolves now.
  // `{{confirm_url}}` and the chrome placeholders are left for the renderer.
  const data: Record<string, string> = {
    ...(input.attributes ?? {}),
    email: input.email ?? '',
    list_name: list.name,
    physical_address: list.physicalAddress,
    subject: subjectFor(list),
  };
  const resolved = renderMergeFields(templateHtml, data);

  const html = await renderEmailDocument(
    resolved,
    {
      physicalAddress: list.physicalAddress,
      listName: list.name,
      // A confirmation email carries no unsubscribe link — the renderer knows
      // that from the kind. This only satisfies the shared chrome shape.
      unsubscribePlaceholder: '',
      confirmUrl: url,
    },
    'confirmation',
  );

  return { subject: subjectFor(list), html, text: htmlToPlainText(html) };
}
