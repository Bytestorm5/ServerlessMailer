import { logger } from '@/lib/logging';
import { escapeHtml } from '@/lib/render/html';
import { sanitizeEmailHtml } from '@/lib/render/sanitize';
import { findMergeFieldsWithoutFallback, findUnknownMergeFields } from '@/lib/merge';
import type { EmailChrome } from '@/lib/render/html';

/**
 * Hand-authored email templates (spec §6.2a).
 *
 * §6.2 says not to hand-author table-based email HTML, and for the built-in
 * layout that still stands — MJML solves Outlook's Word rendering engine and
 * re-solving it is a waste. But a newsletter is a piece of design, and a
 * generated layout can only ever be the layout its generator knows about. A
 * template is the escape hatch: one HTML document per list, written by the
 * operator with the full run of tables, VML, media queries and MSO conditional
 * comments, with a `{{content}}` slot where the campaign body lands.
 *
 * The pipeline around it is unchanged and the guarantees are not negotiable:
 *
 *  - **Escaping stays at the edges.** Everything substituted into the template
 *    is escaped here; the template itself is operator-authored and passes
 *    through as written, minus what `sanitizeEmailHtml` removes.
 *  - **Merge placeholders survive.** `{{unsubscribe_url}}` and the subscriber
 *    attributes are left as SES placeholders, so one frozen body still serves
 *    every recipient (§7.1).
 *  - **The footer is guaranteed, not requested.** An email without an
 *    unsubscribe link or a postal address is illegal, so a template that omits
 *    either gets the missing part appended rather than a validation error at
 *    send time. Nothing here is behind a caller-supplied flag.
 */

/* ------------------------------------------------------------------ */
/* placeholders                                                        */
/* ------------------------------------------------------------------ */

/**
 * Placeholders that mean something only inside a template.
 *
 * Everything else in `{{…}}` is an ordinary merge field, resolved per recipient
 * by SES, so these two have to be excluded wherever merge fields are scanned —
 * otherwise the §6.6 gate reports `content` as an unknown field and blocks
 * every send.
 */
export const TEMPLATE_ONLY_PLACEHOLDERS = ['content', 'preheader'] as const;

export interface TemplatePlaceholderDoc {
  key: string;
  label: string;
  description: string;
}

/** Drives the reference list on the template page. */
export const TEMPLATE_PLACEHOLDERS: readonly TemplatePlaceholderDoc[] = Object.freeze([
  {
    key: 'content',
    label: 'Campaign body',
    description: 'Required. Where the campaign body is inserted.',
  },
  {
    key: 'preheader',
    label: 'Preheader',
    description: "The campaign's preheader, for the hidden inbox-preview line.",
  },
  {
    key: 'subject',
    label: 'Subject line',
    description: "The campaign's subject line.",
  },
  {
    key: 'list_name',
    label: 'Newsletter name',
    description: 'The name of the list this campaign is sent from.',
  },
  {
    key: 'physical_address',
    label: 'Postal address',
    description: 'Legally required. Appended automatically if you leave it out.',
  },
  {
    key: 'unsubscribe_url',
    label: 'Unsubscribe link',
    description: 'Legally required. Appended automatically if you leave it out.',
  },
  {
    key: 'email',
    label: "Recipient's email address",
    description: 'The address this copy of the email was sent to.',
  },
].map((entry) => Object.freeze(entry)));

function placeholderPattern(name: string): RegExp {
  return new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'g');
}

const CONTENT_PATTERN = placeholderPattern('content');

/**
 * Removes the template-only placeholders so the remaining text can be handed to
 * the merge-field scanner. Replaced with a space rather than deleted, so two
 * placeholders either side of a word cannot fuse into one token.
 */
export function stripTemplateOnlyPlaceholders(html: string): string {
  let out = html;
  for (const name of TEMPLATE_ONLY_PLACEHOLDERS) {
    out = out.replace(placeholderPattern(name), ' ');
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* the default template                                                */
/* ------------------------------------------------------------------ */

/* Brand tokens, matching the portal's own transactional email. */
const PLUM_700 = '#59334D';
const PINK_300 = '#DB96A3';
const SAND_BG = '#F5EFE9';
const INK_STRONG = '#2F1B29';
const INK_BODY = '#483F38';
const INK_MUTED = '#8A7C72';

/**
 * The template a list starts from.
 *
 * A port of the branded shell the portal's transactional email already uses, so
 * a newsletter and a "your application was received" arrive looking like they
 * came from the same organisation. Built for old and limited clients: a
 * table-based layout, no web fonts, no images in the chrome, and every colour
 * spelled out — the `<style>` block is a convenience that the renderer inlines
 * before sending, not something a client is trusted to honour.
 */
export const DEFAULT_TEMPLATE_HTML = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>{{subject}}</title>
<style>
  /* Inlined onto the elements themselves before sending — Gmail drops <style>. */
  .sm-content h1, .sm-content h2, .sm-content h3, .sm-content h4 {
    margin: 0 0 12px;
    font-family: Georgia, 'Times New Roman', Times, serif;
    color: ${INK_STRONG};
    font-weight: bold;
    line-height: 1.25;
  }
  .sm-content h1 { font-size: 26px; }
  .sm-content h2 { font-size: 21px; }
  .sm-content h3 { font-size: 18px; }
  .sm-content h4 { font-size: 16px; }
  .sm-content p {
    margin: 0 0 16px;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 16px;
    line-height: 24px;
    color: ${INK_BODY};
  }
  .sm-content ul, .sm-content ol {
    margin: 0 0 16px;
    padding-left: 22px;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 16px;
    line-height: 24px;
    color: ${INK_BODY};
  }
  .sm-content li { margin: 0 0 6px; }
  .sm-content blockquote {
    margin: 0 0 16px;
    padding: 4px 0 4px 16px;
    border-left: 3px solid ${PINK_300};
    font-family: Georgia, 'Times New Roman', Times, serif;
    font-style: italic;
    color: ${INK_MUTED};
  }
  .sm-content a { color: ${PLUM_700}; text-decoration: underline; }
  .sm-content img { max-width: 100%; height: auto; border: 0; }
  .sm-content hr {
    border: 0;
    border-top: 1px solid #E7DDD4;
    margin: 24px 0;
  }
  @media only screen and (max-width: 620px) {
    .sm-card { width: 100% !important; }
    .sm-content { padding: 24px 20px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${SAND_BG};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">{{preheader}}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${SAND_BG};">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" class="sm-card" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;border-radius:10px;overflow:hidden;">
          <tr>
            <td align="center" bgcolor="${PLUM_700}" style="background-color:${PLUM_700};padding:30px 24px;">
              <div style="font-family:Georgia,'Times New Roman',Times,serif;font-size:26px;line-height:30px;color:#ffffff;font-weight:bold;letter-spacing:0.3px;">
                {{list_name}}
              </div>
              <div style="height:2px;width:46px;background-color:${PINK_300};margin:12px auto;font-size:0;line-height:0;">&nbsp;</div>
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:16px;color:${PINK_300};text-transform:uppercase;letter-spacing:3px;">
                Newsletter
              </div>
            </td>
          </tr>
          <tr>
            <td class="sm-content" style="padding:34px 36px 30px 36px;">
{{content}}
            </td>
          </tr>
          <tr>
            <td bgcolor="${SAND_BG}" style="background-color:${SAND_BG};padding:20px 36px;">
              <p style="margin:0 0 8px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:${INK_MUTED};">
                {{physical_address}}
              </p>
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:${INK_MUTED};">
                <a href="{{unsubscribe_url}}" style="color:${INK_MUTED};text-decoration:underline;">Unsubscribe</a>
              </p>
            </td>
          </tr>
        </table>
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:16px;color:${INK_MUTED};padding:16px 0 0 0;">
          {{list_name}}
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`;

/* ------------------------------------------------------------------ */
/* validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * A template larger than this is not a template. The bound exists because the
 * document is re-rendered on every keystroke of the preview and stored on the
 * campaign at freeze time.
 */
export const MAX_TEMPLATE_LENGTH = 200_000;

export interface TemplateValidation {
  ok: boolean;
  errors: string[];
  /** What `sanitizeEmailHtml` would strip, so the operator is never surprised. */
  removed: string[];
}

/**
 * Checks a template before it is stored.
 *
 * Returns every problem rather than the first: this drives an editor-facing
 * list, and an editor that reveals one problem per save is an editor people
 * learn to fight.
 */
export function validateTemplateHtml(input: unknown): TemplateValidation {
  const errors: string[] = [];

  if (typeof input !== 'string') {
    return { ok: false, errors: ['template must be a string'], removed: [] };
  }
  if (input.trim() === '') {
    return { ok: false, errors: ['template is empty'], removed: [] };
  }
  if (input.length > MAX_TEMPLATE_LENGTH) {
    return {
      ok: false,
      errors: [`template must be ${MAX_TEMPLATE_LENGTH.toLocaleString('en-GB')} characters or fewer`],
      removed: [],
    };
  }

  if (!CONTENT_PATTERN.test(input)) {
    errors.push('template must contain {{content}}, which is where the campaign body goes');
  }
  CONTENT_PATTERN.lastIndex = 0;

  // The same two merge-field rules the §6.6 gate applies to a body. Catching
  // them here means the operator learns about a typo while looking at the
  // template, rather than from a blocked send an hour later.
  const scanned = stripTemplateOnlyPlaceholders(input);
  for (const ref of findUnknownMergeFields(scanned)) {
    errors.push(`unknown placeholder {{${ref.field}}}`);
  }
  for (const ref of findMergeFieldsWithoutFallback(scanned)) {
    errors.push(`{{${ref.field}}} needs a fallback, e.g. {{ ${ref.field} | default: "there" }}`);
  }

  const { removed } = sanitizeEmailHtml(input);
  return { ok: errors.length === 0, errors, removed };
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

/** Multi-line postal addresses read as one run-on line without this. */
function addressHtml(address: string): string {
  return escapeHtml(address)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .join('<br />');
}

function insertBeforeBodyClose(html: string, block: string): string {
  const index = html.toLowerCase().lastIndexOf('</body>');
  return index === -1 ? html + block : html.slice(0, index) + block + html.slice(index);
}

const FOOTER_STYLE =
  'margin:0 0 8px;font-family:Arial,Helvetica,sans-serif;font-size:12px;' +
  `line-height:18px;color:${INK_MUTED};text-align:center;`;

/**
 * The parts of the legally required footer a template left out.
 *
 * Only the missing parts: a template that already carries its own unsubscribe
 * link gets no second one, and a template that carries both gets nothing at
 * all. Appending unconditionally would punish the templates that got it right.
 */
function complianceFooter(missing: { unsubscribe?: string; address?: string }): string {
  const lines: string[] = [];
  if (missing.address) lines.push(`<p style="${FOOTER_STYLE}">${missing.address}</p>`);
  if (missing.unsubscribe) {
    lines.push(
      `<p style="${FOOTER_STYLE}">` +
        `<a href="${missing.unsubscribe}" style="color:${INK_MUTED};">Unsubscribe</a>` +
        '</p>',
    );
  }
  if (lines.length === 0) return '';
  return `\n<div style="padding:16px 12px;background-color:${SAND_BG};">${lines.join('')}</div>\n`;
}

/** A 1×1 tracking pixel (§13), styled so no client stretches it. */
function openPixel(url: string): string {
  return (
    `\n<img src="${escapeHtml(url)}" width="1" height="1" alt=""` +
    ' style="display:block;border:0;width:1px;height:1px;overflow:hidden;" />\n'
  );
}

/**
 * Inlines the template's own CSS onto the elements it matches.
 *
 * Gmail strips `<style>`, so a template whose typography lives in a stylesheet
 * arrives unstyled for a large share of the list. `juice` is loaded lazily for
 * the same reason MJML is: it is a server-only dependency on a path that a
 * client bundle must never pull in.
 *
 * A failure here is not fatal. Un-inlined CSS is a worse-looking email; a
 * thrown error is no email at all, and the `<style>` block is still in the
 * document for the clients that honour it.
 */
async function inlineCss(html: string): Promise<string> {
  try {
    const juice = (await import('juice')).default;
    return juice(html, {
      preserveImportant: true,
      // Media queries cannot be inlined, so juice keeps them in a <style> block.
      preserveMediaQueries: true,
      preserveFontFaces: true,
    });
  } catch (err) {
    logger.warn('render.template: CSS inlining failed, sending un-inlined', {
      error: err instanceof Error ? err.message : String(err),
    });
    return html;
  }
}

export class TemplateRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateRenderError';
  }
}

/** True when a template has somewhere to put the campaign body. */
export function hasContentSlot(html: string): boolean {
  const found = CONTENT_PATTERN.test(html);
  CONTENT_PATTERN.lastIndex = 0;
  return found;
}

/**
 * Finishes one email document: campaign-constant placeholders, the guaranteed
 * footer, the open pixel, sanitizing, and CSS inlining.
 *
 * Called with a template that already has its body in place, and called
 * directly for a body the operator pasted as a whole HTML document — in that
 * case the paste *is* the email, and it earns the same chrome guarantees a
 * template gets rather than a separate, weaker path.
 *
 * The placeholders resolved here are the ones constant for the whole campaign:
 * the list name, the postal address, the preheader. Everything per-recipient is
 * deliberately *not* resolved — `{{unsubscribe_url}}` becomes whatever the
 * caller's chrome says, which is the bare SES placeholder for a real send and a
 * signed URL for a preview.
 */
export async function renderEmailDocument(
  documentHtml: string,
  chrome: EmailChrome,
): Promise<string> {
  const listName = typeof chrome.listName === 'string' ? chrome.listName.trim() : '';
  const address = typeof chrome.physicalAddress === 'string' ? chrome.physicalAddress : '';
  const preheader = typeof chrome.preheader === 'string' ? chrome.preheader.trim() : '';
  const unsubscribeHref = escapeHtml(chrome.unsubscribePlaceholder || '{{unsubscribe_url}}');

  let html = documentHtml
    .replace(placeholderPattern('preheader'), () => escapeHtml(preheader))
    .replace(placeholderPattern('list_name'), () => escapeHtml(listName))
    .replace(placeholderPattern('physical_address'), () => addressHtml(address))
    .replace(placeholderPattern('unsubscribe_url'), () => unsubscribeHref);

  const footer = complianceFooter({
    unsubscribe: html.includes(unsubscribeHref) ? undefined : unsubscribeHref,
    address:
      address.trim() === '' || html.includes(addressHtml(address))
        ? undefined
        : addressHtml(address),
  });
  if (footer !== '') html = insertBeforeBodyClose(html, footer);

  if (chrome.openPixelUrl) html = insertBeforeBodyClose(html, openPixel(chrome.openPixelUrl));

  return inlineCss(sanitizeEmailHtml(html).html);
}

export interface ApplyTemplateInput {
  /** The operator's template document. */
  templateHtml: string;
  /** Already-escaped HTML for the `{{content}}` slot. */
  contentHtml: string;
  chrome: EmailChrome;
}

/** Renders one email: the template, with the body in its `{{content}}` slot. */
export async function applyTemplate(input: ApplyTemplateInput): Promise<string> {
  if (!hasContentSlot(input.templateHtml)) {
    // Fail closed (§1.2): storage rejects a template without a content slot, so
    // reaching this means the document was edited around the application. An
    // email that silently dropped its body is worse than one that did not send.
    throw new TemplateRenderError('template has no {{content}} placeholder');
  }

  // A replacement *function*, because `$&` and friends are meaningful in a
  // replacement string and a campaign body will contain a `$` eventually.
  const documentHtml = input.templateHtml.replace(CONTENT_PATTERN, () => input.contentHtml);
  return renderEmailDocument(documentHtml, input.chrome);
}
