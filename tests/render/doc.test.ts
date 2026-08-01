import { describe, expect, it } from 'vitest';

import {
  ALLOWED_MARK_TYPES,
  ALLOWED_NODE_TYPES,
  collectImages,
  collectLinks,
  collectText,
  isEmptyDoc,
  isImageOnly,
  mapLinks,
  validateEditorDoc,
} from '@/lib/render/doc';
import { sampleDoc, validCampaignDoc } from '@tests/helpers/factories';
import type { EditorDoc, EditorMark, EditorNode } from '@/lib/types';

/* ------------------------------------------------------------------ */
/* builders                                                            */
/* ------------------------------------------------------------------ */

const t = (text: string, marks?: EditorMark[]): EditorNode =>
  marks ? { type: 'text', text, marks } : { type: 'text', text };
const p = (...content: EditorNode[]): EditorNode => ({ type: 'paragraph', content });
const h = (level: number, text: string): EditorNode => ({
  type: 'heading',
  attrs: { level },
  content: [t(text)],
});
const li = (...content: EditorNode[]): EditorNode => ({ type: 'listItem', content });
const ul = (...content: EditorNode[]): EditorNode => ({ type: 'bulletList', content });
const ol = (...content: EditorNode[]): EditorNode => ({ type: 'orderedList', content });
const quote = (...content: EditorNode[]): EditorNode => ({ type: 'blockquote', content });
const img = (src: string, alt = 'Chart'): EditorNode => ({ type: 'image', attrs: { src, alt } });
const linkMark = (href: string): EditorMark => ({ type: 'link', attrs: { href } });
const doc = (...content: EditorNode[]): EditorDoc => ({ type: 'doc', content });

/** Casts a deliberately malformed structure for the rejection cases. */
const bad = (value: unknown): EditorDoc => value as EditorDoc;

function errorsOf(input: unknown): string[] {
  const result = validateEditorDoc(input);
  if (result.ok) throw new Error('expected validation to fail');
  return result.errors;
}

function expectValid(input: unknown): EditorDoc {
  const result = validateEditorDoc(input);
  if (!result.ok) throw new Error(`expected valid, got: ${result.errors.join(' | ')}`);
  return result.doc;
}

/** Every allowed node type in one document. */
const everyNodeType: EditorDoc = doc(
  h(2, 'Heading'),
  p(t('Plain '), t('bold', [{ type: 'bold' }]), t(' and '), t('link', [linkMark('https://example.com/a')])),
  p(t('before'), { type: 'hardBreak' }, t('after')),
  ul(li(p(t('one'))), li(p(t('two')), ul(li(p(t('nested')))))),
  ol(li(p(t('first')))),
  quote(p(t('quoted'))),
  img('https://cdn.example.com/chart.png'),
  { type: 'horizontalRule' },
);

/* ------------------------------------------------------------------ */
/* the closed node set                                                 */
/* ------------------------------------------------------------------ */

describe('the allowed node and mark sets', () => {
  it('is exactly the §6.1 set — the list is closed', () => {
    expect([...ALLOWED_NODE_TYPES].sort()).toEqual(
      [
        'blockquote',
        'bulletList',
        'doc',
        'hardBreak',
        'heading',
        'horizontalRule',
        'image',
        'listItem',
        'orderedList',
        'paragraph',
        'text',
      ].sort(),
    );
    expect([...ALLOWED_MARK_TYPES].sort()).toEqual(['bold', 'italic', 'link'].sort());
  });

  it('excludes the node types the editor deliberately switches off', () => {
    for (const banned of ['codeBlock', 'code', 'table', 'strike', 'underline', 'script', 'iframe']) {
      expect(ALLOWED_NODE_TYPES).not.toContain(banned);
      expect(ALLOWED_MARK_TYPES).not.toContain(banned);
    }
  });
});

/* ------------------------------------------------------------------ */
/* validateEditorDoc — acceptance                                      */
/* ------------------------------------------------------------------ */

describe('validateEditorDoc — valid documents', () => {
  it('accepts the shared fixtures', () => {
    expect(validateEditorDoc(sampleDoc()).ok).toBe(true);
    expect(validateEditorDoc(validCampaignDoc()).ok).toBe(true);
  });

  it('accepts a document using every allowed node type', () => {
    expect(expectValid(everyNodeType)).toEqual(everyNodeType);
  });

  it('accepts an empty document and empty blocks', () => {
    expect(validateEditorDoc(doc()).ok).toBe(true);
    expect(validateEditorDoc(doc({ type: 'paragraph' })).ok).toBe(true);
    expect(validateEditorDoc(doc({ type: 'paragraph', content: [] })).ok).toBe(true);
  });

  it('accepts every allowed mark, including combined marks on one text node', () => {
    expect(
      validateEditorDoc(
        doc(p(t('x', [{ type: 'bold' }, { type: 'italic' }, linkMark('https://example.com')]))),
      ).ok,
    ).toBe(true);
  });

  it('accepts http as well as https link hrefs, with ports, queries and fragments', () => {
    for (const href of [
      'http://example.com',
      'https://example.com:8443/a/b?c=d#e',
      'https://sub.domain-a.co.uk/post-1',
    ]) {
      expect(validateEditorDoc(doc(p(t('x', [linkMark(href)])))).ok).toBe(true);
    }
  });

  it('accepts heading levels 1 through 6', () => {
    for (const level of [1, 2, 3, 4, 5, 6]) {
      expect(validateEditorDoc(doc(h(level, 'Title'))).ok).toBe(true);
    }
  });

  it('returns the document itself so callers get a typed value', () => {
    const input = sampleDoc();
    const result = validateEditorDoc(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.doc).toEqual(input);
  });
});

/* ------------------------------------------------------------------ */
/* validateEditorDoc — rejection                                       */
/* ------------------------------------------------------------------ */

describe('validateEditorDoc — malformed roots', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'doc'],
    ['a number', 42],
    ['a boolean', true],
    ['an array', [{ type: 'paragraph' }]],
    ['a JSON string of a doc', JSON.stringify(sampleDoc())],
  ])('rejects %s as a root', (_label, input) => {
    const errors = errorsOf(input);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toMatch(/document object/i);
  });

  it('rejects a non-doc root node', () => {
    expect(errorsOf({ type: 'paragraph', content: [] }).join(' ')).toContain('"doc"');
  });

  it('rejects a doc whose content is missing or not an array', () => {
    expect(errorsOf({ type: 'doc' }).join(' ')).toMatch(/content must be an array/);
    expect(errorsOf({ type: 'doc', content: 'nope' }).join(' ')).toMatch(/content must be an array/);
    expect(errorsOf({ type: 'doc', content: {} }).join(' ')).toMatch(/content must be an array/);
  });
});

describe('validateEditorDoc — unknown node types', () => {
  it('rejects a node type outside the closed set', () => {
    const errors = errorsOf(doc(bad({ type: 'codeBlock', content: [t('rm -rf /')] })));
    expect(errors.join(' ')).toContain('unknown node type "codeBlock"');
    expect(errors.join(' ')).toContain('content[0]');
  });

  it('rejects an unknown node nested deep inside allowed nodes — an unvalidated doc is an injection vector', () => {
    const errors = errorsOf(doc(quote(ul(li(bad({ type: 'iframe', attrs: { src: 'https://evil.test' } }))))));
    expect(errors.join(' ')).toContain('unknown node type "iframe"');
  });

  it('rejects a node without a string type', () => {
    expect(errorsOf(doc(bad({ content: [] }))).join(' ')).toMatch(/type/);
    expect(errorsOf(doc(bad({ type: 7 }))).join(' ')).toMatch(/type/);
    expect(errorsOf(doc(bad(null))).join(' ')).toMatch(/node must be an object|type/);
    expect(errorsOf(doc(bad('paragraph'))).join(' ')).toMatch(/node must be an object|type/);
  });

  it('rejects a non-array content property on a child node', () => {
    expect(errorsOf(doc(bad({ type: 'paragraph', content: 'text' }))).join(' ')).toMatch(
      /content must be an array/,
    );
  });
});

describe('validateEditorDoc — text nodes', () => {
  it('rejects a text node with no text', () => {
    expect(errorsOf(doc(p(bad({ type: 'text' })))).join(' ')).toMatch(/text node/);
  });

  it('rejects a text node whose text is empty or not a string', () => {
    expect(errorsOf(doc(p(bad({ type: 'text', text: '' })))).join(' ')).toMatch(/text node/);
    expect(errorsOf(doc(p(bad({ type: 'text', text: 42 })))).join(' ')).toMatch(/text node/);
    expect(errorsOf(doc(p(bad({ type: 'text', text: null })))).join(' ')).toMatch(/text node/);
  });

  it('rejects a text node that also carries content', () => {
    expect(
      errorsOf(doc(p(bad({ type: 'text', text: 'a', content: [t('b')] })))).join(' '),
    ).toMatch(/must not have content/);
  });

  it('rejects a non-text node carrying a text property', () => {
    expect(errorsOf(doc(bad({ type: 'paragraph', text: 'sneaky' }))).join(' ')).toMatch(
      /must not have a text property/,
    );
  });

  it('rejects a text node as a direct child of the document', () => {
    expect(errorsOf(doc(t('bare'))).join(' ')).toMatch(/text/i);
  });
});

describe('validateEditorDoc — marks', () => {
  it('rejects an unknown mark type', () => {
    expect(errorsOf(doc(p(t('x', [{ type: 'strike' }])))).join(' ')).toContain(
      'unknown mark type "strike"',
    );
  });

  it('rejects marks that are not an array of objects with a string type', () => {
    expect(errorsOf(doc(p(bad({ type: 'text', text: 'x', marks: 'bold' })))).join(' ')).toMatch(
      /marks must be an array/,
    );
    expect(errorsOf(doc(p(bad({ type: 'text', text: 'x', marks: [null] })))).join(' ')).toMatch(
      /mark must be an object/,
    );
    expect(errorsOf(doc(p(bad({ type: 'text', text: 'x', marks: [{ type: 1 }] })))).join(' ')).toMatch(
      /mark/,
    );
  });
});

describe('validateEditorDoc — link hrefs are an XSS surface', () => {
  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(document.cookie)',
    'java\nscript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    // Schemes that DO parse to a non-empty host, so only a protocol check
    // catches them. The `//` makes the host a JavaScript comment target and
    // `%0a` starts the payload on a fresh line — a live webmail XSS.
    'javascript://example.com/%0aalert(1)',
    'JAVASCRIPT://example.com/%0aalert(1)',
    'javascript://%0aalert(document.cookie)//example.com',
    'data://example.com/payload',
    'vbscript://evil.test/x',
    'ftp://example.com/file.txt',
    'mailto:someone@example.com',
    'tel:+441234567890',
    '/relative/path',
    '//protocol-relative.example.com',
    'example.com/no-scheme',
    '',
  ])('rejects the link href %j', (href) => {
    const errors = errorsOf(doc(p(t('click me', [linkMark(href)]))));
    expect(errors.join(' ')).toMatch(/href/);
  });

  it('rejects a link href carrying embedded credentials', () => {
    // Displays as one host, resolves to another.
    expect(
      errorsOf(doc(p(t('x', [linkMark('https://www.paypal.com@evil.test/login')])))).join(' '),
    ).toMatch(/href/);
  });

  it('rejects a link href containing control characters', () => {
    expect(errorsOf(doc(p(t('x', [linkMark('https://exa mple.com')])))).join(' ')).toMatch(/href/);
  });

  it('rejects a link mark with a missing or non-string href', () => {
    expect(errorsOf(doc(p(t('x', [{ type: 'link' }])))).join(' ')).toMatch(/href/);
    expect(errorsOf(doc(p(t('x', [{ type: 'link', attrs: {} }])))).join(' ')).toMatch(/href/);
    expect(errorsOf(doc(p(t('x', [{ type: 'link', attrs: { href: 12 } }])))).join(' ')).toMatch(/href/);
  });

  it('reports the offending href so the writer can fix it', () => {
    expect(errorsOf(doc(p(t('x', [linkMark('javascript:alert(1)')])))).join(' ')).toContain(
      'javascript:alert(1)',
    );
  });
});

describe('validateEditorDoc — images', () => {
  it('rejects an image with no attrs at all', () => {
    expect(errorsOf(doc(bad({ type: 'image' }))).join(' ')).toMatch(/src/);
  });

  it('rejects an image with a missing, empty or non-string src', () => {
    expect(errorsOf(doc(bad({ type: 'image', attrs: {} }))).join(' ')).toMatch(/src/);
    expect(errorsOf(doc(bad({ type: 'image', attrs: { src: '' } }))).join(' ')).toMatch(/src/);
    expect(errorsOf(doc(bad({ type: 'image', attrs: { src: 5 } }))).join(' ')).toMatch(/src/);
  });

  it('rejects a non-http(s) image src', () => {
    for (const src of [
      'javascript:alert(1)',
      'data:image/gif;base64,R0lGOD',
      '/local.png',
      // Parses with a real host; only the protocol check rejects it.
      'javascript://example.com/%0aalert(1)',
      'ftp://example.com/logo.png',
    ]) {
      expect(errorsOf(doc(bad({ type: 'image', attrs: { src } }))).join(' ')).toMatch(/src/);
    }
  });
});

describe('validateEditorDoc — headings and list structure', () => {
  it('rejects a heading without a usable level', () => {
    expect(errorsOf(doc(bad({ type: 'heading', content: [t('x')] }))).join(' ')).toMatch(/level/);
    expect(errorsOf(doc(bad({ type: 'heading', attrs: { level: 0 }, content: [t('x')] }))).join(' ')).toMatch(/level/);
    expect(errorsOf(doc(bad({ type: 'heading', attrs: { level: 7 }, content: [t('x')] }))).join(' ')).toMatch(/level/);
    expect(errorsOf(doc(bad({ type: 'heading', attrs: { level: 2.5 }, content: [t('x')] }))).join(' ')).toMatch(/level/);
    expect(errorsOf(doc(bad({ type: 'heading', attrs: { level: '2' }, content: [t('x')] }))).join(' ')).toMatch(/level/);
  });

  it('rejects a list whose children are not list items', () => {
    expect(errorsOf(doc(ul(p(t('loose'))))).join(' ')).toMatch(/listItem/);
    expect(errorsOf(doc(ol(p(t('loose'))))).join(' ')).toMatch(/listItem/);
  });

  it('rejects a list item outside a list', () => {
    expect(errorsOf(doc(li(p(t('orphan'))))).join(' ')).toMatch(/listItem/);
  });
});

describe('validateEditorDoc — reporting', () => {
  it('returns every error, not just the first', () => {
    const errors = errorsOf(
      bad({
        type: 'doc',
        content: [
          { type: 'codeBlock' },
          { type: 'paragraph', content: [{ type: 'text' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'blink' }] }] },
          { type: 'image', attrs: {} },
          { type: 'paragraph', content: [{ type: 'text', text: 'y', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] },
        ],
      }),
    );

    expect(errors.length).toBeGreaterThanOrEqual(5);
    expect(errors.join(' ')).toContain('codeBlock');
    expect(errors.join(' ')).toContain('blink');
    expect(errors.join(' ')).toContain('javascript:alert(1)');
    expect(errors.some((e) => e.includes('content[1]'))).toBe(true);
    expect(errors.some((e) => e.includes('content[3]'))).toBe(true);
  });

  it('gives each error a path pointing at the offending node', () => {
    const errors = errorsOf(doc(quote(p(t('ok')), bad({ type: 'marquee' }))));
    expect(errors[0]).toContain('content[0].content[1]');
  });

  it('rejects an absurdly deep document instead of blowing the stack', () => {
    let node: EditorNode = p(t('deep'));
    for (let i = 0; i < 10_000; i += 1) node = quote(node);

    const result = validateEditorDoc(doc(node));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/deep/i);
  });
});

/* ------------------------------------------------------------------ */
/* collectors                                                          */
/* ------------------------------------------------------------------ */

describe('collectText', () => {
  it('returns the visible text of a simple document', () => {
    expect(collectText(sampleDoc())).toBe('Hello world, this is a newsletter body.');
  });

  it('joins blocks with newlines and keeps document order', () => {
    expect(collectText(doc(p(t('one')), p(t('two')), h(2, 'three')))).toBe('one\ntwo\nthree');
  });

  it('concatenates adjacent inline nodes without inventing separators', () => {
    expect(collectText(doc(p(t('Hello, '), t('world', [{ type: 'bold' }]), t('!'))))).toBe(
      'Hello, world!',
    );
  });

  it('descends into lists, list items and blockquotes', () => {
    expect(collectText(doc(quote(ul(li(p(t('a'))), li(p(t('b')))))))).toBe('a\nb');
  });

  it('treats a hard break as a line break', () => {
    expect(collectText(doc(p(t('a'), { type: 'hardBreak' }, t('b'))))).toBe('a\nb');
  });

  it('contributes nothing for images or horizontal rules', () => {
    expect(collectText(doc(img('https://cdn.example.com/a.png', 'Alt text'), { type: 'horizontalRule' }))).toBe('');
  });

  it('does not throw on a malformed document', () => {
    expect(() => collectText(bad({ type: 'doc' }))).not.toThrow();
    expect(collectText(bad({ type: 'doc' }))).toBe('');
  });
});

describe('collectLinks', () => {
  it('returns hrefs in document order with a zero-based index', () => {
    const d = doc(
      p(t('first', [linkMark('https://example.com/1')])),
      quote(p(t('second', [linkMark('https://example.com/2')]))),
      ul(li(p(t('third', [linkMark('https://example.com/3')])))),
    );

    expect(collectLinks(d)).toEqual([
      { href: 'https://example.com/1', index: 0 },
      { href: 'https://example.com/2', index: 1 },
      { href: 'https://example.com/3', index: 2 },
    ]);
  });

  it('returns an empty array for a document without links', () => {
    expect(collectLinks(sampleDoc())).toEqual([]);
  });

  it('counts a repeated href once per occurrence — indexes are positions, not identities', () => {
    const d = doc(p(t('a', [linkMark('https://example.com/x')])), p(t('b', [linkMark('https://example.com/x')])));
    expect(collectLinks(d).map((l) => l.index)).toEqual([0, 1]);
  });

  it('ignores marks that are not links and hrefs that are not strings', () => {
    const d = bad({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a', marks: [{ type: 'bold' }] }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'b', marks: [{ type: 'link', attrs: {} }] }] },
      ],
    });
    expect(collectLinks(d)).toEqual([]);
  });
});

describe('collectImages', () => {
  it('returns image sources in document order', () => {
    const d = doc(
      img('https://cdn.example.com/1.png'),
      quote(img('https://cdn.example.com/2.png')),
      p(t('text')),
    );
    expect(collectImages(d)).toEqual(['https://cdn.example.com/1.png', 'https://cdn.example.com/2.png']);
  });

  it('returns an empty array when there are none', () => {
    expect(collectImages(sampleDoc())).toEqual([]);
  });

  it('skips images without a usable src rather than emitting undefined', () => {
    expect(collectImages(bad({ type: 'doc', content: [{ type: 'image', attrs: {} }, { type: 'image' }] }))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* emptiness — drives the §6.6 pre-send gate                           */
/* ------------------------------------------------------------------ */

describe('isEmptyDoc', () => {
  it('is true for a document with no content', () => {
    expect(isEmptyDoc(doc())).toBe(true);
  });

  it('is true for empty paragraphs and whitespace-only text', () => {
    expect(isEmptyDoc(doc({ type: 'paragraph' }))).toBe(true);
    expect(isEmptyDoc(doc(p(), p()))).toBe(true);
    expect(isEmptyDoc(doc(p(t('   ')), p(t('\t\n'))))).toBe(true);
    expect(isEmptyDoc(doc(p(t(' '))))).toBe(true);
    // Zero-width space, zero-width joiner, BOM and a non-breaking space are not text.
    expect(isEmptyDoc(doc(p(t('​‍﻿ '))))).toBe(true);
  });

  it('is true for structure without any content', () => {
    expect(isEmptyDoc(doc({ type: 'horizontalRule' }, quote(p(t(' ')))))).toBe(true);
  });

  it('is false as soon as there is real text', () => {
    expect(isEmptyDoc(sampleDoc())).toBe(false);
    expect(isEmptyDoc(doc(quote(ul(li(p(t('x')))))))).toBe(false);
  });

  it('is false when the only content is an image — that is image-only, not empty', () => {
    expect(isEmptyDoc(doc(img('https://cdn.example.com/a.png')))).toBe(false);
  });
});

describe('isImageOnly', () => {
  it('is true for a body of images with no meaningful text (§6.6 spam signal)', () => {
    expect(isImageOnly(doc(img('https://cdn.example.com/a.png')))).toBe(true);
    expect(isImageOnly(doc(img('https://cdn.example.com/a.png'), img('https://cdn.example.com/b.png')))).toBe(true);
  });

  it('treats whitespace, non-breaking and zero-width characters as not meaningful', () => {
    expect(isImageOnly(doc(img('https://cdn.example.com/a.png'), p(t('   '))))).toBe(true);
    expect(isImageOnly(doc(img('https://cdn.example.com/a.png'), p(t(' ​'))))).toBe(true);
  });

  it('is true when the only other content is structural', () => {
    expect(
      isImageOnly(doc({ type: 'horizontalRule' }, img('https://cdn.example.com/a.png'), p())),
    ).toBe(true);
  });

  it('is false once there is real text alongside the image', () => {
    expect(isImageOnly(doc(img('https://cdn.example.com/a.png'), p(t('A word'))))).toBe(false);
    expect(isImageOnly(doc(img('https://cdn.example.com/a.png'), quote(p(t('deep')))))).toBe(false);
  });

  it('is false when there are no images at all', () => {
    expect(isImageOnly(sampleDoc())).toBe(false);
    expect(isImageOnly(doc())).toBe(false);
  });

  it('counts alt text as image metadata, not body text', () => {
    // Alt text lives on the image; it does not rescue an image-only body.
    expect(isImageOnly(doc(img('https://cdn.example.com/a.png', 'A very descriptive alt')))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* mapLinks — click tracking depends on this being exactly right       */
/* ------------------------------------------------------------------ */

describe('mapLinks', () => {
  const tracked = doc(
    p(t('one', [linkMark('https://example.com/1')])),
    quote(p(t('two', [linkMark('https://example.com/2')]))),
    ul(li(p(t('three', [linkMark('https://example.com/3')]), t(' and '), t('four', [linkMark('https://example.com/4')])))),
  );

  it('rewrites every href through the callback', () => {
    const out = mapLinks(tracked, (href, index) => `https://track.example.com/${index}?u=${encodeURIComponent(href)}`);
    expect(collectLinks(out).map((l) => l.href)).toEqual([
      'https://track.example.com/0?u=https%3A%2F%2Fexample.com%2F1',
      'https://track.example.com/1?u=https%3A%2F%2Fexample.com%2F2',
      'https://track.example.com/2?u=https%3A%2F%2Fexample.com%2F3',
      'https://track.example.com/3?u=https%3A%2F%2Fexample.com%2F4',
    ]);
  });

  it('indexes links in document order, matching collectLinks', () => {
    const seen: { href: string; index: number }[] = [];
    mapLinks(tracked, (href, index) => {
      seen.push({ href, index });
      return href;
    });
    expect(seen).toEqual(collectLinks(tracked));
    expect(seen.map((s) => s.index)).toEqual([0, 1, 2, 3]);
  });

  it('never mutates the input document', () => {
    const before = structuredClone(tracked);
    const out = mapLinks(tracked, () => 'https://elsewhere.example.com/');

    expect(tracked).toEqual(before);
    expect(out).not.toBe(tracked);
    expect(out.content).not.toBe(tracked.content);
    expect(out.content[0]).not.toBe(tracked.content[0]);

    // Mutating the result must not reach back into the input.
    (out.content[0].content![0].marks![0].attrs as Record<string, unknown>).href = 'https://mutated.test/';
    expect(tracked.content[0].content![0].marks![0].attrs!.href).toBe('https://example.com/1');
  });

  it('returns an equal-but-distinct document when the callback is the identity', () => {
    const out = mapLinks(tracked, (href) => href);
    expect(out).toEqual(tracked);
    expect(out).not.toBe(tracked);
  });

  it('copies documents with no links at all', () => {
    const out = mapLinks(sampleDoc(), () => 'https://never.test/');
    expect(out).toEqual(sampleDoc());
  });

  it('preserves other marks, mark order and other link attributes', () => {
    const d = doc(
      p({
        type: 'text',
        text: 'x',
        marks: [
          { type: 'bold' },
          { type: 'link', attrs: { href: 'https://example.com/a', target: '_blank', rel: 'noopener' } },
          { type: 'italic' },
        ],
      }),
    );
    const out = mapLinks(d, () => 'https://track.example.com/0');
    const marks = out.content[0].content![0].marks!;

    expect(marks.map((m) => m.type)).toEqual(['bold', 'link', 'italic']);
    expect(marks[1].attrs).toEqual({
      href: 'https://track.example.com/0',
      target: '_blank',
      rel: 'noopener',
    });
  });

  it('preserves text, node attributes and structure untouched', () => {
    const out = mapLinks(everyNodeType, (href) => `${href}#tracked`);
    expect(collectText(out)).toBe(collectText(everyNodeType));
    expect(collectImages(out)).toEqual(collectImages(everyNodeType));
    expect(out.content[0].attrs).toEqual({ level: 2 });
  });

  it('leaves malformed link marks alone rather than emitting undefined', () => {
    const d = bad({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: {} }] }] }],
    });
    const out = mapLinks(d, () => 'https://track.example.com/0');
    expect(out.content[0].content![0].marks![0].attrs).toEqual({});
  });

  it('survives an absurdly deep document without blowing the stack', () => {
    let node: EditorNode = p(t('deep', [linkMark('https://example.com/deep')]));
    for (let i = 0; i < 10_000; i += 1) node = quote(node);
    expect(() => mapLinks(doc(node), (href) => href)).not.toThrow();
  });
});
