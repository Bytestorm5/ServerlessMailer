import { describe, expect, it } from 'vitest';

import { collectLinks, collectText, validateEditorDoc } from '@/lib/render/doc';
import { docToMarkdown, markdownToDoc } from '@/lib/render/markdown';
import { docToPlainText } from '@/lib/render/text';
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
const ol = (start: number, ...content: EditorNode[]): EditorNode => ({
  type: 'orderedList',
  attrs: { start },
  content,
});
const quote = (...content: EditorNode[]): EditorNode => ({ type: 'blockquote', content });
const image = (src: string, alt: string): EditorNode => ({ type: 'image', attrs: { src, alt } });
const hr: EditorNode = { type: 'horizontalRule' };
const br: EditorNode = { type: 'hardBreak' };
const linkMark = (href: string): EditorMark => ({ type: 'link', attrs: { href } });
const bold: EditorMark = { type: 'bold' };
const italic: EditorMark = { type: 'italic' };
const doc = (...content: EditorNode[]): EditorDoc => ({ type: 'doc', content });
const bad = (value: unknown): EditorDoc => value as EditorDoc;

const item = (text: string): EditorNode => li(p(t(text)));

/* ------------------------------------------------------------------ */
/* the round-trip fixture: every supported construct in one document   */
/* ------------------------------------------------------------------ */

const everything: EditorDoc = doc(
  h(1, 'Big title'),
  h(2, 'Section'),
  p(
    t('Plain, '),
    t('bold', [bold]),
    t(', '),
    t('italic', [italic]),
    t(' and a '),
    t('link', [linkMark('https://example.com/post')]),
    t('.'),
    br,
    t('After a break with '),
    t('both', [bold, italic]),
    t(' and a '),
    t('bold link', [bold, linkMark('https://example.com/x')]),
    t('.'),
  ),
  ul(item('First'), li(p(t('Second')), ul(item('Nested')))),
  ol(1, item('Step one'), item('Step two')),
  quote(p(t('Quoted wisdom.')), p(t('Still quoted.'))),
  image('https://cdn.example.com/chart.png', 'Chart'),
  hr,
  p(t('Hello {{ first_name | default: "there" }}.')),
);

const everythingMarkdown = [
  '# Big title',
  '',
  '## Section',
  '',
  'Plain, **bold**, *italic* and a [link](https://example.com/post).\\',
  'After a break with ***both*** and a [**bold link**](https://example.com/x).',
  '',
  '- First',
  '- Second',
  '  - Nested',
  '',
  '1. Step one',
  '2. Step two',
  '',
  '> Quoted wisdom.',
  '>',
  '> Still quoted.',
  '',
  '![Chart](https://cdn.example.com/chart.png)',
  '',
  '---',
  '',
  'Hello {{ first_name | default: "there" }}.',
].join('\n');

/* ------------------------------------------------------------------ */
/* round-tripping — the headline requirement                           */
/* ------------------------------------------------------------------ */

describe('markdown round-trip', () => {
  it('round-trips every supported node type losslessly', () => {
    expect(markdownToDoc(docToMarkdown(everything))).toEqual(everything);
  });

  it('serialises the fixture to the exact expected markdown', () => {
    expect(docToMarkdown(everything)).toBe(everythingMarkdown);
  });

  it('parses the expected markdown back to the exact document', () => {
    expect(markdownToDoc(everythingMarkdown)).toEqual(everything);
  });

  it('is stable on a second pass in both directions', () => {
    const once = docToMarkdown(everything);
    expect(docToMarkdown(markdownToDoc(once))).toBe(once);
    expect(markdownToDoc(docToMarkdown(markdownToDoc(once)))).toEqual(everything);
  });

  it.each([
    ['a plain paragraph', sampleDoc()],
    ['the campaign fixture', validCampaignDoc()],
    ['a heading', doc(h(3, 'Just a heading'))],
    ['a hard break', doc(p(t('a'), br, t('b')))],
    ['a hard break after a literal backslash', doc(p(t('path\\'), br, t('next')))],
    ['a nested bullet list', doc(ul(item('a'), li(p(t('b')), ul(item('c')))))],
    ['an ordered list starting at 5', doc(ol(5, item('five'), item('six')))],
    ['a nested blockquote', doc(quote(p(t('outer')), quote(p(t('inner')))))],
    ['a multi-paragraph list item', doc(ul(li(p(t('one')), p(t('still one'))), item('two')))],
    ['an image', doc(image('https://cdn.example.com/a.png', 'Alt text'))],
    ['a horizontal rule between paragraphs', doc(p(t('a')), hr, p(t('b')))],
    ['combined marks', doc(p(t('x', [bold, italic, linkMark('https://example.com/x')])))],
    ['a list inside a blockquote', doc(quote(ul(item('quoted item'))))],
    ['a heading inside a blockquote', doc(quote(h(2, 'Quoted heading')))],
    ['merge fields with underscores', doc(p(t('{{ first_name }} and {{ last_name }}')))],
  ])('round-trips %s', (_label, d) => {
    expect(markdownToDoc(docToMarkdown(d))).toEqual(d);
  });

  it('preserves link hrefs exactly, including query strings and fragments', () => {
    const d = doc(p(t('x', [linkMark('https://example.com/a?b=c&d=e#f')])));
    expect(collectLinks(markdownToDoc(docToMarkdown(d)))).toEqual([
      { href: 'https://example.com/a?b=c&d=e#f', index: 0 },
    ]);
  });

  it('round-trips a link whose URL contains parentheses or spaces', () => {
    for (const href of ['https://en.example.org/wiki/Thing_(disambiguation)', 'https://example.com/a b']) {
      const d = doc(p(t('x', [linkMark(href)])));
      expect(markdownToDoc(docToMarkdown(d))).toEqual(d);
    }
  });

  it('round-trips markdown punctuation that appears as literal text', () => {
    const d = doc(
      p(t('Costs *£5* and [brackets] plus a back\\slash and 2 * 3 = 6')),
      p(t('# not a heading')),
      p(t('- not a bullet')),
      p(t('> not a quote')),
      p(t('1. not a list')),
      p(t('--- not a rule')),
    );
    expect(markdownToDoc(docToMarkdown(d))).toEqual(d);
  });

  it('round-trips markdown text back to the same markdown', () => {
    const md = ['## Title', '', 'Some **bold** text.', '', '- a', '- b'].join('\n');
    expect(docToMarkdown(markdownToDoc(md))).toBe(md);
  });
});

/* ------------------------------------------------------------------ */
/* docToMarkdown                                                       */
/* ------------------------------------------------------------------ */

describe('docToMarkdown', () => {
  it('returns an empty string for an empty document', () => {
    expect(docToMarkdown(doc())).toBe('');
    expect(docToMarkdown(bad({ type: 'doc' }))).toBe('');
  });

  it('renders headings with the matching number of hashes', () => {
    expect(docToMarkdown(doc(h(1, 'One')))).toBe('# One');
    expect(docToMarkdown(doc(h(2, 'Two')))).toBe('## Two');
    expect(docToMarkdown(doc(h(6, 'Six')))).toBe('###### Six');
  });

  it('renders emphasis with asterisks only, never underscores', () => {
    expect(docToMarkdown(doc(p(t('a', [bold]))))).toBe('**a**');
    expect(docToMarkdown(doc(p(t('a', [italic]))))).toBe('*a*');
    expect(docToMarkdown(doc(p(t('a', [bold, italic]))))).toBe('***a***');
  });

  it('nests a link outside its emphasis', () => {
    expect(docToMarkdown(doc(p(t('a', [bold, linkMark('https://example.com')]))))).toBe(
      '[**a**](https://example.com)',
    );
  });

  it('merges adjacent runs that share the same marks', () => {
    expect(docToMarkdown(doc(p(t('a', [bold]), t('b', [bold]))))).toBe('**ab**');
  });

  it('escapes characters that would otherwise be re-parsed as markup', () => {
    expect(docToMarkdown(doc(p(t('*stars* and [brackets]'))))).toBe('\\*stars\\* and \\[brackets\\]');
    expect(docToMarkdown(doc(p(t('back\\slash'))))).toBe('back\\\\slash');
  });

  it('escapes a leading character that would start a different block', () => {
    expect(docToMarkdown(doc(p(t('# not a heading'))))).toBe('\\# not a heading');
    expect(docToMarkdown(doc(p(t('- not a bullet'))))).toBe('\\- not a bullet');
    expect(docToMarkdown(doc(p(t('> not a quote'))))).toBe('\\> not a quote');
    // The punctuation carries the escape: `\1` is not an escape sequence.
    expect(docToMarkdown(doc(p(t('1. not a list'))))).toBe('1\\. not a list');
    expect(docToMarkdown(doc(p(t('---'))))).toBe('\\---');
  });

  it('does not escape merge-field syntax', () => {
    expect(docToMarkdown(doc(p(t('{{ first_name | default: "there" }}'))))).toBe(
      '{{ first_name | default: "there" }}',
    );
  });

  it('skips empty paragraphs instead of emitting stray blank lines', () => {
    expect(docToMarkdown(doc(p(t('a')), p(), p(t('b'))))).toBe('a\n\nb');
  });

  it('numbers ordered list items from the start attribute', () => {
    expect(docToMarkdown(doc(ol(4, item('four'), item('five'))))).toBe('4. four\n5. five');
    expect(docToMarkdown(doc({ type: 'orderedList', content: [item('one')] }))).toBe('1. one');
  });

  it('renders an image with an empty alt when none is set', () => {
    expect(docToMarkdown(doc({ type: 'image', attrs: { src: 'https://cdn.example.com/a.png' } }))).toBe(
      '![](https://cdn.example.com/a.png)',
    );
  });

  it('renders a blank quoted line as a bare ">" with no trailing space', () => {
    const md = docToMarkdown(doc(quote(p(t('a')), p(t('b')))));
    expect(md).toBe('> a\n>\n> b');
    for (const line of md.split('\n')) expect(line).toBe(line.replace(/\s+$/, ''));
  });

  it('ignores unexpected node types rather than throwing', () => {
    const d = bad({
      type: 'doc',
      content: [null, { type: 'paragraph', content: [{ type: 'text', text: 'kept' }] }],
    });
    expect(docToMarkdown(d)).toBe('kept');
  });

  it('survives an absurdly deep document', () => {
    let node: EditorNode = p(t('deep'));
    for (let i = 0; i < 10_000; i += 1) node = quote(node);
    expect(() => docToMarkdown(doc(node))).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* markdownToDoc                                                       */
/* ------------------------------------------------------------------ */

describe('markdownToDoc', () => {
  it('returns an empty doc for empty or whitespace-only input', () => {
    expect(markdownToDoc('')).toEqual(doc());
    expect(markdownToDoc('   \n\n  \n')).toEqual(doc());
  });

  it('parses ATX headings of every level', () => {
    expect(markdownToDoc('### Deep')).toEqual(doc(h(3, 'Deep')));
    expect(markdownToDoc('###### Six')).toEqual(doc(h(6, 'Six')));
  });

  it('does not treat seven hashes or a hash without a space as a heading', () => {
    expect(markdownToDoc('####### Seven')).toEqual(doc(p(t('####### Seven'))));
    expect(markdownToDoc('#NoSpace')).toEqual(doc(p(t('#NoSpace'))));
  });

  it('parses emphasis and links', () => {
    expect(markdownToDoc('a **b** c')).toEqual(doc(p(t('a '), t('b', [bold]), t(' c'))));
    expect(markdownToDoc('a *b* c')).toEqual(doc(p(t('a '), t('b', [italic]), t(' c'))));
    expect(markdownToDoc('a ***b*** c')).toEqual(doc(p(t('a '), t('b', [bold, italic]), t(' c'))));
    expect(markdownToDoc('[label](https://example.com)')).toEqual(
      doc(p(t('label', [linkMark('https://example.com')]))),
    );
  });

  it('parses an angle-bracketed link destination', () => {
    expect(markdownToDoc('[x](<https://example.com/a b>)')).toEqual(
      doc(p(t('x', [linkMark('https://example.com/a b')]))),
    );
  });

  it('never treats underscores as emphasis — merge fields are snake_case', () => {
    const md = 'Hi {{ first_name }} and {{ last_name }}, your_plan_name is ready.';
    const parsed = markdownToDoc(md);
    expect(parsed).toEqual(doc(p(t(md))));
    expect(JSON.stringify(parsed)).not.toContain('italic');
  });

  it('leaves unmatched delimiters as literal text', () => {
    expect(markdownToDoc('2 * 3 = 6')).toEqual(doc(p(t('2 * 3 = 6'))));
    expect(markdownToDoc('**unclosed')).toEqual(doc(p(t('**unclosed'))));
    expect(markdownToDoc('[label] but no target')).toEqual(doc(p(t('[label] but no target'))));
    expect(markdownToDoc('[label](unclosed')).toEqual(doc(p(t('[label](unclosed'))));
  });

  it('honours backslash escapes', () => {
    expect(markdownToDoc('\\*not emphasis\\*')).toEqual(doc(p(t('*not emphasis*'))));
    expect(markdownToDoc('\\# not a heading')).toEqual(doc(p(t('# not a heading'))));
    expect(markdownToDoc('back\\\\slash')).toEqual(doc(p(t('back\\slash'))));
  });

  it('parses hard breaks from a trailing backslash', () => {
    expect(markdownToDoc('one\\\ntwo')).toEqual(doc(p(t('one'), br, t('two'))));
  });

  it('treats an escaped backslash at the end of a line as text, not a hard break', () => {
    // `a\\` is a literal backslash: only an *odd* run ends in an unescaped one.
    expect(markdownToDoc('a\\\\\nb')).toEqual(doc(p(t('a\\ b'))));
    expect(markdownToDoc('a\\\\\\\nb')).toEqual(doc(p(t('a\\'), br, t('b'))));
  });

  it('joins soft-wrapped lines with a space', () => {
    expect(markdownToDoc('one\ntwo')).toEqual(doc(p(t('one two'))));
  });

  it('parses horizontal rules in every marker form', () => {
    for (const md of ['---', '***', '___', '- - -', '----------']) {
      expect(markdownToDoc(md)).toEqual(doc(hr));
    }
  });

  it('parses bullet lists with any marker and normalises them', () => {
    for (const marker of ['-', '*', '+']) {
      expect(markdownToDoc(`${marker} one\n${marker} two`)).toEqual(doc(ul(item('one'), item('two'))));
    }
  });

  it('parses ordered lists and keeps the starting number', () => {
    expect(markdownToDoc('1. one\n2. two')).toEqual(doc(ol(1, item('one'), item('two'))));
    expect(markdownToDoc('7. seven\n8. eight')).toEqual(doc(ol(7, item('seven'), item('eight'))));
  });

  it('starts a new list when the marker type changes', () => {
    expect(markdownToDoc('- bullet\n1. ordered')).toEqual(doc(ul(item('bullet')), ol(1, item('ordered'))));
  });

  it('parses nested lists at two-space and four-space indents, and with tabs', () => {
    const expected = doc(ul(li(p(t('one')), ul(item('nested')))));
    expect(markdownToDoc('- one\n  - nested')).toEqual(expected);
    expect(markdownToDoc('- one\n    - nested')).toEqual(expected);
    expect(markdownToDoc('- one\n\t- nested')).toEqual(expected);
  });

  it('parses a blockquote, including blank quoted lines and nesting', () => {
    expect(markdownToDoc('> a\n>\n> b')).toEqual(doc(quote(p(t('a')), p(t('b')))));
    expect(markdownToDoc('> > deep')).toEqual(doc(quote(quote(p(t('deep'))))));
    expect(markdownToDoc('>no space')).toEqual(doc(quote(p(t('no space')))));
  });

  it('parses a standalone image line as an image node', () => {
    expect(markdownToDoc('![Alt](https://cdn.example.com/a.png)')).toEqual(
      doc(image('https://cdn.example.com/a.png', 'Alt')),
    );
    expect(markdownToDoc('![](https://cdn.example.com/a.png)')).toEqual(
      doc(image('https://cdn.example.com/a.png', '')),
    );
  });

  it('degrades an inline image to its alt text — images are block level here', () => {
    expect(markdownToDoc('text ![Alt](https://cdn.example.com/a.png) more')).toEqual(
      doc(p(t('text Alt more'))),
    );
  });

  it('normalises CRLF line endings and a leading byte-order mark', () => {
    expect(markdownToDoc('﻿# Title\r\n\r\nBody.')).toEqual(doc(h(1, 'Title'), p(t('Body.'))));
  });

  it('collapses runs of blank lines between blocks', () => {
    expect(markdownToDoc('a\n\n\n\n\nb')).toEqual(doc(p(t('a')), p(t('b'))));
  });

  it('always produces a document that passes validation', () => {
    const inputs = [
      '',
      '# Title\n\nBody with a [link](https://example.com).',
      '- a\n- b\n\n> quote\n\n---',
      '![Alt](https://cdn.example.com/a.png)',
      '**bold** *italic* ***both***',
      'Weird ] brackets ( and ) parens [ everywhere',
      '#'.repeat(50),
      '- '.repeat(200),
      '>'.repeat(100) + ' deep',
      '\\',
      '[](https://example.com)',
      '[x]()',
      'a\\\n',
      everythingMarkdown,
    ];
    for (const input of inputs) {
      const result = validateEditorDoc(markdownToDoc(input));
      if (!result.ok) throw new Error(`${JSON.stringify(input).slice(0, 40)}: ${result.errors.join(' | ')}`);
      expect(result.ok).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* security — imported markdown is untrusted input                     */
/* ------------------------------------------------------------------ */

describe('markdownToDoc — untrusted input', () => {
  it('drops a javascript: link but keeps its visible text', () => {
    const parsed = markdownToDoc('[click me](javascript:alert(1))');
    expect(collectText(parsed)).toContain('click me');
    expect(collectLinks(parsed)).toEqual([]);
    expect(validateEditorDoc(parsed).ok).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    '/relative',
    'mailto:someone@example.com',
    // Parses to a real host, so only a protocol check catches it.
    'javascript://example.com/%0aalert(1)',
    'ftp://example.com/file.txt',
  ])('drops the unsafe link destination %j', (href) => {
    const parsed = markdownToDoc(`[label](${href})`);
    expect(collectLinks(parsed)).toEqual([]);
    expect(validateEditorDoc(parsed).ok).toBe(true);
  });

  it('keeps a safe link destination', () => {
    expect(collectLinks(markdownToDoc('[label](https://example.com/ok)'))).toEqual([
      { href: 'https://example.com/ok', index: 0 },
    ]);
  });

  it('degrades an unsafe image to its alt text and drops it when there is none', () => {
    const withAlt = markdownToDoc('![Alt text](javascript:alert(1))');
    expect(collectText(withAlt)).toBe('Alt text');
    expect(validateEditorDoc(withAlt).ok).toBe(true);

    const withoutAlt = markdownToDoc('![](data:image/gif;base64,R0lGOD)');
    expect(withoutAlt.content).toEqual([]);
  });

  it('never emits raw HTML as anything but text', () => {
    const parsed = markdownToDoc('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
    expect(validateEditorDoc(parsed).ok).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain('"html"');
    expect(collectText(parsed)).toContain('<script>alert(1)</script>');
  });

  it('produces only nodes from the closed set, whatever the input', () => {
    const parsed = markdownToDoc('# H\n\n```js\nalert(1)\n```\n\n| a | b |\n| - | - |\n\n- item');
    expect(validateEditorDoc(parsed).ok).toBe(true);
  });

  it('does not blow the stack on pathological nesting', () => {
    expect(() => markdownToDoc('>'.repeat(5000) + ' deep')).not.toThrow();
    expect(() => markdownToDoc('- '.repeat(5000) + 'deep')).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* interop with the other renderers                                    */
/* ------------------------------------------------------------------ */

describe('markdown interop', () => {
  it('keeps the plain-text rendering equivalent across a markdown round-trip', () => {
    expect(docToPlainText(markdownToDoc(docToMarkdown(everything)))).toBe(docToPlainText(everything));
  });

  it('produces markdown for the campaign fixture that still contains the unsubscribe placeholder', () => {
    expect(docToMarkdown(validCampaignDoc())).toContain('{{ unsubscribe_url }}');
  });
});
