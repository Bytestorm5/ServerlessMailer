import { describe, expect, it } from 'vitest';

import { isEmptyDoc, validateEditorDoc } from '@/lib/render/doc';
import { docToPlainText } from '@/lib/render/text';
import { sampleDoc, validCampaignDoc } from '@tests/helpers/factories';
import type { EditorDoc, EditorMark, EditorNode } from '@/lib/types';

/* ------------------------------------------------------------------ */
/* builders                                                            */
/* ------------------------------------------------------------------ */

const t = (text: string, marks?: EditorMark[]): EditorNode =>
  marks ? { type: 'text', text, marks } : { type: 'text', text };
const p = (...content: EditorNode[]): EditorNode => ({ type: 'paragraph', content });
const h = (level: number, ...content: EditorNode[]): EditorNode => ({
  type: 'heading',
  attrs: { level },
  content,
});
const li = (...content: EditorNode[]): EditorNode => ({ type: 'listItem', content });
const ul = (...content: EditorNode[]): EditorNode => ({ type: 'bulletList', content });
const ol = (attrs: Record<string, unknown> | null, ...content: EditorNode[]): EditorNode =>
  attrs ? { type: 'orderedList', attrs, content } : { type: 'orderedList', content };
const quote = (...content: EditorNode[]): EditorNode => ({ type: 'blockquote', content });
const img = (src: string, alt?: string): EditorNode => ({
  type: 'image',
  attrs: alt === undefined ? { src } : { src, alt },
});
const hr: EditorNode = { type: 'horizontalRule' };
const br: EditorNode = { type: 'hardBreak' };
const linkMark = (href: string): EditorMark => ({ type: 'link', attrs: { href } });
const doc = (...content: EditorNode[]): EditorDoc => ({ type: 'doc', content });
const bad = (value: unknown): EditorDoc => value as EditorDoc;

const HR_LINE = '-'.repeat(32);

/* ------------------------------------------------------------------ */
/* paragraphs and inline content                                       */
/* ------------------------------------------------------------------ */

describe('docToPlainText — paragraphs', () => {
  it('renders a single paragraph as its text', () => {
    expect(docToPlainText(sampleDoc())).toBe('Hello world, this is a newsletter body.');
  });

  it('separates blocks with a blank line', () => {
    expect(docToPlainText(doc(p(t('One.')), p(t('Two.'))))).toBe('One.\n\nTwo.');
  });

  it('concatenates inline runs without inserting spaces', () => {
    expect(docToPlainText(doc(p(t('Hello, '), t('world'), t('!'))))).toBe('Hello, world!');
  });

  it('renders bold and italic as plain text — the text part carries no markup', () => {
    const d = doc(p(t('a '), t('bold', [{ type: 'bold' }]), t(' and '), t('italic', [{ type: 'italic' }])));
    expect(docToPlainText(d)).toBe('a bold and italic');
    expect(docToPlainText(d)).not.toContain('*');
    expect(docToPlainText(d)).not.toContain('_');
  });

  it('renders a hard break as a single newline inside the block', () => {
    expect(docToPlainText(doc(p(t('first'), br, t('second'))))).toBe('first\nsecond');
  });

  it('drops empty paragraphs rather than emitting runs of blank lines', () => {
    const text = docToPlainText(doc(p(t('One.')), p(), { type: 'paragraph' }, p(t('Two.'))));
    expect(text).toBe('One.\n\nTwo.');
  });

  it('leaves merge-field placeholders byte-for-byte intact', () => {
    const raw = 'Hi {{ first_name | default: "there" }}, see {{unsubscribe_url}}.';
    expect(docToPlainText(doc(p(t(raw))))).toBe(raw);
  });

  it('does not escape markdown punctuation — this is plain text, not markdown', () => {
    const raw = '*not bold* [not a link](nope) _snake_case_ # not a heading';
    expect(docToPlainText(doc(p(t(raw))))).toBe(raw);
  });

  it('does not escape HTML — the text part is not HTML', () => {
    expect(docToPlainText(doc(p(t('5 < 6 & "quoted"'))))).toBe('5 < 6 & "quoted"');
  });
});

/* ------------------------------------------------------------------ */
/* links                                                               */
/* ------------------------------------------------------------------ */

describe('docToPlainText — links', () => {
  it('renders a link as "text (url)" so the URL survives', () => {
    const d = doc(p(t('Read the post', [linkMark('https://example.com/post')])));
    expect(docToPlainText(d)).toBe('Read the post (https://example.com/post)');
  });

  it('renders a link inline within surrounding text', () => {
    const d = doc(p(t('See '), t('our post', [linkMark('https://example.com/post')]), t(' today.')));
    expect(docToPlainText(d)).toBe('See our post (https://example.com/post) today.');
  });

  it('does not repeat the URL when the link text is already the URL', () => {
    const d = doc(p(t('https://example.com/post', [linkMark('https://example.com/post')])));
    expect(docToPlainText(d)).toBe('https://example.com/post');
  });

  it('keeps other marks on a linked run without adding markup', () => {
    const d = doc(p(t('Bold link', [{ type: 'bold' }, linkMark('https://example.com/x')])));
    expect(docToPlainText(d)).toBe('Bold link (https://example.com/x)');
  });

  it('renders every link in a document', () => {
    const text = docToPlainText(validCampaignDoc());
    expect(text).toContain('Read more (https://example.com/post)');
  });
});

/* ------------------------------------------------------------------ */
/* headings                                                            */
/* ------------------------------------------------------------------ */

describe('docToPlainText — headings', () => {
  it('underlines a level 1 heading with "="', () => {
    expect(docToPlainText(doc(h(1, t('Big title'))))).toBe('Big title\n=========');
  });

  it('underlines lower-level headings with "-"', () => {
    expect(docToPlainText(doc(h(2, t('Weekly update'))))).toBe('Weekly update\n-------------');
    expect(docToPlainText(doc(h(3, t('Sub'))))).toBe('Sub\n---');
  });

  it('sizes the underline to the rendered line, including an inline link', () => {
    const text = docToPlainText(doc(h(2, t('Post', [linkMark('https://example.com/p')]))));
    const [title, underline] = text.split('\n');
    expect(title).toBe('Post (https://example.com/p)');
    expect(underline).toBe('-'.repeat(title.length));
  });

  it('never emits an underline shorter than three characters', () => {
    expect(docToPlainText(doc(h(2, t('A'))))).toBe('A\n---');
  });

  it('separates a heading from the following paragraph with a blank line', () => {
    expect(docToPlainText(doc(h(2, t('Title')), p(t('Body.'))))).toBe('Title\n-----\n\nBody.');
  });

  it('defaults a heading with no usable level to a second-level underline', () => {
    expect(docToPlainText(bad({ type: 'doc', content: [{ type: 'heading', content: [t('Title')] }] }))).toBe(
      'Title\n-----',
    );
  });
});

/* ------------------------------------------------------------------ */
/* lists                                                               */
/* ------------------------------------------------------------------ */

describe('docToPlainText — bullet lists', () => {
  it('prefixes each item with "- "', () => {
    const d = doc(ul(li(p(t('One'))), li(p(t('Two')))));
    expect(docToPlainText(d)).toBe('- One\n- Two');
  });

  it('indents a nested list under its parent item', () => {
    const d = doc(ul(li(p(t('One'))), li(p(t('Two')), ul(li(p(t('Nested'))), li(p(t('Also')))))));
    expect(docToPlainText(d)).toBe('- One\n- Two\n  - Nested\n  - Also');
  });

  it('indents a second paragraph inside an item to the marker width', () => {
    const d = doc(ul(li(p(t('One')), p(t('More about one')))));
    expect(docToPlainText(d)).toBe('- One\n\n  More about one');
  });

  it('separates a list from surrounding blocks with a blank line', () => {
    const d = doc(p(t('Before.')), ul(li(p(t('Item')))), p(t('After.')));
    expect(docToPlainText(d)).toBe('Before.\n\n- Item\n\nAfter.');
  });
});

describe('docToPlainText — ordered lists', () => {
  it('numbers items from one and increments correctly', () => {
    const d = doc(ol(null, li(p(t('First'))), li(p(t('Second'))), li(p(t('Third')))));
    expect(docToPlainText(d)).toBe('1. First\n2. Second\n3. Third');
  });

  it('honours an explicit start attribute', () => {
    const d = doc(ol({ start: 3 }, li(p(t('Three'))), li(p(t('Four')))));
    expect(docToPlainText(d)).toBe('3. Three\n4. Four');
  });

  it('keeps numbering past ten and aligns nested content to the wider marker', () => {
    const items = Array.from({ length: 11 }, (_, i) => li(p(t(`Item ${i + 1}`))));
    const text = docToPlainText(doc(ol(null, ...items)));
    expect(text.split('\n')[9]).toBe('10. Item 10');
    expect(text.split('\n')[10]).toBe('11. Item 11');
  });

  it('restarts numbering for a nested ordered list', () => {
    const d = doc(
      ol(null, li(p(t('One')), ol(null, li(p(t('Inner one'))), li(p(t('Inner two'))))), li(p(t('Two')))),
    );
    expect(docToPlainText(d)).toBe('1. One\n   1. Inner one\n   2. Inner two\n2. Two');
  });

  it('renders a bullet list nested inside an ordered list', () => {
    const d = doc(ol(null, li(p(t('One')), ul(li(p(t('Bullet')))))));
    expect(docToPlainText(d)).toBe('1. One\n   - Bullet');
  });
});

/* ------------------------------------------------------------------ */
/* blockquotes, rules and images                                       */
/* ------------------------------------------------------------------ */

describe('docToPlainText — blockquotes', () => {
  it('prefixes every line with "> "', () => {
    expect(docToPlainText(doc(quote(p(t('Quoted wisdom.')))))).toBe('> Quoted wisdom.');
  });

  it('keeps paragraphs apart inside the quote without trailing whitespace', () => {
    const d = doc(quote(p(t('One.')), p(t('Two.'))));
    expect(docToPlainText(d)).toBe('> One.\n>\n> Two.');
  });

  it('nests quote markers', () => {
    expect(docToPlainText(doc(quote(quote(p(t('Deep'))))))).toBe('> > Deep');
  });

  it('quotes list items too', () => {
    expect(docToPlainText(doc(quote(ul(li(p(t('a'))), li(p(t('b')))))))).toBe('> - a\n> - b');
  });
});

describe('docToPlainText — horizontal rules and images', () => {
  it('renders a horizontal rule as a divider line', () => {
    const text = docToPlainText(doc(p(t('Above')), hr, p(t('Below'))));
    expect(text).toBe(`Above\n\n${HR_LINE}\n\nBelow`);
    expect(HR_LINE.length).toBeGreaterThanOrEqual(3);
  });

  it('renders an image with its alt text and source', () => {
    expect(docToPlainText(doc(img('https://cdn.example.com/chart.png', 'Chart')))).toBe(
      '[Image: Chart] (https://cdn.example.com/chart.png)',
    );
  });

  it('renders an image without alt text', () => {
    expect(docToPlainText(doc(img('https://cdn.example.com/chart.png')))).toBe(
      '[Image] (https://cdn.example.com/chart.png)',
    );
    expect(docToPlainText(doc(img('https://cdn.example.com/chart.png', '')))).toBe(
      '[Image] (https://cdn.example.com/chart.png)',
    );
  });

  it('never emits the string "undefined" for a malformed image', () => {
    const text = docToPlainText(bad({ type: 'doc', content: [{ type: 'image', attrs: {} }] }));
    expect(text).not.toContain('undefined');
  });
});

/* ------------------------------------------------------------------ */
/* the multipart/alternative guarantee (§6.2)                          */
/* ------------------------------------------------------------------ */

describe('docToPlainText — the text part is never empty for a non-empty document', () => {
  const nonEmpty: [string, EditorDoc][] = [
    ['a plain paragraph', sampleDoc()],
    ['the campaign fixture', validCampaignDoc()],
    ['a heading only', doc(h(2, t('Only a heading')))],
    ['a link only', doc(p(t('Click', [linkMark('https://example.com')])))],
    ['an image only', doc(img('https://cdn.example.com/a.png', 'Alt'))],
    ['a list only', doc(ul(li(p(t('Item')))))],
    ['a quote only', doc(quote(p(t('Quoted'))))],
    ['a rule only', doc(hr)],
    ['a hard break only', doc(p(t('a'), br, t('b')))],
  ];

  it.each(nonEmpty)('produces text for %s', (_label, d) => {
    const text = docToPlainText(d);
    expect(text.trim().length).toBeGreaterThan(0);
  });

  it('produces text whenever isEmptyDoc says the body has content', () => {
    for (const [, d] of nonEmpty) {
      if (isEmptyDoc(d)) continue;
      expect(docToPlainText(d).trim()).not.toBe('');
    }
  });

  it('returns an empty string for a genuinely empty document', () => {
    expect(docToPlainText(doc())).toBe('');
    expect(docToPlainText(doc(p(), p()))).toBe('');
    expect(docToPlainText(doc(p(t('   '))))).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/* output hygiene                                                      */
/* ------------------------------------------------------------------ */

describe('docToPlainText — output hygiene', () => {
  const kitchenSink = doc(
    h(1, t('Title')),
    p(t('Intro with a '), t('link', [linkMark('https://example.com/a')]), t('.')),
    p(),
    ul(li(p(t('One'))), li(p(t('Two')), ul(li(p(t('Nested')))))),
    ol({ start: 2 }, li(p(t('Second')))),
    quote(p(t('Quoted.')), p(t('Still quoted.'))),
    hr,
    img('https://cdn.example.com/a.png', 'Alt'),
    p(t('Outro.')),
  );

  it('never emits three consecutive newlines', () => {
    expect(docToPlainText(kitchenSink)).not.toMatch(/\n{3}/);
  });

  it('never leaves trailing whitespace on a line', () => {
    for (const line of docToPlainText(kitchenSink).split('\n')) {
      expect(line).toBe(line.replace(/[ \t]+$/, ''));
    }
  });

  it('never emits carriage returns', () => {
    expect(docToPlainText(kitchenSink)).not.toContain('\r');
  });

  it('has no leading or trailing blank lines', () => {
    const text = docToPlainText(kitchenSink);
    expect(text).toBe(text.trim());
  });

  it('is deterministic', () => {
    expect(docToPlainText(kitchenSink)).toBe(docToPlainText(kitchenSink));
  });

  it('renders a document that passes validation', () => {
    expect(validateEditorDoc(kitchenSink).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* defensive behaviour                                                 */
/* ------------------------------------------------------------------ */

describe('docToPlainText — defensive behaviour', () => {
  it('does not throw on a document with no content array', () => {
    expect(docToPlainText(bad({ type: 'doc' }))).toBe('');
  });

  it('does not throw on unexpected node shapes and keeps their text', () => {
    const d = bad({
      type: 'doc',
      content: [
        null,
        { type: 'paragraph', content: [{ type: 'text', text: 'kept' }] },
        { type: 'somethingElse', content: [{ type: 'text', text: 'also kept' }] },
      ],
    });
    const text = docToPlainText(d);
    expect(text).toContain('kept');
    expect(text).toContain('also kept');
  });

  it('does not throw on a link mark without a usable href', () => {
    const d = bad({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: {} }] }] }],
    });
    expect(docToPlainText(d)).toBe('x');
  });

  it('survives an absurdly deep document without blowing the stack', () => {
    let node: EditorNode = p(t('deep'));
    for (let i = 0; i < 10_000; i += 1) node = quote(node);
    expect(() => docToPlainText(doc(node))).not.toThrow();
  });
});
