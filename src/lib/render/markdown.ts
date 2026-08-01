/**
 * Markdown interop for the editor document model (spec §6.1, §4.4).
 *
 * Markdown is **not** the internal source of truth — the campaign stores editor
 * JSON, and HTML is a render target. This module exists so the content is
 * portable: an export that produces something a human can read, edit elsewhere
 * and paste back is the same promise §4.4 makes about the subscriber list —
 * "this application is never a lock-in trap".
 *
 * That promise only holds if the conversion is lossless in both directions for
 * everything the closed node set can express, so both halves live in one file
 * and are written against each other:
 *
 *   docToMarkdown → markdownToDoc  must be the identity for a canonical doc
 *   markdownToDoc → docToMarkdown  must be the identity for canonical markdown
 *
 * Deliberately hand-rolled rather than pulling in a markdown library:
 *
 *  - A general-purpose parser accepts far more than the closed node set — raw
 *    HTML, code blocks, tables, footnotes — and every one of those would arrive
 *    at a renderer that has no template for it. The node set is the contract;
 *    the parser has to be the same shape as the contract.
 *  - `_underscore_` emphasis is **not** supported, on purpose. Merge fields are
 *    snake_case (`{{ first_name }} … {{ last_name }}`), and every off-the-shelf
 *    parser turns the text between two of them into an italic run. That is a
 *    corrupted body in an immutable frozen render.
 *  - Link and image destinations are checked with the same `isSafeUrl` the
 *    document validator uses, so imported markdown can never introduce a
 *    `javascript:` href (§12).
 */

import type { EditorDoc, EditorMark, EditorNode } from '@/lib/types';
import { MAX_DOC_DEPTH, isSafeUrl } from '@/lib/render/doc';

/**
 * Maximum markdown block nesting. Each level costs two levels of document depth
 * (list → listItem), so this stays comfortably inside `MAX_DOC_DEPTH`: a parser
 * that can emit a document the validator then rejects is a parser that produces
 * un-sendable campaigns.
 */
const MAX_NESTING = 16;

/** Canonical mark order, so a round trip is byte-stable. */
const MARK_RANK: Record<string, number> = { bold: 0, italic: 1, link: 2 };

const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const HORIZONTAL_RULE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const BLOCKQUOTE = /^ {0,3}>[ \t]?/;
const BULLET_ITEM = /^( *)([-+*])[ \t]+(.*)$/;
const ORDERED_ITEM = /^( *)(\d{1,9})([.)])[ \t]+(.*)$/;
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

/* ------------------------------------------------------------------ */
/* shared helpers                                                      */
/* ------------------------------------------------------------------ */

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

function sortMarks(marks: EditorMark[]): EditorMark[] {
  return [...marks].sort((a, b) => (MARK_RANK[a.type] ?? 99) - (MARK_RANK[b.type] ?? 99));
}

/** Merges adjacent text nodes carrying the same marks, as ProseMirror does. */
function mergeAdjacentText(nodes: EditorNode[]): EditorNode[] {
  const out: EditorNode[] = [];
  for (const node of nodes) {
    const previous = out[out.length - 1];
    if (
      node.type === 'text' &&
      previous !== undefined &&
      previous.type === 'text' &&
      JSON.stringify(previous.marks ?? null) === JSON.stringify(node.marks ?? null)
    ) {
      out[out.length - 1] = { ...previous, text: `${previous.text ?? ''}${node.text ?? ''}` };
      continue;
    }
    out.push(node);
  }
  return out.filter((node) => node.type !== 'text' || (node.text ?? '') !== '');
}

/* ================================================================== */
/* doc → markdown                                                     */
/* ================================================================== */

/** Escapes the characters this module's own parser would otherwise consume. */
function escapeInline(text: string): string {
  return text.replace(/[\\*[\]]/g, (character) => `\\${character}`);
}

/**
 * Escapes a leading character that would turn a paragraph line into some other
 * block: `# heading`, `- bullet`, `> quote`, `1. item`, `---`.
 */
function escapeBlockStart(line: string): string {
  if (HORIZONTAL_RULE.test(line)) {
    const at = line.search(/\S/);
    return `${line.slice(0, at)}\\${line.slice(at)}`;
  }

  const ordered = /^( {0,3})(\d{1,9})([.)])([ \t]|$)/.exec(line);
  if (ordered) {
    const at = ordered[1].length + ordered[2].length;
    // `\1` is not an escape sequence, so the punctuation carries the backslash.
    return `${line.slice(0, at)}\\${line.slice(at)}`;
  }

  const other = /^( {0,3})(#{1,6}|[-+*]|>)([ \t]|$)/.exec(line);
  if (other) {
    const at = other[1].length;
    return `${line.slice(0, at)}\\${line.slice(at)}`;
  }

  return line;
}

/** Angle-bracket form when the destination contains anything ambiguous. */
function serializeDestination(href: string): string {
  if (/[\s()<>]/.test(href)) return `<${href.replace(/[<>]/g, (character) => `\\${character}`)}>`;
  return href;
}

interface InlineRun {
  text: string;
  bold: boolean;
  italic: boolean;
  href?: string;
}

function runOf(node: unknown): InlineRun {
  const marks = isPlainObject(node) && Array.isArray(node.marks) ? node.marks : [];
  let bold = false;
  let italic = false;
  let href: string | undefined;

  for (const mark of marks) {
    if (!isPlainObject(mark)) continue;
    if (mark.type === 'bold') bold = true;
    else if (mark.type === 'italic') italic = true;
    else if (mark.type === 'link') {
      const candidate = attrsOf(mark).href;
      // An unsafe destination is dropped rather than exported: markdown is a
      // portability format, not a laundering route for a `javascript:` href.
      if (isSafeUrl(candidate)) href = candidate;
    }
  }

  const text = isPlainObject(node) && typeof node.text === 'string' ? node.text : '';
  return { text, bold, italic, href };
}

function sameRun(a: InlineRun, b: InlineRun): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.href === b.href;
}

function emitRun(run: InlineRun): string {
  let out = escapeInline(run.text);
  if (out === '') return '';
  if (run.italic) out = `*${out}*`;
  if (run.bold) out = `**${out}**`;
  if (run.href !== undefined) out = `[${out}](${serializeDestination(run.href)})`;
  return out;
}

function serializeImage(node: unknown): string {
  const attrs = attrsOf(node);
  const alt = typeof attrs.alt === 'string' ? attrs.alt : '';
  const src = attrs.src;
  if (!isSafeUrl(src)) return escapeInline(alt);
  return `![${escapeInline(alt)}](${serializeDestination(src)})`;
}

function serializeInline(nodes: unknown[], depth: number): string {
  if (depth > MAX_DOC_DEPTH) return '';

  let out = '';
  let index = 0;

  while (index < nodes.length) {
    const node = nodes[index];
    const type = typeOf(node);

    if (type === 'text') {
      const run = runOf(node);
      let next = index + 1;
      while (next < nodes.length && typeOf(nodes[next]) === 'text' && sameRun(runOf(nodes[next]), run)) {
        run.text += runOf(nodes[next]).text;
        next += 1;
      }
      out += emitRun(run);
      index = next;
      continue;
    }

    if (type === 'hardBreak') out += '\\\n';
    else if (type === 'image') out += serializeImage(node);
    else out += serializeInline(childrenOf(node), depth + 1);

    index += 1;
  }

  return out;
}

function serializeParagraphText(nodes: unknown[], depth: number): string {
  return serializeInline(nodes, depth)
    .split('\n')
    .map((line) => escapeBlockStart(line))
    .join('\n');
}

function serializeBlock(node: unknown, depth: number): string | null {
  if (depth > MAX_DOC_DEPTH || !isPlainObject(node)) return null;

  const type = typeOf(node);

  switch (type) {
    case 'paragraph': {
      const text = serializeParagraphText(childrenOf(node), depth + 1);
      return text.trim() === '' ? null : text;
    }
    case 'heading': {
      const text = serializeInline(childrenOf(node), depth + 1);
      if (text.trim() === '') return null;
      const rawLevel = attrsOf(node).level;
      const level =
        typeof rawLevel === 'number' && Number.isInteger(rawLevel) && rawLevel >= 1 && rawLevel <= 6
          ? rawLevel
          : 2;
      return `${'#'.repeat(level)} ${text}`;
    }
    case 'horizontalRule':
      return '---';
    case 'image': {
      const rendered = serializeImage(node);
      return rendered === '' ? null : rendered;
    }
    case 'blockquote': {
      const inner = serializeBlocks(childrenOf(node), depth + 1, false);
      if (inner === '') return null;
      return inner
        .split('\n')
        .map((line) => (line === '' ? '>' : `> ${line}`))
        .join('\n');
    }
    case 'bulletList':
    case 'orderedList':
      return serializeList(node, type === 'orderedList', depth);
    case 'text':
    case 'hardBreak': {
      const text = serializeParagraphText([node], depth + 1);
      return text.trim() === '' ? null : text;
    }
    default: {
      const inner = serializeBlocks(childrenOf(node), depth + 1, false);
      return inner === '' ? null : inner;
    }
  }
}

function serializeList(node: unknown, ordered: boolean, depth: number): string | null {
  const items = childrenOf(node);
  if (items.length === 0) return null;

  const startAttr = attrsOf(node).start;
  const start =
    ordered && typeof startAttr === 'number' && Number.isInteger(startAttr) ? startAttr : 1;

  const rendered: string[] = [];
  items.forEach((item, index) => {
    const marker = ordered ? `${start + index}. ` : '- ';
    const indent = ' '.repeat(marker.length);
    const body = serializeBlocks(childrenOf(item), depth + 1, true);
    rendered.push(
      body
        .split('\n')
        .map((line, lineIndex) =>
          lineIndex === 0 ? `${marker}${line}` : line === '' ? '' : `${indent}${line}`,
        )
        .join('\n'),
    );
  });

  return rendered.join('\n');
}

function serializeBlocks(nodes: unknown[], depth: number, insideListItem: boolean): string {
  if (depth > MAX_DOC_DEPTH) return '';

  let out = '';
  let first = true;

  for (const node of nodes) {
    const rendered = serializeBlock(node, depth);
    if (rendered === null) continue;

    if (!first) {
      const type = typeOf(node);
      // A nested list hangs directly under its item; everything else gets the
      // blank line that separates markdown blocks.
      const tight = insideListItem && (type === 'bulletList' || type === 'orderedList');
      out += tight ? '\n' : '\n\n';
    }
    out += rendered;
    first = false;
  }

  return out;
}

/** Serialises a document to markdown. Empty paragraphs carry nothing and are dropped. */
export function docToMarkdown(doc: EditorDoc): string {
  return serializeBlocks(childrenOf(doc as unknown as EditorNode), 1, false)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ================================================================== */
/* markdown → doc                                                     */
/* ================================================================== */

interface LinkMatch {
  label: string;
  destination: string;
  end: number;
}

/** Reads `[label](destination)` starting at the `[`, honouring escapes and nesting. */
function matchLink(text: string, start: number): LinkMatch | null {
  if (text[start] !== '[') return null;

  let index = start + 1;
  let depth = 1;
  let label = '';
  while (index < text.length && depth > 0) {
    const character = text[index];
    if (character === '\\' && index + 1 < text.length) {
      label += character + text[index + 1];
      index += 2;
      continue;
    }
    if (character === '[') depth += 1;
    if (character === ']') {
      depth -= 1;
      if (depth === 0) break;
    }
    label += character;
    index += 1;
  }
  if (depth !== 0 || text[index] !== ']') return null;

  index += 1;
  if (text[index] !== '(') return null;
  index += 1;

  let destination = '';
  if (text[index] === '<') {
    index += 1;
    while (index < text.length && text[index] !== '>') {
      if (text[index] === '\\' && index + 1 < text.length) {
        destination += text[index + 1];
        index += 2;
        continue;
      }
      destination += text[index];
      index += 1;
    }
    if (text[index] !== '>') return null;
    index += 1;
  } else {
    let parens = 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '\\' && index + 1 < text.length) {
        destination += text[index + 1];
        index += 2;
        continue;
      }
      if (character === '(') parens += 1;
      if (character === ')') {
        parens -= 1;
        if (parens === 0) break;
      }
      destination += character;
      index += 1;
    }
    if (parens !== 0) return null;
  }

  if (text[index] !== ')') return null;
  return { label, destination: destination.trim(), end: index + 1 };
}

/** Index of the closing delimiter, skipping escaped characters. -1 when absent. */
function findClosing(text: string, from: number, delimiter: string): number {
  let index = from;
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2;
      continue;
    }
    if (text.startsWith(delimiter, index)) return index;
    index += 1;
  }
  return -1;
}

function applyMark(nodes: EditorNode[], mark: EditorMark): EditorNode[] {
  return nodes.map((node) => {
    if (node.type !== 'text') return node;
    return { ...node, marks: sortMarks([...(node.marks ?? []), mark]) };
  });
}

/** The visible text of parsed inline content, used for image alt text. */
function plainTextOf(nodes: EditorNode[]): string {
  return nodes.map((node) => (node.type === 'text' ? (node.text ?? '') : '')).join('');
}

function parseInline(text: string, depth: number): EditorNode[] {
  const out: EditorNode[] = [];
  let buffer = '';
  let index = 0;

  const flush = (): void => {
    if (buffer !== '') {
      out.push({ type: 'text', text: buffer });
      buffer = '';
    }
  };

  while (index < text.length) {
    const character = text[index];

    if (character === '\\' && index + 1 < text.length && ASCII_PUNCTUATION.test(text[index + 1])) {
      buffer += text[index + 1];
      index += 2;
      continue;
    }

    // Images are block level in this model; an inline one degrades to its alt
    // text rather than vanishing or becoming a link to the image file.
    if (character === '!' && text[index + 1] === '[' && depth < MAX_NESTING) {
      const match = matchLink(text, index + 1);
      if (match) {
        buffer += plainTextOf(parseInline(match.label, depth + 1));
        index = match.end;
        continue;
      }
    }

    if (character === '[' && depth < MAX_NESTING) {
      const match = matchLink(text, index);
      if (match) {
        flush();
        const inner = parseInline(match.label, depth + 1);
        const nodes = inner.length > 0 ? inner : [{ type: 'text', text: match.destination }];
        out.push(
          ...(isSafeUrl(match.destination)
            ? applyMark(nodes, { type: 'link', attrs: { href: match.destination } })
            : nodes),
        );
        index = match.end;
        continue;
      }
    }

    if (character === '*' && depth < MAX_NESTING) {
      let matched = false;
      for (const delimiter of ['***', '**', '*']) {
        if (!text.startsWith(delimiter, index)) continue;
        const from = index + delimiter.length;
        const close = findClosing(text, from, delimiter);
        // `close === from` would be an empty run: `**unclosed` must stay literal
        // rather than reading its own second asterisk as a closing delimiter.
        if (close <= from) continue;

        flush();
        let inner = parseInline(text.slice(from, close), depth + 1);
        if (delimiter !== '*') inner = applyMark(inner, { type: 'bold' });
        if (delimiter !== '**') inner = applyMark(inner, { type: 'italic' });
        out.push(...inner);
        index = close + delimiter.length;
        matched = true;
        break;
      }
      if (matched) continue;
    }

    buffer += character;
    index += 1;
  }

  flush();
  return mergeAdjacentText(out);
}

function indentOf(line: string): number {
  const match = /^ */.exec(line);
  return match ? match[0].length : 0;
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function isListMarker(line: string): boolean {
  if (HORIZONTAL_RULE.test(line)) return false;
  return BULLET_ITEM.test(line) || ORDERED_ITEM.test(line);
}

function isBlockStart(line: string): boolean {
  return (
    HORIZONTAL_RULE.test(line) ||
    ATX_HEADING.test(line) ||
    BLOCKQUOTE.test(line) ||
    isListMarker(line)
  );
}

/** A line that is nothing but an image, which is how images are stored. */
function matchImageLine(line: string): { alt: string; destination: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('![')) return null;
  const match = matchLink(trimmed, 1);
  if (!match || match.end !== trimmed.length) return null;
  return { alt: plainTextOf(parseInline(match.label, 0)), destination: match.destination };
}

function parseParagraph(lines: string[], depth: number): EditorNode[] {
  const content: EditorNode[] = [];

  lines.forEach((line, index) => {
    let text = line.trim();
    const last = index === lines.length - 1;
    let hardBreak = false;

    if (!last) {
      const trailing = /\\+$/.exec(text);
      // An odd run of backslashes ends in an unescaped one: a hard break.
      if (trailing && trailing[0].length % 2 === 1) {
        text = text.slice(0, -1);
        hardBreak = true;
      }
    }

    content.push(...parseInline(text, depth));
    if (!last) content.push(hardBreak ? { type: 'hardBreak' } : { type: 'text', text: ' ' });
  });

  const merged = mergeAdjacentText(content);
  return merged.length === 0 ? [] : [{ type: 'paragraph', content: merged }];
}

interface ListItemLines {
  ordered: boolean;
  number: number;
  lines: string[];
}

function parseListBlock(blockLines: string[], depth: number): EditorNode[] {
  const baseIndent = indentOf(blockLines[0]);
  const items: ListItemLines[] = [];

  for (const line of blockLines) {
    const bullet = BULLET_ITEM.exec(line);
    const ordered = ORDERED_ITEM.exec(line);
    const isMarker = !HORIZONTAL_RULE.test(line) && (bullet !== null || ordered !== null);

    if (isMarker && indentOf(line) === baseIndent) {
      items.push(
        ordered && !bullet
          ? { ordered: true, number: Number(ordered[2]), lines: [ordered[4]] }
          : { ordered: false, number: 0, lines: [bullet![3]] },
      );
      continue;
    }
    if (items.length === 0) continue;
    items[items.length - 1].lines.push(line);
  }

  /* Group consecutive items of the same kind into one list node. */
  const out: EditorNode[] = [];
  let run: ListItemLines[] = [];

  const flushRun = (): void => {
    if (run.length === 0) return;
    const ordered = run[0].ordered;
    const content = run.map((item) => ({
      type: 'listItem',
      content: parseItemBlocks(item.lines, depth),
    }));
    out.push(
      ordered
        ? { type: 'orderedList', attrs: { start: run[0].number }, content }
        : { type: 'bulletList', content },
    );
    run = [];
  };

  for (const item of items) {
    if (run.length > 0 && run[0].ordered !== item.ordered) flushRun();
    run.push(item);
  }
  flushRun();

  return out;
}

/** Dedents an item's continuation lines and parses them as blocks. */
function parseItemBlocks(lines: string[], depth: number): EditorNode[] {
  const [first, ...rest] = lines;
  const indents = rest.filter((line) => !isBlank(line)).map(indentOf);
  const dedent = indents.length > 0 ? Math.min(...indents) : 0;
  const normalised = [first, ...rest.map((line) => (isBlank(line) ? '' : line.slice(dedent)))];

  const blocks = parseBlocks(normalised, depth + 1);
  return blocks.length > 0 ? blocks : [{ type: 'paragraph', content: [] }];
}

function parseBlocks(lines: string[], depth: number): EditorNode[] {
  if (depth > MAX_NESTING) {
    // Deeper than anything a human writes. Keep the text, drop the structure,
    // and stay well inside the document depth the validator accepts.
    const text = lines.filter((line) => !isBlank(line)).join(' ').trim();
    return text === '' ? [] : [{ type: 'paragraph', content: parseInline(text, MAX_NESTING) }];
  }

  const out: EditorNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (isBlank(line)) {
      index += 1;
      continue;
    }

    if (HORIZONTAL_RULE.test(line)) {
      out.push({ type: 'horizontalRule' });
      index += 1;
      continue;
    }

    const heading = ATX_HEADING.exec(line);
    if (heading) {
      out.push({
        type: 'heading',
        attrs: { level: heading[1].length },
        content: parseInline(heading[2].trim(), depth),
      });
      index += 1;
      continue;
    }

    if (BLOCKQUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && BLOCKQUOTE.test(lines[index])) {
        quoted.push(lines[index].replace(BLOCKQUOTE, ''));
        index += 1;
      }
      out.push({ type: 'blockquote', content: parseBlocks(quoted, depth + 1) });
      continue;
    }

    if (isListMarker(line)) {
      const baseIndent = indentOf(line);
      const block: string[] = [];
      while (index < lines.length) {
        const current = lines[index];
        if (isBlank(current)) {
          // A blank line only stays inside the list when indented content
          // follows it — that is a second paragraph in the current item.
          let lookahead = index + 1;
          while (lookahead < lines.length && isBlank(lines[lookahead])) lookahead += 1;
          if (lookahead >= lines.length || indentOf(lines[lookahead]) <= baseIndent) break;
          block.push('');
          index += 1;
          continue;
        }
        const currentIndent = indentOf(current);
        if (currentIndent > baseIndent) {
          block.push(current);
          index += 1;
          continue;
        }
        if (currentIndent === baseIndent && isListMarker(current)) {
          block.push(current);
          index += 1;
          continue;
        }
        break;
      }
      out.push(...parseListBlock(block, depth));
      continue;
    }

    const image = matchImageLine(line);
    if (image) {
      index += 1;
      if (isSafeUrl(image.destination)) {
        out.push({ type: 'image', attrs: { src: image.destination, alt: image.alt } });
      } else if (image.alt !== '') {
        // Keep what the reader would have seen; drop the unusable destination.
        out.push({ type: 'paragraph', content: [{ type: 'text', text: image.alt }] });
      }
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && !isBlank(lines[index])) {
      if (paragraph.length > 0 && isBlockStart(lines[index])) break;
      paragraph.push(lines[index]);
      index += 1;
    }
    out.push(...parseParagraph(paragraph, depth));
  }

  return out;
}

/** Leading tabs become spaces so indentation comparisons are meaningful. */
function expandLeadingTabs(line: string): string {
  const match = /^[ \t]+/.exec(line);
  if (!match) return line;
  return match[0].replace(/\t/g, '    ') + line.slice(match[0].length);
}

/**
 * Parses markdown into an editor document.
 *
 * The result always sits inside the closed node set and always passes
 * `validateEditorDoc`: this is an import path for untrusted text, so anything
 * it cannot represent safely degrades to plain text rather than being carried
 * through as an unknown node or an unsafe URL.
 */
export function markdownToDoc(markdown: string): EditorDoc {
  const source = typeof markdown === 'string' ? markdown : '';
  const lines = source
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(expandLeadingTabs);

  return { type: 'doc', content: parseBlocks(lines, 1) };
}
