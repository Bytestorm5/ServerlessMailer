/**
 * Operator-authored HTML: tokenizer, sanitizer, and the collectors built on it.
 *
 * Two features need this. A **template** (§6.2a) is a full HTML document the
 * operator writes by hand, and a campaign body may be **pasted HTML** rather
 * than editor JSON. Neither goes through the closed node set that
 * `render/doc.ts` enforces, so the guarantees have to be re-established here.
 *
 * The stance is deliberately different from `render/doc.ts`. That module
 * *rejects* anything outside a closed set, because an unknown node means the
 * renderer has no template for it. This module *keeps* almost everything —
 * tables, VML, `<style>` blocks, MSO conditional comments, presentational
 * attributes — because that is the entire point of hand-authored email HTML,
 * and removes only what is actively dangerous:
 *
 *  - **Script and embedded content.** The preview iframe is sandboxed, so this
 *    is not the last line of defence, but a `<script>` that reaches a mailbox
 *    provider is a spam classification waiting to happen, and the frozen body
 *    is also served back into the admin origin by the campaign report.
 *  - **Event-handler attributes**, for the same reason, including the ones
 *    spelled `oNcLiCk` or padded with whitespace.
 *  - **Unsafe URL schemes**, tested against a whitespace-stripped probe because
 *    a mail client discards whitespace inside a URL attribute before following
 *    it — `java&#9;script:` is `javascript:` by the time it is clicked.
 *  - **`<base>` and `<meta http-equiv>`**, which silently rewrite or redirect
 *    every link in the document.
 *
 * Everything here is pure, synchronous, and never throws: it is called from the
 * preview path on every keystroke and from the freeze path on the way to
 * 19,000 recipients, and neither can afford a parser that dies on malformed
 * input. Merge placeholders pass through byte for byte — `{{ first_name |
 * default: "there" }}` has to survive into the frozen SES template intact, so
 * nothing here re-encodes text it did not have to touch.
 */

/* ------------------------------------------------------------------ */
/* tokenizer                                                           */
/* ------------------------------------------------------------------ */

export interface HtmlAttribute {
  name: string;
  /** `null` for a bare attribute (`hidden`), which is not the same as `""`. */
  value: string | null;
  /** The quote character the source used, so serialising is byte-stable. */
  quote: '"' | "'" | '';
}

export type HtmlToken =
  | { kind: 'text'; value: string }
  | { kind: 'comment'; value: string }
  | { kind: 'bogus'; value: string }
  | {
      kind: 'tag';
      name: string;
      closing: boolean;
      selfClosing: boolean;
      attributes: HtmlAttribute[];
    };

/**
 * Elements whose content is not markup. The tokenizer has to know about these
 * or `<style>a { content: "<b>" }</style>` re-opens the document as bold text.
 */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'textarea',
  'title',
]);

/** Elements that never have a closing tag, so they can never open a drop scope. */
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const WHITESPACE = /\s/;
/**
 * A tag name may carry a namespace prefix: Outlook's bulletproof buttons are
 * `<v:roundrect>` and `<o:p>`, and dropping them would break the one layout
 * trick every serious email template uses.
 */
const NAME_START = /[A-Za-z]/;
const NAME_CHAR = /[A-Za-z0-9:._-]/;

function readTagName(html: string, from: number): { name: string; next: number } {
  let p = from;
  while (p < html.length && NAME_CHAR.test(html[p])) p += 1;
  return { name: html.slice(from, p), next: p };
}

/**
 * Reads attributes from just after the tag name up to the closing `>`.
 *
 * Written as a scanner rather than a regular expression because an unquoted
 * value may contain almost anything, and because a quoted value may legitimately
 * contain `>` — a merge fallback (`title="{{ x | default: \"a > b\" }}"`) does
 * exactly that.
 */
function readAttributes(
  html: string,
  from: number,
): { attributes: HtmlAttribute[]; selfClosing: boolean; next: number } {
  const attributes: HtmlAttribute[] = [];
  let selfClosing = false;
  let p = from;

  while (p < html.length) {
    while (p < html.length && WHITESPACE.test(html[p])) p += 1;
    if (p >= html.length) break;

    if (html[p] === '>') {
      p += 1;
      break;
    }
    if (html[p] === '/' && html[p + 1] === '>') {
      selfClosing = true;
      p += 2;
      break;
    }
    // A stray `/` or `<` inside a tag: skip it rather than losing the rest.
    if (html[p] === '/' || html[p] === '<') {
      p += 1;
      continue;
    }

    const nameStart = p;
    while (p < html.length && !WHITESPACE.test(html[p]) && !'=/>'.includes(html[p])) p += 1;
    const name = html.slice(nameStart, p);
    if (name === '') {
      p += 1;
      continue;
    }

    const afterName = p;
    while (p < html.length && WHITESPACE.test(html[p])) p += 1;

    if (html[p] !== '=') {
      attributes.push({ name, value: null, quote: '' });
      p = afterName;
      continue;
    }

    p += 1;
    while (p < html.length && WHITESPACE.test(html[p])) p += 1;

    const quote = html[p];
    if (quote === '"' || quote === "'") {
      const end = html.indexOf(quote, p + 1);
      if (end === -1) {
        // Unterminated: take the rest of the document rather than resynchronising
        // somewhere arbitrary, and let the caller see a single broken tag.
        attributes.push({ name, value: html.slice(p + 1), quote });
        p = html.length;
        break;
      }
      attributes.push({ name, value: html.slice(p + 1, end), quote });
      p = end + 1;
      continue;
    }

    const valueStart = p;
    while (p < html.length && !WHITESPACE.test(html[p]) && html[p] !== '>') p += 1;
    attributes.push({ name, value: html.slice(valueStart, p), quote: '' });
  }

  return { attributes, selfClosing, next: p };
}

/** Position just past the `</name` that ends a raw-text element, or -1. */
function findRawTextEnd(html: string, name: string, from: number): number {
  const lower = html.toLowerCase();
  const needle = `</${name}`;
  let p = lower.indexOf(needle, from);
  while (p !== -1) {
    const after = lower[p + needle.length];
    // `</style>` ends a style element; `</styles>` does not.
    if (after === undefined || after === '>' || WHITESPACE.test(after) || after === '/') {
      return p;
    }
    p = lower.indexOf(needle, p + 1);
  }
  return -1;
}

/**
 * Splits HTML into tokens. Never throws, and always round-trips: joining
 * `serializeTokens(tokenize(html))` reproduces the input for well-formed markup
 * and something equivalent for the rest.
 */
export function tokenize(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  if (typeof html !== 'string' || html === '') return tokens;

  let cursor = 0;

  const pushText = (value: string) => {
    if (value === '') return;
    const last = tokens[tokens.length - 1];
    if (last && last.kind === 'text') last.value += value;
    else tokens.push({ kind: 'text', value });
  };

  while (cursor < html.length) {
    const open = html.indexOf('<', cursor);
    if (open === -1) {
      pushText(html.slice(cursor));
      break;
    }
    pushText(html.slice(cursor, open));

    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4);
      const stop = end === -1 ? html.length : end + 3;
      tokens.push({
        kind: 'comment',
        value: html.slice(open + 4, end === -1 ? html.length : end),
      });
      cursor = stop;
      continue;
    }

    if (html[open + 1] === '!' || html[open + 1] === '?') {
      // Doctype, CDATA, processing instruction. Kept verbatim: a template
      // without its doctype renders in quirks mode.
      const end = html.indexOf('>', open);
      const stop = end === -1 ? html.length : end + 1;
      tokens.push({ kind: 'bogus', value: html.slice(open, stop) });
      cursor = stop;
      continue;
    }

    const closing = html[open + 1] === '/';
    const nameStart = open + (closing ? 2 : 1);
    if (!NAME_START.test(html[nameStart] ?? '')) {
      // `a < b` in prose. Not a tag at all.
      pushText('<');
      cursor = open + 1;
      continue;
    }

    const { name, next } = readTagName(html, nameStart);
    const { attributes, selfClosing, next: afterAttrs } = readAttributes(html, next);
    const lowerName = name.toLowerCase();

    tokens.push({ kind: 'tag', name: lowerName, closing, selfClosing, attributes });
    cursor = afterAttrs;

    if (!closing && !selfClosing && RAW_TEXT_ELEMENTS.has(lowerName)) {
      const end = findRawTextEnd(html, lowerName, cursor);
      if (end === -1) {
        pushText(html.slice(cursor));
        cursor = html.length;
      } else {
        pushText(html.slice(cursor, end));
        cursor = end;
      }
    }
  }

  return tokens;
}

function serializeAttribute(attribute: HtmlAttribute): string {
  if (attribute.value === null) return ` ${attribute.name}`;
  if (attribute.quote === '') return ` ${attribute.name}="${attribute.value}"`;
  return ` ${attribute.name}=${attribute.quote}${attribute.value}${attribute.quote}`;
}

export function serializeTokens(tokens: HtmlToken[]): string {
  let out = '';
  for (const token of tokens) {
    switch (token.kind) {
      case 'text':
        out += token.value;
        break;
      case 'comment':
        out += `<!--${token.value}-->`;
        break;
      case 'bogus':
        out += token.value;
        break;
      case 'tag': {
        if (token.closing) {
          out += `</${token.name}>`;
          break;
        }
        out += `<${token.name}`;
        for (const attribute of token.attributes) out += serializeAttribute(attribute);
        out += token.selfClosing ? ' />' : '>';
        break;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* URL safety                                                          */
/* ------------------------------------------------------------------ */

/** Schemes a link, image or background may use. Everything else is a vector. */
const SAFE_SCHEME = /^(?:https?|mailto|tel|cid):/;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/;
/** Inline images are the one `data:` payload worth keeping. */
const SAFE_DATA_URL = /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,/;

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Attributes whose value is a URL and therefore a scheme-injection point. */
const URL_ATTRIBUTES: ReadonlySet<string> = new Set([
  'href',
  'src',
  'srcset',
  'action',
  'formaction',
  'background',
  'poster',
  'cite',
  'data',
  'longdesc',
  'ping',
  'xlink:href',
]);

/**
 * True when `value` is safe to leave in a URL attribute.
 *
 * A merge placeholder is accepted as-is: `{{unsubscribe_url}}` is not a URL yet
 * and rejecting it would strip the unsubscribe link out of every template.
 */
export function isSafeAttributeUrl(value: string): boolean {
  const trimmed = value.replace(CONTROL_CHARACTERS, '').trim();
  if (trimmed === '') return true;
  if (trimmed.startsWith('{{')) return true;

  const probe = trimmed.replace(/\s+/g, '').toLowerCase();
  if (SAFE_DATA_URL.test(probe)) return true;
  if (SAFE_SCHEME.test(probe)) return true;
  // Schemeless: a relative path, a fragment, or `//host`. Harmless here; the
  // pre-send gate is what insists a body's links be absolute.
  return !ANY_SCHEME.test(probe);
}

/* ------------------------------------------------------------------ */
/* sanitizer                                                           */
/* ------------------------------------------------------------------ */

/**
 * Dropped along with everything inside them.
 *
 * `form` and its controls are here not because they execute anything but
 * because a form in an email is the shape of a phishing message: every major
 * mailbox provider strips or warns on one, and shipping them costs sender
 * reputation for a control that will never work.
 */
const DROP_WITH_CONTENT: ReadonlySet<string> = new Set([
  'script',
  'noscript',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'select',
  'option',
  'optgroup',
  'textarea',
  'template',
  'svg',
  'math',
]);

/** Dropped as tags; they carry no content of their own. */
const DROP_TAG_ONLY: ReadonlySet<string> = new Set(['base', 'link']);

/** Style declarations that execute, and the one at-rule that fetches. */
const DANGEROUS_CSS =
  /(?:expression\s*\(|behaviou?r\s*:|-moz-binding|javascript\s*:|vbscript\s*:|@import)/gi;

const EVENT_HANDLER = /^on/i;

export interface SanitizeResult {
  html: string;
  /**
   * What was removed, deduplicated and human-readable, so the editor can say
   * "your `<script>` was dropped" rather than silently changing the output.
   */
  removed: string[];
}

function cleanStyleText(value: string, removed: Set<string>, label: string): string {
  if (!DANGEROUS_CSS.test(value)) {
    DANGEROUS_CSS.lastIndex = 0;
    return value;
  }
  DANGEROUS_CSS.lastIndex = 0;
  removed.add(label);
  return value.replace(DANGEROUS_CSS, '/* removed */');
}

function sanitizeAttributes(
  token: Extract<HtmlToken, { kind: 'tag' }>,
  removed: Set<string>,
): HtmlAttribute[] {
  const kept: HtmlAttribute[] = [];

  for (const attribute of token.attributes) {
    // Whitespace and case are both legal inside a tag, so normalise before
    // matching: `< img  OnErRoR = alert(1) >` is a live handler.
    const name = attribute.name.trim().toLowerCase();

    if (EVENT_HANDLER.test(name) && name.length > 2) {
      removed.add(`event handler ${name}`);
      continue;
    }
    if (name === 'srcdoc' || name === 'formtarget') {
      removed.add(`attribute ${name}`);
      continue;
    }
    if (token.name === 'meta' && name === 'http-equiv') {
      removed.add('meta http-equiv');
      continue;
    }
    if (attribute.value !== null && URL_ATTRIBUTES.has(name)) {
      if (!isSafeAttributeUrl(attribute.value)) {
        removed.add(`unsafe URL in ${name}`);
        continue;
      }
    }
    if (name === 'style' && attribute.value !== null) {
      kept.push({
        ...attribute,
        name,
        value: cleanStyleText(attribute.value, removed, 'style declaration'),
      });
      continue;
    }

    kept.push({ ...attribute, name });
  }

  return kept;
}

/**
 * Removes active content from operator-authored HTML, keeping everything else
 * byte for byte.
 *
 * Never throws and never returns `undefined`: on input it cannot make sense of,
 * the worst case is that a malformed tag is re-serialised in a normalised form.
 */
export function sanitizeEmailHtml(html: string): SanitizeResult {
  if (typeof html !== 'string' || html === '') return { html: '', removed: [] };

  const tokens = tokenize(html);
  const out: HtmlToken[] = [];
  const removed = new Set<string>();

  /** Names of the currently open dropped elements, innermost last. */
  const dropStack: string[] = [];
  /** The element whose raw text is next in the stream, if it is a style block. */
  let pendingRawText: string | null = null;

  for (const token of tokens) {
    if (token.kind === 'tag') {
      const name = token.name;

      if (dropStack.length > 0) {
        if (!token.closing && !token.selfClosing && name === dropStack[dropStack.length - 1]) {
          dropStack.push(name);
        } else if (token.closing && name === dropStack[dropStack.length - 1]) {
          dropStack.pop();
        }
        continue;
      }

      if (DROP_WITH_CONTENT.has(name)) {
        removed.add(`<${name}>`);
        if (!token.closing && !token.selfClosing && !VOID_ELEMENTS.has(name)) {
          dropStack.push(name);
        }
        continue;
      }
      if (DROP_TAG_ONLY.has(name)) {
        removed.add(`<${name}>`);
        continue;
      }

      if (token.closing) {
        out.push(token);
        pendingRawText = null;
        continue;
      }

      const attributes = sanitizeAttributes(token, removed);
      // A `<meta>` reduced to nothing but its dropped http-equiv is a redirect
      // with its teeth pulled; keeping the empty tag would be noise.
      if (name === 'meta' && attributes.length === 0 && token.attributes.length > 0) continue;

      out.push({ ...token, attributes });
      pendingRawText = RAW_TEXT_ELEMENTS.has(name) ? name : null;
      continue;
    }

    if (dropStack.length > 0) continue;

    if (token.kind === 'text' && pendingRawText === 'style') {
      out.push({ kind: 'text', value: cleanStyleText(token.value, removed, '<style> rule') });
      pendingRawText = null;
      continue;
    }

    // Comments are kept: `<!--[if mso]>` is how a template survives Outlook,
    // and a downlevel-revealed conditional is ordinary markup to everyone else.
    out.push(token);
    if (token.kind !== 'text') pendingRawText = null;
  }

  return { html: serializeTokens(out), removed: [...removed].sort() };
}

/* ------------------------------------------------------------------ */
/* collectors                                                          */
/* ------------------------------------------------------------------ */

function attributeValue(
  token: Extract<HtmlToken, { kind: 'tag' }>,
  name: string,
): string | undefined {
  for (const attribute of token.attributes) {
    if (attribute.name.trim().toLowerCase() === name) return attribute.value ?? '';
  }
  return undefined;
}

/** True when the source is a whole document rather than a fragment. */
export function isFullHtmlDocument(html: string): boolean {
  if (typeof html !== 'string') return false;
  return /<\s*(?:!doctype\s+html|html)[\s>]/i.test(html);
}

/**
 * Every `<a href>` in document order, including the ones we would not track.
 *
 * Entity-decoded, because an href is written escaped in the source
 * (`?a=1&amp;b=2`) and everything downstream — signing, validating, following —
 * wants the URL a mail client would actually resolve.
 */
export function collectHtmlLinks(html: string): string[] {
  const found: string[] = [];
  for (const token of tokenize(html)) {
    if (token.kind !== 'tag' || token.closing || token.name !== 'a') continue;
    const href = attributeValue(token, 'href');
    if (href !== undefined && href.trim() !== '') found.push(decodeHtmlEntities(href.trim()));
  }
  return found;
}

/** Every `<img src>` in document order. */
export function collectHtmlImages(html: string): string[] {
  const found: string[] = [];
  for (const token of tokenize(html)) {
    if (token.kind !== 'tag' || token.closing || token.name !== 'img') continue;
    const src = attributeValue(token, 'src');
    if (src !== undefined && src.trim() !== '') found.push(src.trim());
  }
  return found;
}

/**
 * A link is trackable when it points somewhere the redirector can sign.
 *
 * `mailto:`, `tel:`, in-document fragments and merge placeholders are all left
 * alone — routing `{{unsubscribe_url}}` through the click redirector would
 * break one-click unsubscribe, which is the one link that must never move.
 */
function isTrackableHref(href: string): boolean {
  const probe = href.replace(CONTROL_CHARACTERS, '').trim().replace(/\s+/g, '').toLowerCase();
  return probe.startsWith('http://') || probe.startsWith('https://');
}

/**
 * Rewrites every trackable `<a href>` through `fn`, which receives the href and
 * its **position among trackable links** in document order.
 *
 * That index is an identity, not a count: click tracking signs
 * `{campaignId, linkIndex, url}`, so preview and freeze must agree on it. They
 * do, because both call this function on the same stored source string.
 */
export function mapHtmlLinks(html: string, fn: (href: string, index: number) => string): string {
  const tokens = tokenize(html);
  let index = 0;

  for (const token of tokens) {
    if (token.kind !== 'tag' || token.closing || token.name !== 'a') continue;
    for (const attribute of token.attributes) {
      if (attribute.name.trim().toLowerCase() !== 'href') continue;
      if (attribute.value === null || !isTrackableHref(attribute.value)) continue;
      // `fn` signs the URL, so it must receive the one a mail client would
      // follow — decoded — and the result goes back into an attribute, so it
      // has to be re-escaped.
      const href = decodeHtmlEntities(attribute.value.trim());
      attribute.value = escapeAttributeValue(fn(href, index));
      // The rewritten URL carries `?r=…`, so a bare unquoted attribute would
      // end at the first `&` in most parsers.
      if (attribute.quote === '') attribute.quote = '"';
      index += 1;
    }
  }

  return serializeTokens(tokens);
}

/** Minimal attribute escaping: enough to keep a value inside its quotes. */
function escapeAttributeValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ------------------------------------------------------------------ */
/* entity decoding and text extraction                                 */
/* ------------------------------------------------------------------ */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  // Decoded to an ordinary space: the plain-text part has no use for a
  // non-breaking one, and a stray U+00A0 reads as mojibake in a terminal.
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  laquo: '«',
  raquo: '»',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  deg: '°',
  pound: '£',
  euro: '€',
  times: '×',
};

/**
 * Latin-1 letters, as `name=character` pairs.
 *
 * Written compactly rather than as sixty object entries because none of them
 * needs a comment, and they are here for one reason: an export from a design
 * tool writes `caf&eacute;`, and a plain-text part reading "caf&eacute;" is
 * mojibake in every text-only client.
 */
const LATIN1_ENTITIES =
  'agrave=à,aacute=á,acirc=â,atilde=ã,auml=ä,aring=å,aelig=æ,ccedil=ç,' +
  'egrave=è,eacute=é,ecirc=ê,euml=ë,igrave=ì,iacute=í,icirc=î,iuml=ï,' +
  'ntilde=ñ,ograve=ò,oacute=ó,ocirc=ô,otilde=õ,ouml=ö,oslash=ø,' +
  'ugrave=ù,uacute=ú,ucirc=û,uuml=ü,yacute=ý,yuml=ÿ,szlig=ß,' +
  'Agrave=À,Aacute=Á,Acirc=Â,Atilde=Ã,Auml=Ä,Aring=Å,AElig=Æ,Ccedil=Ç,' +
  'Egrave=È,Eacute=É,Ecirc=Ê,Euml=Ë,Igrave=Ì,Iacute=Í,Icirc=Î,Iuml=Ï,' +
  'Ntilde=Ñ,Ograve=Ò,Oacute=Ó,Ocirc=Ô,Otilde=Õ,Ouml=Ö,Oslash=Ø,' +
  'Ugrave=Ù,Uacute=Ú,Ucirc=Û,Uuml=Ü,Yacute=Ý';

for (const pair of LATIN1_ENTITIES.split(',')) {
  const [name, character] = pair.split('=');
  NAMED_ENTITIES[name] = character;
}

const ENTITY = /&(#[Xx][0-9A-Fa-f]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g;

/** Decodes the entities an operator actually types. Unknown ones are left alone. */
export function decodeHtmlEntities(value: string): string {
  return value.replace(ENTITY, (match, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    // Case-sensitive first: `&Auml;` is Ä and `&auml;` is ä. The lower-cased
    // retry is for the handful people shout — `&AMP;`, `&NBSP;`.
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/** Characters that look like text but are not (§6.6 image-only check). */
const INVISIBLE_CHARACTERS = /[\u200B-\u200D\u2060\uFEFF]/g;

/** The readable text of an HTML fragment, with markup and invisibles removed. */
export function htmlTextContent(html: string): string {
  let out = '';
  let skipping = false;

  for (const token of tokenize(html)) {
    if (token.kind === 'tag') {
      if (RAW_TEXT_ELEMENTS.has(token.name) || DROP_WITH_CONTENT.has(token.name)) {
        skipping = !token.closing && !token.selfClosing;
      }
      continue;
    }
    // A comment is not text — including a downlevel-hidden MSO block, whose
    // contents are markup for exactly one client.
    if (token.kind !== 'text' || skipping) continue;
    out += token.value;
  }

  return decodeHtmlEntities(out)
    .replace(INVISIBLE_CHARACTERS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** No readable text and no images: there is nothing to send. */
export function isEmptyHtml(html: string): boolean {
  return htmlTextContent(html) === '' && collectHtmlImages(html).length === 0;
}

/** Images with no text alongside them — a spam signal the §6.6 gate blocks. */
export function isImageOnlyHtml(html: string): boolean {
  return collectHtmlImages(html).length > 0 && htmlTextContent(html) === '';
}
