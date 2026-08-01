/**
 * The editor document model (spec §6.1).
 *
 * The campaign body's source of truth is Tiptap-compatible document JSON, and
 * the node set it may use is deliberately **closed**: headings, bold/italic,
 * links, lists, blockquotes, images and horizontal rules. "That is the complete
 * list. Resist additions."
 *
 * Three reasons this module is strict rather than forgiving:
 *
 *  - A document that reaches the HTML renderer carrying a node type the
 *    renderer has no template for is, at best, silently dropped content in an
 *    email that has already been sent to 19,000 people.
 *  - A `link` mark with a `javascript:` href is an XSS vector in webmail, and a
 *    document arrives here from a JSON request body, a CSV-ish import or a
 *    restored version — not only from the editor UI.
 *  - The §6.6 pre-send gate is a hard block with no override, so it needs a
 *    complete list of what is wrong with a body, not the first problem found.
 *
 * Everything here is pure and synchronous: no I/O, no clock, no logging (a
 * document body can contain an email address, and §12 says addresses never
 * reach the logs).
 */

import type { EditorDoc, EditorMark, EditorNode } from '@/lib/types';

/** The closed node set of §6.1. */
export const ALLOWED_NODE_TYPES = [
  'doc',
  'paragraph',
  'text',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'image',
  'horizontalRule',
  'hardBreak',
] as const;

/** The closed mark set of §6.1. */
export const ALLOWED_MARK_TYPES = ['bold', 'italic', 'link'] as const;

/**
 * Nesting beyond this is not something a human wrote. The cap keeps a hostile
 * (or merely corrupt) document from turning every recursive walk in the render
 * pipeline into a stack overflow — which, in a serverless function, is an
 * un-actionable 500 rather than a validation error the writer can fix.
 */
export const MAX_DOC_DEPTH = 50;

const NODE_TYPE_SET: ReadonlySet<string> = new Set<string>(ALLOWED_NODE_TYPES);
const MARK_TYPE_SET: ReadonlySet<string> = new Set<string>(ALLOWED_MARK_TYPES);
const INLINE_TYPES: ReadonlySet<string> = new Set(['text', 'hardBreak']);
const LIST_TYPES: ReadonlySet<string> = new Set(['bulletList', 'orderedList']);

/** C0/C1 control characters, which have no business inside a URL. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/;
/** Invisible characters that look like text but are not (§6.6 image-only check). */
const INVISIBLE_CHARACTERS = /[\u200B-\u200D\u2060\uFEFF]/g;

const MIN_HEADING_LEVEL = 1;
const MAX_HEADING_LEVEL = 6;

/* ------------------------------------------------------------------ */
/* small shared helpers                                                */
/* ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Children of a node, tolerating malformed input (collectors never throw). */
function childrenOf(node: unknown): unknown[] {
  if (!isPlainObject(node)) return [];
  const content = node.content;
  return Array.isArray(content) ? content : [];
}

function attrsOf(node: unknown): Record<string, unknown> {
  if (!isPlainObject(node)) return {};
  return isPlainObject(node.attrs) ? node.attrs : {};
}

function nodeType(node: unknown): string | undefined {
  if (!isPlainObject(node)) return undefined;
  return typeof node.type === 'string' ? node.type : undefined;
}

/**
 * An absolute `http(s)` URL, safe to place in an `href` or `src`.
 *
 * Rejects `javascript:` and `data:` (XSS in webmail), relative and
 * protocol-relative URLs (they simply break in an email client, §6.6), and
 * embedded credentials (`https://www.paypal.com@evil.test` displays as one host
 * and resolves to another).
 */
export function isSafeUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') return false;
  // The WHATWG parser silently strips tabs and newlines, so `java\nscript:`
  // would otherwise parse as a perfectly ordinary `javascript:` URL.
  if (CONTROL_CHARACTERS.test(value)) return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  return url.hostname !== '';
}

/** The href a link mark carries, or undefined when it has none. */
function linkHref(mark: unknown): string | undefined {
  if (!isPlainObject(mark) || mark.type !== 'link') return undefined;
  const href = attrsOf(mark).href;
  return typeof href === 'string' && href !== '' ? href : undefined;
}

/* ------------------------------------------------------------------ */
/* validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Validates untrusted document JSON against the closed node set.
 *
 * Returns **every** problem it finds rather than stopping at the first: this
 * drives an editor-facing error list and the §6.6 gate, and a gate that reveals
 * one problem per attempt is a gate people learn to route around.
 */
export function validateEditorDoc(
  input: unknown,
): { ok: true; doc: EditorDoc } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (!isPlainObject(input)) {
    return { ok: false, errors: ['expected a document object'] };
  }
  if (input.type !== 'doc') {
    const got = typeof input.type === 'string' ? `"${input.type}"` : typeof input.type;
    return { ok: false, errors: [`root node must have type "doc" (got ${got})`] };
  }
  if (!Array.isArray(input.content)) {
    return { ok: false, errors: ['doc: content must be an array'] };
  }

  input.content.forEach((child, index) => {
    validateNode(child, `content[${index}]`, 1, 'doc', errors);
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, doc: input as unknown as EditorDoc };
}

function validateNode(
  node: unknown,
  path: string,
  depth: number,
  parentType: string,
  errors: string[],
): void {
  if (depth > MAX_DOC_DEPTH) {
    errors.push(`${path}: document nesting is too deep (maximum ${MAX_DOC_DEPTH} levels)`);
    return;
  }
  if (!isPlainObject(node)) {
    errors.push(`${path}: node must be an object`);
    return;
  }

  const type = node.type;
  if (typeof type !== 'string' || type === '') {
    errors.push(`${path}: node type must be a string`);
    return;
  }
  if (!NODE_TYPE_SET.has(type)) {
    errors.push(`${path}: unknown node type "${type}"`);
    return;
  }
  if (type === 'doc') {
    errors.push(`${path}: a nested "doc" node is not allowed`);
    return;
  }

  /* placement -------------------------------------------------------- */

  if (INLINE_TYPES.has(type) && parentType === 'doc') {
    errors.push(`${path}: "${type}" is not allowed as a direct child of "doc"`);
  }
  if (type === 'listItem' && !LIST_TYPES.has(parentType)) {
    errors.push(`${path}: "listItem" is only allowed inside a list`);
  }
  if (LIST_TYPES.has(parentType) && type !== 'listItem') {
    errors.push(`${path}: "${type}" is not allowed inside "${parentType}" (expected listItem)`);
  }

  /* text ------------------------------------------------------------- */

  if (type === 'text') {
    if (typeof node.text !== 'string' || node.text === '') {
      errors.push(`${path}: a text node must have a non-empty text string`);
    }
    if (node.content !== undefined) {
      errors.push(`${path}: a text node must not have content`);
    }
  } else if (node.text !== undefined) {
    errors.push(`${path}: node type "${type}" must not have a text property`);
  }

  /* attrs ------------------------------------------------------------ */

  if (node.attrs !== undefined && !isPlainObject(node.attrs)) {
    errors.push(`${path}: attrs must be an object`);
  }

  if (type === 'heading') {
    const level = attrsOf(node).level;
    if (
      typeof level !== 'number' ||
      !Number.isInteger(level) ||
      level < MIN_HEADING_LEVEL ||
      level > MAX_HEADING_LEVEL
    ) {
      errors.push(
        `${path}: heading level must be an integer between ${MIN_HEADING_LEVEL} and ${MAX_HEADING_LEVEL} (got ${JSON.stringify(level)})`,
      );
    }
  }

  if (type === 'image') {
    const src = attrsOf(node).src;
    if (typeof src !== 'string' || src === '') {
      errors.push(`${path}: image is missing a src`);
    } else if (!isSafeUrl(src)) {
      errors.push(`${path}: image src must be an absolute http(s) URL (got ${JSON.stringify(src)})`);
    }
  }

  /* marks ------------------------------------------------------------ */

  if (node.marks !== undefined) {
    if (!Array.isArray(node.marks)) {
      errors.push(`${path}: marks must be an array`);
    } else {
      node.marks.forEach((mark, index) => {
        validateMark(mark, `${path}.marks[${index}]`, errors);
      });
    }
  }

  /* children --------------------------------------------------------- */

  if (node.content !== undefined && type !== 'text') {
    if (!Array.isArray(node.content)) {
      errors.push(`${path}: content must be an array`);
    } else {
      node.content.forEach((child, index) => {
        validateNode(child, `${path}.content[${index}]`, depth + 1, type, errors);
      });
    }
  }
}

function validateMark(mark: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(mark)) {
    errors.push(`${path}: mark must be an object`);
    return;
  }
  const type = mark.type;
  if (typeof type !== 'string' || type === '') {
    errors.push(`${path}: mark type must be a string`);
    return;
  }
  if (!MARK_TYPE_SET.has(type)) {
    errors.push(`${path}: unknown mark type "${type}"`);
    return;
  }
  if (mark.attrs !== undefined && !isPlainObject(mark.attrs)) {
    errors.push(`${path}: mark attrs must be an object`);
    return;
  }
  if (type !== 'link') return;

  const href = isPlainObject(mark.attrs) ? mark.attrs.href : undefined;
  if (typeof href !== 'string' || href === '') {
    errors.push(`${path}: link mark is missing an href`);
    return;
  }
  if (!isSafeUrl(href)) {
    errors.push(`${path}: link mark href must be an absolute http(s) URL (got ${JSON.stringify(href)})`);
  }
}

/* ------------------------------------------------------------------ */
/* collectors                                                          */
/* ------------------------------------------------------------------ */

/**
 * The visible text of a document, one line per block, in document order.
 *
 * Deliberately not a rendering: images, rules and formatting contribute
 * nothing. It answers "is there anything to read here?", which is what the
 * §6.6 body checks need.
 */
export function collectText(doc: EditorDoc): string {
  const lines: string[] = [];
  for (const child of childrenOf(doc)) collectTextInto(child, 1, lines);
  return lines.filter((line) => line !== '').join('\n');
}

function collectTextInto(node: unknown, depth: number, lines: string[]): void {
  if (depth > MAX_DOC_DEPTH || !isPlainObject(node)) return;

  const type = nodeType(node);
  if (type === 'text') {
    if (typeof node.text === 'string' && node.text !== '') {
      if (lines.length === 0) lines.push(node.text);
      else lines[lines.length - 1] += node.text;
    }
    return;
  }
  if (type === 'hardBreak') {
    lines.push('');
    return;
  }
  // Images and rules are structure, not text. Alt text is image metadata: it
  // must not rescue an image-only body from the §6.6 check.
  if (type === 'image' || type === 'horizontalRule') return;

  // Any other node is a block: its content starts on a new line.
  if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
  for (const child of childrenOf(node)) collectTextInto(child, depth + 1, lines);
}

/**
 * Every link href in document order.
 *
 * The index is a **position**, not an identity: the same URL appearing twice
 * yields two entries. Click tracking signs `{campaignId, linkIndex, url}`, so
 * this ordering is what attributes a click to the right link — it must match
 * `mapLinks` exactly, which is why both walk the tree the same way.
 */
export function collectLinks(doc: EditorDoc): { href: string; index: number }[] {
  const found: { href: string; index: number }[] = [];
  for (const child of childrenOf(doc)) collectLinksInto(child, 1, found);
  return found;
}

function collectLinksInto(
  node: unknown,
  depth: number,
  found: { href: string; index: number }[],
): void {
  if (depth > MAX_DOC_DEPTH || !isPlainObject(node)) return;

  const marks = node.marks;
  if (Array.isArray(marks)) {
    for (const mark of marks) {
      const href = linkHref(mark);
      if (href !== undefined) found.push({ href, index: found.length });
    }
  }
  for (const child of childrenOf(node)) collectLinksInto(child, depth + 1, found);
}

/** Every image source in document order. Images without a usable src are skipped. */
export function collectImages(doc: EditorDoc): string[] {
  const found: string[] = [];
  for (const child of childrenOf(doc)) collectImagesInto(child, 1, found);
  return found;
}

function collectImagesInto(node: unknown, depth: number, found: string[]): void {
  if (depth > MAX_DOC_DEPTH || !isPlainObject(node)) return;

  if (nodeType(node) === 'image') {
    const src = attrsOf(node).src;
    if (typeof src === 'string' && src !== '') found.push(src);
    return;
  }
  for (const child of childrenOf(node)) collectImagesInto(child, depth + 1, found);
}

/** Text with invisible characters removed — a zero-width space is not content. */
function meaningfulText(doc: EditorDoc): string {
  return collectText(doc).replace(INVISIBLE_CHARACTERS, '').trim();
}

/** No readable text and no images: there is nothing to send. */
export function isEmptyDoc(doc: EditorDoc): boolean {
  return meaningfulText(doc) === '' && collectImages(doc).length === 0;
}

/**
 * Images with no meaningful text alongside them.
 *
 * §6.6 hard-blocks this: an image-only body is a classic spam signal, and it is
 * unreadable for the substantial minority of recipients whose client blocks
 * remote images by default.
 */
export function isImageOnly(doc: EditorDoc): boolean {
  return collectImages(doc).length > 0 && meaningfulText(doc) === '';
}

/* ------------------------------------------------------------------ */
/* link rewriting                                                      */
/* ------------------------------------------------------------------ */

/**
 * Returns a **new** document with every link href replaced by
 * `fn(href, index)`, where `index` counts links in document order.
 *
 * The input is never mutated: the campaign's `bodySource` is the immutable
 * source of truth, and click-tracking rewrites happen at freeze time on a copy
 * (§7.1). A shared sub-object here would rewrite the stored draft as a side
 * effect of rendering a preview.
 */
export function mapLinks(
  doc: EditorDoc,
  fn: (href: string, index: number) => string,
): EditorDoc {
  const counter = { next: 0 };
  return {
    ...doc,
    type: 'doc',
    content: childrenOf(doc).map((child) => mapNode(child, fn, counter, 1)),
  };
}

function mapNode(
  node: unknown,
  fn: (href: string, index: number) => string,
  counter: { next: number },
  depth: number,
): EditorNode {
  if (!isPlainObject(node)) return node as EditorNode;

  const clone: Record<string, unknown> = { ...node };

  if (isPlainObject(node.attrs)) clone.attrs = cloneValue(node.attrs, depth);

  if (Array.isArray(node.marks)) {
    clone.marks = node.marks.map((mark) => mapMark(mark, fn, counter, depth));
  }

  if (Array.isArray(node.content)) {
    clone.content =
      depth >= MAX_DOC_DEPTH
        ? []
        : node.content.map((child) => mapNode(child, fn, counter, depth + 1));
  }

  return clone as unknown as EditorNode;
}

function mapMark(
  mark: unknown,
  fn: (href: string, index: number) => string,
  counter: { next: number },
  depth: number,
): EditorMark {
  if (!isPlainObject(mark)) return mark as EditorMark;

  const clone: Record<string, unknown> = { ...mark };
  if (isPlainObject(mark.attrs)) clone.attrs = cloneValue(mark.attrs, depth);

  const href = linkHref(mark);
  if (href !== undefined) {
    const attrs = isPlainObject(clone.attrs) ? clone.attrs : {};
    attrs.href = fn(href, counter.next);
    counter.next += 1;
    clone.attrs = attrs;
  }
  return clone as unknown as EditorMark;
}

/** Deep copy of plain attribute data, depth-capped like every other walk here. */
function cloneValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DOC_DEPTH) return undefined;
  if (Array.isArray(value)) return value.map((entry) => cloneValue(entry, depth + 1));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = cloneValue(entry, depth + 1);
    return out;
  }
  return value;
}
