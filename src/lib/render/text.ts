/**
 * The `multipart/alternative` plain-text part (spec §6.2).
 *
 * "A plain-text alternative is auto-generated from the source and sent as
 * `multipart/alternative`. This is not optional; HTML-only sends are a
 * deliverability penalty."
 *
 * Two properties matter more than beauty here:
 *
 *  - **Never empty for a non-empty document.** An empty text part is worse than
 *    no text part: it is a blank email for every recipient reading in a
 *    text-only client, and a spam signal for the rest.
 *  - **No information lost.** A link that renders as bare anchor text has
 *    silently deleted the URL, which for a newsletter is the entire payload —
 *    so links render as `text (url)`.
 *
 * The output is plain text, not markdown: nothing is escaped, because there is
 * no renderer downstream to escape it for. Merge-field placeholders pass
 * through untouched so the same text can be frozen as an SES template (§7.1).
 */

import type { EditorDoc, EditorNode } from '@/lib/types';
import { MAX_DOC_DEPTH } from '@/lib/render/doc';

/** Wide enough to read as a divider, narrow enough for a 40-column client. */
const HORIZONTAL_RULE = '-'.repeat(32);
const MIN_UNDERLINE = 3;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function childrenOf(node: unknown): unknown[] {
  if (!isPlainObject(node)) return [];
  return Array.isArray(node.content) ? node.content : [];
}

function attrsOf(node: unknown): Record<string, unknown> {
  if (!isPlainObject(node)) return {};
  return isPlainObject(node.attrs) ? node.attrs : {};
}

function typeOf(node: unknown): string {
  if (!isPlainObject(node) || typeof node.type !== 'string') return '';
  return node.type;
}

function textOf(node: unknown): string {
  if (!isPlainObject(node) || typeof node.text !== 'string') return '';
  return node.text;
}

/** The href of the link mark on a text node, if it has one. */
function inlineLinkHref(node: unknown): string | undefined {
  if (!isPlainObject(node) || node.type !== 'text') return undefined;
  if (!Array.isArray(node.marks)) return undefined;
  for (const mark of node.marks) {
    if (!isPlainObject(mark) || mark.type !== 'link') continue;
    const href = attrsOf(mark).href;
    if (typeof href === 'string' && href !== '') return href;
  }
  return undefined;
}

const LIST_TYPES = new Set(['bulletList', 'orderedList']);

/* ------------------------------------------------------------------ */
/* inline                                                              */
/* ------------------------------------------------------------------ */

/**
 * Renders inline children.
 *
 * Adjacent runs sharing one link are merged so that a link whose middle word is
 * bold does not render its URL twice — Tiptap splits such a link into several
 * text nodes carrying the same mark.
 */
function renderInline(nodes: unknown[], depth: number): string {
  if (depth > MAX_DOC_DEPTH) return '';

  let out = '';
  let index = 0;

  while (index < nodes.length) {
    const node = nodes[index];
    const href = inlineLinkHref(node);

    if (href !== undefined) {
      let text = textOf(node);
      let next = index + 1;
      while (next < nodes.length && inlineLinkHref(nodes[next]) === href) {
        text += textOf(nodes[next]);
        next += 1;
      }
      // Bold and italic carry no meaning in plain text, so they are dropped
      // rather than approximated with punctuation.
      out += text.trim() === href ? text : `${text} (${href})`;
      index = next;
      continue;
    }

    const type = typeOf(node);
    if (type === 'text') out += textOf(node);
    else if (type === 'hardBreak') out += '\n';
    else if (type === 'image') out += renderImage(node);
    else out += renderInline(childrenOf(node), depth + 1);

    index += 1;
  }

  return out;
}

function renderImage(node: unknown): string {
  const attrs = attrsOf(node);
  const alt = typeof attrs.alt === 'string' ? attrs.alt.trim() : '';
  const src = typeof attrs.src === 'string' ? attrs.src.trim() : '';
  const label = alt === '' ? '[Image]' : `[Image: ${alt}]`;
  return src === '' ? label : `${label} (${src})`;
}

/* ------------------------------------------------------------------ */
/* blocks                                                              */
/* ------------------------------------------------------------------ */

/** Renders one block, or `null` when it has nothing to contribute. */
function renderBlock(node: unknown, depth: number): string | null {
  if (depth > MAX_DOC_DEPTH || !isPlainObject(node)) return null;

  const type = typeOf(node);

  switch (type) {
    case 'paragraph': {
      const text = trimLineEnds(renderInline(childrenOf(node), depth + 1));
      return text.trim() === '' ? null : text;
    }
    case 'heading': {
      const text = trimLineEnds(renderInline(childrenOf(node), depth + 1));
      if (text.trim() === '') return null;
      const level = attrsOf(node).level;
      const character = level === 1 ? '=' : '-';
      const width = Math.max(MIN_UNDERLINE, ...text.split('\n').map((line) => line.length));
      return `${text}\n${character.repeat(width)}`;
    }
    case 'horizontalRule':
      return HORIZONTAL_RULE;
    case 'image':
      return renderImage(node);
    case 'blockquote': {
      const inner = renderBlocks(childrenOf(node), depth + 1, false);
      if (inner === '') return null;
      return inner
        .split('\n')
        .map((line) => (line === '' ? '>' : `> ${line}`))
        .join('\n');
    }
    case 'bulletList':
    case 'orderedList':
      return renderList(node, type === 'orderedList', depth);
    case 'text':
    case 'hardBreak': {
      // Inline content where a block was expected: keep the text rather than
      // lose it.
      const text = trimLineEnds(renderInline([node], depth + 1));
      return text.trim() === '' ? null : text;
    }
    default: {
      // Unknown node (a document that dodged validation): render whatever text
      // it contains instead of silently dropping it.
      const inner = renderBlocks(childrenOf(node), depth + 1, false);
      return inner === '' ? null : inner;
    }
  }
}

/**
 * Joins sibling blocks.
 *
 * Blocks are separated by a blank line, except a list following its own list
 * item's paragraph, which hangs directly underneath it.
 */
function renderBlocks(nodes: unknown[], depth: number, insideListItem: boolean): string {
  if (depth > MAX_DOC_DEPTH) return '';

  let out = '';
  let first = true;

  for (const node of nodes) {
    const rendered = renderBlock(node, depth);
    if (rendered === null) continue;

    if (!first) {
      const tight = insideListItem && LIST_TYPES.has(typeOf(node));
      out += tight ? '\n' : '\n\n';
    }
    out += rendered;
    first = false;
  }

  return out;
}

function renderList(node: unknown, ordered: boolean, depth: number): string | null {
  const items = childrenOf(node);
  if (items.length === 0) return null;

  const startAttr = attrsOf(node).start;
  const start =
    ordered && typeof startAttr === 'number' && Number.isInteger(startAttr) ? startAttr : 1;

  const lines: string[] = [];
  items.forEach((item, index) => {
    const marker = ordered ? `${start + index}. ` : '- ';
    const body = renderBlocks(childrenOf(item), depth + 1, true);
    const indent = ' '.repeat(marker.length);
    const rendered = body
      .split('\n')
      .map((line, lineIndex) => (lineIndex === 0 ? `${marker}${line}` : `${indent}${line}`))
      .join('\n');
    lines.push(rendered);
  });

  return lines.join('\n');
}

function trimLineEnds(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Renders a document as the plain-text alternative.
 *
 * Returns `''` only for a genuinely empty document; any document with text, a
 * link, an image or a rule produces something readable.
 */
export function docToPlainText(doc: EditorDoc): string {
  const rendered = renderBlocks(childrenOf(doc as unknown as EditorNode), 1, false);

  return rendered
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
