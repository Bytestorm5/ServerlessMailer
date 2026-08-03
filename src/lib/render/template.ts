import { logger } from '@/lib/logging';
import { escapeHtml } from '@/lib/render/html';
import { sanitizeEmailHtml } from '@/lib/render/sanitize';
import { findMergeFieldsWithoutFallback, findUnknownMergeFields } from '@/lib/merge';
import { TEMPLATE_KINDS, type TemplateKind } from '@/lib/types';
import type { EmailChrome } from '@/lib/render/html';

/**
 * Hand-authored email templates (spec §6.2a).
 *
 * §6.2 says not to hand-author table-based email HTML, and for the built-in
 * layout that still stands — MJML solves Outlook's Word rendering engine and
 * re-solving it is a waste. But an email is a piece of design, and a generated
 * layout can only ever be the layout its generator knows about. A template is
 * the escape hatch: an HTML document written by the operator with the full run
 * of tables, VML, media queries and MSO conditional comments.
 *
 * There are two kinds, because a list sends two emails worth designing:
 *
 *  - **`campaign`** is the newsletter shell. It has a `{{content}}` slot where
 *    the campaign body lands, and it carries the unsubscribe link.
 *  - **`confirmation`** is the double opt-in email (§5.4). It has no slot — it
 *    *is* the email, copy and all — and its one job is to get `{{confirm_url}}`
 *    clicked. It carries no unsubscribe link, because there is nothing to
 *    unsubscribe from until it is clicked.
 *
 * The guarantees are not negotiable in either:
 *
 *  - **Escaping stays at the edges.** Everything substituted into the template
 *    is escaped here; the template itself is operator-authored and passes
 *    through as written, minus what `sanitizeEmailHtml` removes.
 *  - **Merge placeholders survive.** In a campaign, `{{unsubscribe_url}}` and
 *    the subscriber attributes stay as SES placeholders so one frozen body
 *    serves every recipient (§7.1). A confirmation is a single `sendSimple`,
 *    so its caller resolves them before rendering.
 *  - **The chrome is guaranteed, not requested.** A campaign missing its
 *    unsubscribe link or postal address, or a confirmation missing its confirm
 *    link, gets the missing part appended. Nothing here is behind a flag.
 */

/* ------------------------------------------------------------------ */
/* placeholders                                                        */
/* ------------------------------------------------------------------ */

/**
 * Placeholders that mean something only inside a template.
 *
 * Everything else in `{{…}}` is an ordinary merge field, so these have to be
 * excluded wherever merge fields are scanned — otherwise the §6.6 gate reports
 * `content` as an unknown field and blocks every send.
 */
export const TEMPLATE_ONLY_PLACEHOLDERS = ['content', 'preheader', 'confirm_url'] as const;

export interface TemplatePlaceholderDoc {
  key: string;
  label: string;
  description: string;
}

function freezeAll(entries: TemplatePlaceholderDoc[]): readonly TemplatePlaceholderDoc[] {
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

const SHARED_PLACEHOLDERS: TemplatePlaceholderDoc[] = [
  {
    key: 'list_name',
    label: 'Newsletter name',
    description: 'The name of the list this email is sent from.',
  },
  {
    key: 'physical_address',
    label: 'Postal address',
    description: 'The list’s postal address. Appended automatically if you leave it out.',
  },
  {
    key: 'email',
    label: 'Recipient’s email address',
    description: 'The address this copy of the email was sent to.',
  },
];

/** Drives the reference list on the template page, per kind. */
export const TEMPLATE_PLACEHOLDERS: Record<
  TemplateKind,
  readonly TemplatePlaceholderDoc[]
> = Object.freeze({
  campaign: freezeAll([
    {
      key: 'content',
      label: 'Campaign body',
      description: 'Required. Where the campaign body is inserted.',
    },
    {
      key: 'preheader',
      label: 'Preheader',
      description: 'The campaign’s preheader, for the hidden inbox-preview line.',
    },
    { key: 'subject', label: 'Subject line', description: 'The campaign’s subject line.' },
    ...SHARED_PLACEHOLDERS,
    {
      key: 'unsubscribe_url',
      label: 'Unsubscribe link',
      description: 'Legally required. Appended automatically if you leave it out.',
    },
  ]),
  confirmation: freezeAll([
    {
      key: 'confirm_url',
      label: 'Confirmation link',
      description: 'Required. The link that confirms the subscription.',
    },
    {
      key: 'subject',
      label: 'Subject line',
      description: 'The subject this email is sent with.',
    },
    ...SHARED_PLACEHOLDERS,
  ]),
});

function placeholderPattern(name: string): RegExp {
  return new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'g');
}

const CONTENT_PATTERN = placeholderPattern('content');
const CONFIRM_URL_PATTERN = placeholderPattern('confirm_url');
const UNSUBSCRIBE_PATTERN = placeholderPattern('unsubscribe_url');

/** Whether a pattern matches, without leaving `lastIndex` set on a global regex. */
function matches(pattern: RegExp, html: string): boolean {
  const found = pattern.test(html);
  pattern.lastIndex = 0;
  return found;
}

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
/* the default templates                                               */
/* ------------------------------------------------------------------ */

/* Brand tokens. Spelled out rather than named in CSS: this is email. */
const CREAM = '#F9F3ED'; // page
const PAPER = '#FFFBF7'; // card
const BLUSH = '#EFC7B7'; // rules
const CARD_EDGE = '#F5D7C9'; // card border
const ROSE_500 = '#8B4447'; // button / brand
const ROSE_700 = '#5F2E31'; // headings
const INK = '#3A2C28'; // body
const INK_MUTED = '#6D5A54'; // secondary
const INK_FAINT = '#8A7570'; // sign-off

const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, 'Segoe UI', Arial, sans-serif";

/**
 * The head every default template shares.
 *
 * `x-apple-disable-message-reformatting` stops iOS resizing the text, and the
 * MSO-only style block is the one reliable way to keep Word off Times New
 * Roman. Both live in conditional or meta form because neither survives as CSS.
 */
function defaultHead(title: string, extraStyle = ''): string {
  return `<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<title>${title}</title>
<!--[if mso]>
  <style>
    body, table, td, p, a { font-family: Arial, sans-serif !important; }
  </style>
<![endif]-->${extraStyle}
</head>`;
}

/**
 * 600px is the safe maximum; Outlook's reading pane clips past it. The width is
 * held by an MSO-only table rather than by the card, because Word ignores
 * `max-width` — a fixed 600 would still be 600 on a phone and push the mail
 * sideways. Everywhere else the card is fluid and stops growing at 600.
 */
const MSO_WIDTH_OPEN = `<!--[if mso]>
            <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td>
          <![endif]-->`;
const MSO_WIDTH_CLOSE = `<!--[if mso]>
            </td></tr></table>
          <![endif]-->`;

const CARD_STYLE =
  `width:100%;max-width:600px;background-color:${PAPER};` +
  `border:1px solid ${CARD_EDGE};border-radius:14px;`;

/**
 * The wordmark at the top of the card.
 *
 * Text rather than an image, because a default that points at a logo URL nobody
 * has uploaded renders as a broken-image icon in every inbox. The commented
 * `<img>` is the two-line swap for operators who do have one.
 */
const WORDMARK = `<tr>
              <td align="center" style="padding:36px 32px 8px;">
                <!-- Swap for your logo:
                <img src="https://example.com/logo.png" width="200" height="75" alt="{{list_name}}"
                     style="display:block;width:200px;max-width:200px;height:auto;border:0;" />
                -->
                <div style="font-family:${SERIF};font-size:26px;line-height:32px;color:${ROSE_700};font-weight:bold;letter-spacing:0.3px;">
                  {{list_name}}
                </div>
                <div style="height:2px;width:46px;background-color:${BLUSH};margin:14px auto 0;font-size:0;line-height:0;">&nbsp;</div>
              </td>
            </tr>`;

/**
 * The campaign template a list starts from.
 *
 * The type scale lives in a `<style>` block and is inlined onto the elements
 * before sending, because Gmail drops `<style>` — which also means the operator
 * restyles the whole body by editing CSS here, rather than by fighting inline
 * styles the renderer wrote.
 */
export const DEFAULT_TEMPLATE_HTML = `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word">
${defaultHead(
  '{{subject}}',
  `
<style>
  /* Inlined onto the elements themselves before sending — Gmail drops <style>. */
  .sm-content h1, .sm-content h2, .sm-content h3, .sm-content h4 {
    margin: 0 0 12px;
    font-family: ${SERIF};
    color: ${ROSE_700};
    font-weight: bold;
    line-height: 1.3;
  }
  .sm-content h1 { font-size: 25px; }
  .sm-content h2 { font-size: 21px; }
  .sm-content h3 { font-size: 18px; }
  .sm-content h4 { font-size: 16px; }
  .sm-content p {
    margin: 0 0 16px;
    font-family: ${SANS};
    font-size: 16px;
    line-height: 26px;
    color: ${INK};
  }
  .sm-content ul, .sm-content ol {
    margin: 0 0 16px;
    padding-left: 22px;
    font-family: ${SANS};
    font-size: 16px;
    line-height: 26px;
    color: ${INK};
  }
  .sm-content li { margin: 0 0 6px; }
  .sm-content blockquote {
    margin: 0 0 16px;
    padding: 2px 0 2px 16px;
    border-left: 3px solid ${BLUSH};
    font-family: ${SERIF};
    font-style: italic;
    color: ${INK_MUTED};
  }
  .sm-content a { color: ${ROSE_500}; text-decoration: underline; }
  .sm-content img { max-width: 100%; height: auto; border: 0; }
  .sm-content hr { border: 0; border-top: 1px solid ${CARD_EDGE}; margin: 26px 0; }
  @media only screen and (max-width: 620px) {
    .sm-content { padding: 26px 22px !important; }
  }
</style>`,
)}
<body style="margin:0;padding:0;width:100% !important;background-color:${CREAM};-webkit-font-smoothing:antialiased;">
  <!-- Preheader: the grey line inboxes show beside the subject. -->
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">{{preheader}}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${CREAM};">
    <tr>
      <td align="center" style="padding:32px 16px;">
          ${MSO_WIDTH_OPEN}
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${CARD_STYLE}">
            ${WORDMARK}
            <tr>
              <td class="sm-content" style="padding:28px 40px 36px;">
{{content}}
              </td>
            </tr>
          </table>
          ${MSO_WIDTH_CLOSE}

          <!-- Sign-off outside the card -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
            <tr>
              <td align="center" style="padding:22px 24px 0;font-family:${SANS};font-size:12px;line-height:20px;color:${INK_FAINT};">
                {{list_name}}<br />
                {{physical_address}}<br />
                <a href="{{unsubscribe_url}}" style="color:${INK_FAINT};">Unsubscribe</a>
              </td>
            </tr>
          </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

/**
 * The confirmation template a list starts from (§5.4).
 *
 * Short, obviously transactional, and built around one call to action. The
 * button is bulletproof: a table cell with a background colour, so it survives
 * clients that drop CSS on anchors, with a VML shape behind it for Outlook,
 * which drops `border-radius` and padding.
 */
export const DEFAULT_CONFIRMATION_TEMPLATE_HTML = `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word">
${defaultHead('{{subject}}')}
<body style="margin:0;padding:0;width:100% !important;background-color:${CREAM};-webkit-font-smoothing:antialiased;">
  <!-- Preheader: the grey line inboxes show beside the subject. -->
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">
    One click confirms your subscription — nothing is sent until you do.
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${CREAM};">
    <tr>
      <td align="center" style="padding:32px 16px;">
          ${MSO_WIDTH_OPEN}
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${CARD_STYLE}">
            ${WORDMARK}

            <!-- Greeting -->
            <tr>
              <td style="padding:20px 40px 0;font-family:${SERIF};font-size:19px;line-height:30px;color:${ROSE_700};">
                Assalamu alaikum warahmatullahi wabarakatuhu,
              </td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding:18px 40px 0;font-family:${SANS};font-size:16px;line-height:26px;color:${INK};">
                Before we send you any email, we need you to confirm your subscription to
                {{list_name}}. Please do so by clicking the button below.
              </td>
            </tr>

            <!-- Bulletproof button -->
            <tr>
              <td align="center" style="padding:32px 40px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td align="center" bgcolor="${ROSE_500}" style="border-radius:999px;">
                      <!--[if mso]>
                        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
                          href="{{confirm_url}}" style="height:52px;v-text-anchor:middle;width:280px;" arcsize="50%"
                          stroke="f" fillcolor="${ROSE_500}">
                          <w:anchorlock/>
                          <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;letter-spacing:1px;">
                            CONFIRM SUBSCRIPTION
                          </center>
                        </v:roundrect>
                      <![endif]-->
                      <!--[if !mso]><!-- -->
                      <a href="{{confirm_url}}" style="display:inline-block;padding:15px 34px;font-family:${SANS};font-size:15px;font-weight:bold;letter-spacing:1px;color:#ffffff;text-decoration:none;border-radius:999px;background-color:${ROSE_500};">
                        CONFIRM SUBSCRIPTION
                      </a>
                      <!--<![endif]-->
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Fallback: some clients strip the button entirely. -->
            <tr>
              <td style="padding:0 40px;font-family:${SANS};font-size:13px;line-height:22px;color:${INK_MUTED};">
                If the button doesn’t work,
                <a href="{{confirm_url}}" style="color:${ROSE_500};">use this link instead</a>.
              </td>
            </tr>

            <tr>
              <td style="padding:28px 40px 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="border-top:1px solid ${CARD_EDGE};font-size:0;line-height:0;">&nbsp;</td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- The line that makes this a real double opt-in -->
            <tr>
              <td style="padding:20px 40px 36px;font-family:${SANS};font-size:14px;line-height:24px;color:${INK_MUTED};">
                If you didn’t subscribe to this list, ignore this email. We won’t subscribe you
                unless you tap or click the button above.
              </td>
            </tr>
          </table>
          ${MSO_WIDTH_CLOSE}

          <!-- Sign-off outside the card -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
            <tr>
              <td align="center" style="padding:22px 24px 0;font-family:${SANS};font-size:12px;line-height:20px;color:${INK_FAINT};">
                {{list_name}}<br />
                {{physical_address}}
              </td>
            </tr>
          </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

export function defaultTemplateHtml(kind: TemplateKind): string {
  return kind === 'confirmation' ? DEFAULT_CONFIRMATION_TEMPLATE_HTML : DEFAULT_TEMPLATE_HTML;
}

export function isTemplateKind(value: unknown): value is TemplateKind {
  return typeof value === 'string' && (TEMPLATE_KINDS as readonly string[]).includes(value);
}

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
export function validateTemplateHtml(
  input: unknown,
  kind: TemplateKind = 'campaign',
): TemplateValidation {
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

  // Each kind needs the one placeholder that makes it work, and must not use
  // the other kind's — a confirmation email has nothing to unsubscribe from
  // yet, and a campaign has no subscription left to confirm.
  if (kind === 'campaign') {
    if (!matches(CONTENT_PATTERN, input)) {
      errors.push('template must contain {{content}}, which is where the campaign body goes');
    }
    if (matches(CONFIRM_URL_PATTERN, input)) {
      errors.push('{{confirm_url}} belongs to the confirmation template, not this one');
    }
  } else {
    if (!matches(CONFIRM_URL_PATTERN, input)) {
      errors.push(
        'template must contain {{confirm_url}} — without it nobody can confirm their subscription',
      );
    }
    if (matches(UNSUBSCRIBE_PATTERN, input)) {
      errors.push(
        '{{unsubscribe_url}} does not belong in a confirmation email: there is nothing to unsubscribe from until it is clicked',
      );
    }
  }

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
  `margin:0 0 8px;font-family:${SANS};font-size:12px;` +
  `line-height:20px;color:${INK_FAINT};text-align:center;`;

/**
 * The parts of the chrome a template left out.
 *
 * Only the missing parts: a template that already carries its own unsubscribe
 * link gets no second one, and a template that carries everything gets nothing
 * at all. Appending unconditionally would punish the templates that got it
 * right.
 */
function chromeFooter(missing: { unsubscribe?: string; address?: string; confirm?: string }): string {
  const lines: string[] = [];
  if (missing.confirm) {
    lines.push(
      `<p style="${FOOTER_STYLE}">` +
        `<a href="${missing.confirm}" style="color:${ROSE_500};">Confirm your subscription</a>` +
        '</p>',
    );
  }
  if (missing.address) lines.push(`<p style="${FOOTER_STYLE}">${missing.address}</p>`);
  if (missing.unsubscribe) {
    lines.push(
      `<p style="${FOOTER_STYLE}">` +
        `<a href="${missing.unsubscribe}" style="color:${INK_FAINT};">Unsubscribe</a>` +
        '</p>',
    );
  }
  if (lines.length === 0) return '';
  return `\n<div style="padding:16px 12px;background-color:${CREAM};">${lines.join('')}</div>\n`;
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
  return matches(CONTENT_PATTERN, html);
}

/** The chrome an email carries regardless of what its template says. */
export interface TemplateChrome extends EmailChrome {
  /** Confirmation templates only: the resolved, per-subscriber confirm link. */
  confirmUrl?: string;
}

/**
 * Finishes one email document: the constant placeholders, the guaranteed
 * chrome, the open pixel, sanitizing, and CSS inlining.
 *
 * Called with a template that already has its body in place, with a
 * confirmation template, and directly with a body the operator pasted as a
 * whole HTML document — in that last case the paste *is* the email, and it
 * earns the same guarantees a template gets rather than a separate, weaker
 * path.
 *
 * The placeholders resolved here are the ones constant for the whole send: the
 * list name, the postal address, the preheader. For a campaign, everything
 * per-recipient is deliberately *not* resolved — `{{unsubscribe_url}}` becomes
 * whatever the caller's chrome says, which is the bare SES placeholder for a
 * real send and a signed URL for a preview.
 */
export async function renderEmailDocument(
  documentHtml: string,
  chrome: TemplateChrome,
  kind: TemplateKind = 'campaign',
): Promise<string> {
  const listName = typeof chrome.listName === 'string' ? chrome.listName.trim() : '';
  const address = typeof chrome.physicalAddress === 'string' ? chrome.physicalAddress : '';
  const preheader = typeof chrome.preheader === 'string' ? chrome.preheader.trim() : '';

  let html = documentHtml
    .replace(placeholderPattern('preheader'), () => escapeHtml(preheader))
    .replace(placeholderPattern('list_name'), () => escapeHtml(listName))
    .replace(placeholderPattern('physical_address'), () => addressHtml(address));

  const addressBlock = addressHtml(address);
  const missing: { unsubscribe?: string; address?: string; confirm?: string } = {};

  if (kind === 'confirmation') {
    // An empty confirm URL would render `href=""`, which is a dead button in a
    // live inbox. Fail closed instead: storage requires the placeholder, so
    // reaching this means the caller supplied no link at all.
    const confirmHref = escapeHtml(chrome.confirmUrl ?? '');
    if (confirmHref === '') {
      throw new TemplateRenderError('confirmation email has no confirmation URL');
    }
    html = html.replace(CONFIRM_URL_PATTERN, () => confirmHref);
    if (!html.includes(confirmHref)) missing.confirm = confirmHref;
  } else {
    const unsubscribeHref = escapeHtml(chrome.unsubscribePlaceholder || '{{unsubscribe_url}}');
    html = html.replace(UNSUBSCRIBE_PATTERN, () => unsubscribeHref);
    if (!html.includes(unsubscribeHref)) missing.unsubscribe = unsubscribeHref;
  }

  if (address.trim() !== '' && !html.includes(addressBlock)) missing.address = addressBlock;

  const footer = chromeFooter(missing);
  if (footer !== '') html = insertBeforeBodyClose(html, footer);

  if (chrome.openPixelUrl) html = insertBeforeBodyClose(html, openPixel(chrome.openPixelUrl));

  return inlineCss(sanitizeEmailHtml(html).html);
}

export interface ApplyTemplateInput {
  /** The operator's template document. */
  templateHtml: string;
  /** Already-escaped HTML for the `{{content}}` slot. */
  contentHtml: string;
  chrome: TemplateChrome;
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
  return renderEmailDocument(documentHtml, input.chrome, 'campaign');
}
