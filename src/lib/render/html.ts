import { logger } from '@/lib/logging';
import type { EditorDoc, EditorMark, EditorNode } from '@/lib/types';

/**
 * MJML email rendering (spec §6.2).
 *
 * Table-based email HTML is a solved problem and MJML solves it; nothing here
 * hand-authors a `<table>`. What this module *is* responsible for is the two
 * things MJML will not do for us:
 *
 *  1. **Escaping.** `mj-text`, `mj-preview` and `mj-title` are MJML "ending
 *     tags" — their content is handed to the HTML output verbatim. Every piece
 *     of user text and every attribute value is therefore escaped here, before
 *     it enters the MJML source. A heading containing `<script>` must arrive in
 *     the inbox as inert text, not as markup.
 *  2. **Merge placeholders.** The frozen body doubles as an SES template, so
 *     `{{first_name}}` has to survive MJML *and* its CSS inliner byte for byte.
 *     Escaping never touches braces, and nothing here URL-encodes an href, so
 *     the placeholders pass through untouched.
 *
 * The physical postal address and an unsubscribe link are rendered into the
 * footer of every email unconditionally. Both are legally required (§6.6), so
 * neither is behind a caller-supplied flag.
 */

export interface EmailChrome {
  preheader?: string;
  physicalAddress: string;
  listName: string;
  /** e.g. `'{{unsubscribe_url}}'`, or a resolved URL for preview / test sends. */
  unsubscribePlaceholder: string;
  openPixelUrl?: string;
}

/** Used when a caller supplies nothing usable — an email must never ship without one. */
const DEFAULT_UNSUBSCRIBE_PLACEHOLDER = '{{unsubscribe_url}}';

/**
 * C0 and C1 control characters, minus tab/newline/carriage-return which are
 * legitimate whitespace. Stripped from every string so a NUL or a BEL cannot
 * ride along into the delivered HTML — or be used to split a URL scheme.
 */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Schemes a link or image may use. Everything else is a script vector. */
const SAFE_SCHEME = /^(?:https?|mailto):/;
/** Any scheme at all, used to tell "unknown scheme" from "relative URL". */
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/;

const HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;
const DEFAULT_HEADING_LEVEL = 2;

/**
 * Inlined at render time (§6.2) — Gmail strips `<style>` blocks, so anything
 * that matters has to end up on the element. Element selectors are used rather
 * than classes because MJML puts `css-class` on the wrapper cell, not on the
 * `<h2>` or `<a>` inside it.
 */
const INLINE_STYLES = `
    h1, h2, h3, h4, h5, h6 { margin: 0 0 12px; line-height: 1.25; color: #111111; font-weight: 700; }
    h1 { font-size: 28px; }
    h2 { font-size: 22px; }
    h3 { font-size: 18px; }
    h4, h5, h6 { font-size: 16px; }
    p { margin: 0 0 16px; }
    ul, ol { margin: 0 0 16px; padding-left: 22px; }
    li { margin: 0 0 6px; }
    blockquote { margin: 0 0 16px; padding: 4px 0 4px 16px; border-left: 3px solid #d4d4d8; color: #52525b; font-style: italic; }
    a { color: #1d4ed8; text-decoration: underline; }
    .sm-footer-text { font-size: 12px; line-height: 1.5; color: #6b7280; }
`.trim();

/* ------------------------------------------------------------- primitives */

function stripControl(value: string): string {
  return value.replace(CONTROL_CHARACTERS, '');
}

/**
 * Escapes all five HTML-significant characters. Used for text *and* attribute
 * values — an attribute escaper that skips `'` is a breakout waiting for a
 * single-quoted attribute to appear.
 */
function escapeHtml(value: string): string {
  return stripControl(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stringAttr(node: EditorNode, name: string): string {
  const value = node.attrs?.[name];
  return typeof value === 'string' ? value : '';
}

/**
 * Returns a URL safe to place in an `href` or `src`, or `null` when it must be
 * rejected.
 *
 * Mail clients and browsers discard whitespace inside a URL attribute, so
 * `java&#9;script:alert(1)` is `javascript:alert(1)` by the time it is clicked.
 * The scheme is therefore tested against a whitespace-stripped, lower-cased
 * probe rather than against the raw string.
 */
function safeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  const value = stripControl(raw).trim();
  if (value === '') return null;

  // Our own SES placeholder — `{{unsubscribe_url}}` is not a URL yet, and
  // encoding or rejecting it would break every send.
  if (value.startsWith('{{')) return value;

  const probe = value.replace(/\s+/g, '').toLowerCase();
  if (SAFE_SCHEME.test(probe)) return value;
  if (ANY_SCHEME.test(probe)) {
    logger.warn('render.html: rejected unsafe URL scheme in campaign body', {
      scheme: probe.slice(0, probe.indexOf(':') + 1),
    });
    return null;
  }

  // Schemeless: a relative path or a fragment. Harmless here; the pre-send
  // gate (§6.6) is what insists links be absolute.
  return value;
}

function anchor(href: string, inner: string): string {
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
}

function headingTag(node: EditorNode): string {
  const level = node.attrs?.level;
  if (typeof level === 'number' && Number.isInteger(level) && level >= 1 && level <= 6) {
    return HEADING_TAGS[level - 1];
  }
  return HEADING_TAGS[DEFAULT_HEADING_LEVEL - 1];
}

/* ------------------------------------------------------------ inline nodes */

function applyMarks(inner: string, marks: EditorMark[] | undefined): string {
  if (!Array.isArray(marks) || marks.length === 0) return inner;

  let out = inner;
  // Applied in a fixed order rather than in array order, so the same document
  // always renders to the same bytes regardless of how the editor stored it.
  if (marks.some((mark) => mark?.type === 'italic')) out = `<em>${out}</em>`;
  if (marks.some((mark) => mark?.type === 'bold')) out = `<strong>${out}</strong>`;

  const linkMark = marks.find((mark) => mark?.type === 'link');
  if (linkMark) out = anchor(safeUrl(linkMark.attrs?.href) ?? '#', out);

  // Any other mark type is dropped. The node set is closed (§6.1) and an
  // unknown mark is either a bug or an injection attempt.
  return out;
}

function imageTag(node: EditorNode): string {
  const src = safeUrl(node.attrs?.src);
  if (!src) return '';
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(stringAttr(node, 'alt'))}" />`;
}

function renderInline(nodes: EditorNode[] | undefined): string {
  if (!Array.isArray(nodes)) return '';
  return nodes.map(renderInlineNode).join('');
}

function renderInlineNode(node: EditorNode): string {
  if (!node || typeof node !== 'object') return '';

  switch (node.type) {
    case 'text':
      return applyMarks(escapeHtml(typeof node.text === 'string' ? node.text : ''), node.marks);
    case 'hardBreak':
      return '<br />';
    case 'image':
      return imageTag(node);
    default:
      // Unknown type: keep the words, never the tag.
      return renderInline(node.content);
  }
}

/* ------------------------------------------------- block nodes as plain HTML */

/** Blocks rendered as ordinary HTML, for use *inside* an `<mj-text>`. */
function renderRichBlocks(nodes: EditorNode[] | undefined): string {
  if (!Array.isArray(nodes)) return '';
  return nodes.map(renderRichBlock).join('');
}

function renderRichBlock(node: EditorNode): string {
  if (!node || typeof node !== 'object') return '';

  switch (node.type) {
    case 'paragraph': {
      const inner = renderInline(node.content);
      return inner ? `<p>${inner}</p>` : '';
    }
    case 'heading': {
      const tag = headingTag(node);
      return `<${tag}>${renderInline(node.content)}</${tag}>`;
    }
    case 'bulletList':
      return renderList(node, 'ul');
    case 'orderedList':
      return renderList(node, 'ol');
    case 'blockquote': {
      const inner = renderRichBlocks(node.content);
      return `<blockquote>${inner}</blockquote>`;
    }
    case 'horizontalRule':
      return '<hr />';
    case 'text':
    case 'hardBreak':
    case 'image':
      return renderInlineNode(node);
    default:
      return renderRichBlocks(node.content);
  }
}

function renderList(node: EditorNode, tag: 'ul' | 'ol'): string {
  const items = (Array.isArray(node.content) ? node.content : [])
    .map((item) => `<li>${renderListItem(item)}</li>`)
    .join('');
  return items ? `<${tag}>${items}</${tag}>` : '';
}

function renderListItem(item: EditorNode): string {
  if (!item || typeof item !== 'object') return '';
  if (item.type !== 'listItem') return renderRichBlock(item);

  // A list item's own paragraphs are unwrapped: `<p>` inside `<li>` picks up
  // the paragraph bottom margin and reads as a gap in most clients.
  return (Array.isArray(item.content) ? item.content : [])
    .map((child) =>
      child?.type === 'paragraph' ? renderInline(child.content) : renderRichBlock(child),
    )
    .join('');
}

/* ------------------------------------------------------- top-level MJML body */

function textBlock(html: string): string {
  return `<mj-text css-class="sm-text">${html}</mj-text>`;
}

function renderTopLevel(node: EditorNode): string {
  if (!node || typeof node !== 'object') return '';

  switch (node.type) {
    case 'horizontalRule':
      return '<mj-divider border-width="1px" border-color="#e5e5e5" padding="12px 25px" />';
    case 'image': {
      const src = safeUrl(node.attrs?.src);
      if (!src) return '';
      return (
        `<mj-image src="${escapeHtml(src)}"` +
        ` alt="${escapeHtml(stringAttr(node, 'alt'))}" padding="8px 25px" />`
      );
    }
    case 'paragraph': {
      const inner = renderInline(node.content);
      // A deliberately blank paragraph is spacing, and spacing is content in an
      // email. Keep it, as a spacer rather than an empty text block.
      if (!inner.trim()) return '<mj-spacer height="16px" />';
      return textBlock(`<p>${inner}</p>`);
    }
    default: {
      const html = renderRichBlock(node);
      return html ? textBlock(html) : '';
    }
  }
}

function renderBody(doc: EditorDoc | undefined): string {
  const nodes = Array.isArray(doc?.content) ? doc.content : [];
  return nodes
    .map(renderTopLevel)
    .filter((chunk) => chunk !== '')
    .join('\n          ');
}

/* --------------------------------------------------------------- the chrome */

function addressHtml(address: string): string {
  return escapeHtml(address)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .join('<br />');
}

function footerSection(chrome: EmailChrome, unsubscribeUrl: string): string {
  const listName = typeof chrome.listName === 'string' ? chrome.listName.trim() : '';
  const address =
    typeof chrome.physicalAddress === 'string' ? addressHtml(chrome.physicalAddress) : '';

  const lines = [
    listName ? `<p>${escapeHtml(listName)}</p>` : '',
    address ? `<p>${address}</p>` : '',
    `<p>${anchor(unsubscribeUrl, 'Unsubscribe')}</p>`,
  ]
    .filter((line) => line !== '')
    .join('');

  return [
    '<mj-section padding="0 0 24px">',
    '        <mj-column>',
    '          <mj-divider border-width="1px" border-color="#e5e5e5" padding="12px 25px" />',
    `          <mj-text css-class="sm-footer-text">${lines}</mj-text>`,
    '        </mj-column>',
    '      </mj-section>',
  ].join('\n');
}

/** A 1×1 tracking pixel (§13). `mj-image` would stretch it to the column width. */
function openPixel(url: string): string {
  return (
    `<mj-raw><img src="${escapeHtml(url)}" width="1" height="1" alt=""` +
    ' style="display:block;border:0;width:1px;height:1px;overflow:hidden;" /></mj-raw>'
  );
}

/* ------------------------------------------------------------------- public */

export function docToMjml(doc: EditorDoc, chrome: EmailChrome): string {
  const preheader = typeof chrome?.preheader === 'string' ? chrome.preheader.trim() : '';
  const listName = typeof chrome?.listName === 'string' ? chrome.listName.trim() : '';
  // Fail closed: an email with no unsubscribe link is illegal, so an empty or
  // rejected placeholder falls back to the standard one rather than to nothing.
  const unsubscribeUrl =
    safeUrl(chrome?.unsubscribePlaceholder) ?? DEFAULT_UNSUBSCRIBE_PLACEHOLDER;
  const pixelUrl = safeUrl(chrome?.openPixelUrl);

  const body = renderBody(doc);

  const head = [
    listName ? `<mj-title>${escapeHtml(listName)}</mj-title>` : '',
    // Renders as hidden preview text at the very top of the body — the line
    // the inbox shows next to the subject.
    preheader ? `<mj-preview>${escapeHtml(preheader)}</mj-preview>` : '',
    '<mj-attributes>',
    '      <mj-all font-family="Helvetica, Arial, sans-serif" />',
    '      <mj-text font-size="16px" line-height="1.6" color="#1a1a1a" padding="8px 25px" />',
    '    </mj-attributes>',
    `<mj-style inline="inline">\n${INLINE_STYLES}\n    </mj-style>`,
  ]
    .filter((line) => line !== '')
    .join('\n    ');

  const bodySection = body
    ? [
        '<mj-section background-color="#ffffff" padding="24px 0 8px">',
        '        <mj-column>',
        `          ${body}`,
        '        </mj-column>',
        '      </mj-section>',
      ].join('\n')
    : '';

  return [
    '<mjml>',
    '  <mj-head>',
    `    ${head}`,
    '  </mj-head>',
    '  <mj-body background-color="#f4f4f5">',
    ...(bodySection ? [`      ${bodySection}`] : []),
    `      ${footerSection(chrome, unsubscribeUrl)}`,
    ...(pixelUrl ? [`      ${openPixel(pixelUrl)}`] : []),
    '  </mj-body>',
    '</mjml>',
  ].join('\n');
}

interface MjmlError {
  line?: number;
  message?: string;
  tagName?: string;
  formattedMessage?: string;
}

function describeError(error: MjmlError): string {
  const message = error.message ?? error.formattedMessage ?? 'unknown MJML error';
  const where = [
    typeof error.line === 'number' ? `line ${error.line}` : '',
    error.tagName ? `<${error.tagName}>` : '',
  ]
    .filter((part) => part !== '')
    .join(' ');
  return where ? `${where}: ${message}` : message;
}

/**
 * Runs MJML. Never throws: a source MJML cannot parse at all is reported the
 * same way a validation problem is, so callers have exactly one error path.
 */
export async function renderMjml(mjml: string): Promise<{ html: string; errors: string[] }> {
  const mjml2html = (await import('mjml')).default;

  try {
    const result = await mjml2html(mjml, { validationLevel: 'soft' });
    const errors: MjmlError[] = Array.isArray(result?.errors) ? result.errors : [];
    return {
      html: typeof result?.html === 'string' ? result.html : '',
      errors: errors.map(describeError),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('render.html: MJML failed to render', { error: message });
    return { html: '', errors: [message] };
  }
}

export async function docToEmailHtml(doc: EditorDoc, chrome: EmailChrome): Promise<string> {
  const source = docToMjml(doc, chrome);
  const { html, errors } = await renderMjml(source);

  if (errors.length > 0) {
    // Fail closed (§1.2). A body that half-rendered is not a body worth
    // freezing onto a campaign and sending to 19,000 people.
    throw new Error(`MJML rendering failed: ${errors.join('; ')}`);
  }

  return html;
}
