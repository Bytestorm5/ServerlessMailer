import { beforeAll, describe, expect, it, vi } from 'vitest';
import { docToEmailHtml, docToMjml, renderMjml } from '@/lib/render/html';
import type { EmailChrome } from '@/lib/render/html';
import type { EditorDoc, EditorMark, EditorNode } from '@/lib/types';

/**
 * MJML rendering (spec §6.2, contracts §9).
 *
 * Two things are load-bearing here and both are tested against the *rendered*
 * output rather than the MJML source, because MJML and its CSS inliner both get
 * a chance to change the bytes after we hand them over:
 *
 *  1. Escaping. `mj-text`, `mj-preview` and `mj-title` are MJML "ending tags":
 *     their content is passed through the parser verbatim. Anything we fail to
 *     escape becomes live markup in 19,000 inboxes.
 *  2. Merge placeholders. The frozen body doubles as an SES template, so
 *     `{{first_name}}` must come out the far end byte-identical. If juice or
 *     cheerio ever mangles a brace, every recipient gets a broken send.
 *
 * Full renders cost a few hundred milliseconds each, so the expensive ones are
 * done once in `beforeAll` and asserted against many times.
 */

const ADDRESS = '1 Example Street, London, EC1A 1AA, United Kingdom';

function chromeWith(overrides: Partial<EmailChrome> = {}): EmailChrome {
  return {
    preheader: 'The short version, up top.',
    physicalAddress: ADDRESS,
    listName: 'Domain A Weekly',
    unsubscribePlaceholder: '{{unsubscribe_url}}',
    ...overrides,
  };
}

function makeDoc(...content: EditorNode[]): EditorDoc {
  return { type: 'doc', content };
}

function text(value: string, marks?: EditorMark[]): EditorNode {
  return marks ? { type: 'text', text: value, marks } : { type: 'text', text: value };
}

function para(...content: EditorNode[]): EditorNode {
  return { type: 'paragraph', content };
}

function link(href: string, label: string): EditorNode {
  return text(label, [{ type: 'link', attrs: { href } }]);
}

/** Extracts every `<a ...>` open tag from rendered HTML. */
function anchors(html: string): string[] {
  return html.match(/<a\b[^>]*>/g) ?? [];
}

/** Extracts every `<img ...>` tag from rendered HTML. */
function images(html: string): string[] {
  return html.match(/<img\b[^>]*>/g) ?? [];
}

/* ------------------------------------------------------------- docToMjml */

describe('docToMjml — structure', () => {
  it('emits a complete MJML document with a head and a body', () => {
    const src = docToMjml(makeDoc(para(text('Hello.'))), chromeWith());

    expect(src.startsWith('<mjml')).toBe(true);
    expect(src.trimEnd().endsWith('</mjml>')).toBe(true);
    expect(src).toContain('<mj-head>');
    expect(src).toContain('<mj-body');
  });

  it('inlines its CSS through mj-style inline="inline"', () => {
    // §6.2: "CSS inlined at render time". A non-inline <style> block is
    // stripped by Gmail, so the declaration matters.
    const src = docToMjml(makeDoc(para(text('Hello.'))), chromeWith());
    expect(src).toContain('<mj-style inline="inline">');
  });

  it('does not hand-author table markup — MJML owns the layout', () => {
    const src = docToMjml(makeDoc(para(text('Hello.'))), chromeWith());
    expect(src).not.toMatch(/<table\b/i);
    expect(src).not.toMatch(/<td\b/i);
  });
});

describe('docToMjml — escaping user text', () => {
  it('escapes all five HTML-significant characters in body text', () => {
    const src = docToMjml(
      makeDoc(para(text(`Ampersand & less < greater > quote " apostrophe '`))),
      chromeWith(),
    );

    expect(src).toContain('Ampersand &amp; less &lt; greater &gt; quote &quot; apostrophe &#39;');
    expect(src).not.toContain('less < greater');
  });

  it('neutralises a script tag typed into a heading', () => {
    // The single most important assertion in this file.
    const src = docToMjml(
      makeDoc({
        type: 'heading',
        attrs: { level: 2 },
        content: [text('<script>alert(1)</script>')],
      }),
      chromeWith(),
    );

    expect(src).not.toContain('<script>');
    expect(src).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes the preheader, which MJML passes through verbatim', () => {
    const src = docToMjml(
      makeDoc(para(text('Body.'))),
      chromeWith({ preheader: '</mj-preview><script>alert(1)</script> & more' }),
    );

    expect(src).not.toContain('<script>');
    expect(src).toContain('&lt;/mj-preview&gt;');
    expect(src).toContain('&amp; more');
    // Exactly one preview element — the injected close tag must not have
    // terminated ours early.
    expect(src.match(/<mj-preview>/g)).toHaveLength(1);
  });

  it('escapes the list name used as the document title', () => {
    const src = docToMjml(
      makeDoc(para(text('Body.'))),
      chromeWith({ listName: 'A & B <script>x</script>' }),
    );

    expect(src).not.toContain('<script>');
    expect(src).toContain('A &amp; B &lt;script&gt;');
  });

  it('escapes the physical address', () => {
    const src = docToMjml(
      makeDoc(para(text('Body.'))),
      chromeWith({ physicalAddress: 'Suite <1> & Co, "The Mews"' }),
    );

    expect(src).toContain('Suite &lt;1&gt; &amp; Co, &quot;The Mews&quot;');
    expect(src).not.toContain('Suite <1>');
  });

  it('strips control characters rather than emitting raw bytes', () => {
    const src = docToMjml(makeDoc(para(text('be\u0000fo\u0007re'))), chromeWith());

    expect(src).toContain('before');
    expect(src).not.toContain('\u0000');
    expect(src).not.toContain('\u0007');
  });
});

describe('docToMjml — escaping attribute values', () => {
  it('escapes an image src so it cannot break out of the attribute', () => {
    const src = docToMjml(
      makeDoc({
        type: 'image',
        attrs: { src: 'https://cdn.example.com/a.png?a=1&b=2" onerror="alert(1)', alt: 'x' },
      }),
      chromeWith(),
    );

    expect(src).not.toContain('onerror="alert(1)"');
    expect(src).toContain('&quot; onerror=&quot;alert(1)');
    expect(src).toContain('a=1&amp;b=2');
  });

  it('escapes an image alt attribute', () => {
    const src = docToMjml(
      makeDoc({
        type: 'image',
        attrs: { src: 'https://cdn.example.com/a.png', alt: 'An "alt" & <tag>' },
      }),
      chromeWith(),
    );

    expect(src).toContain('alt="An &quot;alt&quot; &amp; &lt;tag&gt;"');
  });

  it('escapes a link href so it cannot break out of the attribute', () => {
    const src = docToMjml(
      makeDoc(para(link('https://example.com/"><script>alert(1)</script>', 'Read'))),
      chromeWith(),
    );

    expect(src).not.toContain('<script>');
    expect(src).toContain('&quot;&gt;&lt;script&gt;');
  });
});

describe('docToMjml — dangerous URL schemes', () => {
  it.each([
    ['javascript:alert(1)'],
    ['JaVaScRiPt:alert(1)'],
    ['  javascript:alert(1)'],
    ['java\tscript:alert(1)'],
    ['java\nscript:alert(1)'],
    ['jav\u0000ascript:alert(1)'],
    ['jav ascript:alert(1)'],
    ['java\u00A0script:alert(1)'],
    ['data:text/html;base64,PHNjcmlwdD4='],
    ['vbscript:msgbox(1)'],
    ['file:///etc/passwd'],
  ])('neutralises %j in a link href', (href) => {
    const src = docToMjml(makeDoc(para(link(href, 'Click me'))), chromeWith());

    expect(src.toLowerCase()).not.toContain('javascript:');
    expect(src.toLowerCase()).not.toContain('vbscript:');
    expect(src.toLowerCase()).not.toContain('data:text/html');
    expect(src.toLowerCase()).not.toContain('file://');
    // The label survives; only the destination is defused.
    expect(src).toContain('Click me');
    expect(src).toContain('href="#"');
  });

  it('drops an image whose src uses a dangerous scheme', () => {
    const src = docToMjml(
      makeDoc({ type: 'image', attrs: { src: 'javascript:alert(1)', alt: 'x' } }),
      chromeWith(),
    );

    expect(src.toLowerCase()).not.toContain('javascript:');
    expect(src).not.toContain('<mj-image');
  });

  it.each([
    ['https://example.com/post'],
    ['http://example.com/post'],
    ['mailto:hello@example.com'],
    ['/relative/path'],
    ['#anchor'],
    ['{{unsubscribe_url}}'],
  ])('keeps the safe href %j intact', (href) => {
    const src = docToMjml(makeDoc(para(link(href, 'Link'))), chromeWith());
    expect(src).toContain(`href="${href}"`);
  });

  it('treats a non-string href as missing rather than crashing', () => {
    const src = docToMjml(
      makeDoc(para(text('Link', [{ type: 'link', attrs: { href: 42 } }]))),
      chromeWith(),
    );

    expect(src).toContain('href="#"');
    expect(src).toContain('Link');
  });
});

describe('docToMjml — node coverage', () => {
  it('renders headings at their declared level', () => {
    const src = docToMjml(
      makeDoc(
        { type: 'heading', attrs: { level: 1 }, content: [text('One')] },
        { type: 'heading', attrs: { level: 3 }, content: [text('Three')] },
      ),
      chromeWith(),
    );

    expect(src).toContain('<h1>One</h1>');
    expect(src).toContain('<h3>Three</h3>');
  });

  it.each([
    [undefined],
    [0],
    [7],
    [2.5],
    ['2'],
    ['1"><script>alert(1)</script'],
    [null],
  ])('clamps an out-of-range or hostile heading level %j', (level) => {
    const src = docToMjml(
      makeDoc({ type: 'heading', attrs: { level }, content: [text('Title')] }),
      chromeWith(),
    );

    expect(src).not.toContain('<script>');
    expect(src).toMatch(/<h[1-6]>Title<\/h[1-6]>/);
  });

  it('renders bold, italic and link marks', () => {
    const src = docToMjml(
      makeDoc(
        para(
          text('bold', [{ type: 'bold' }]),
          text('italic', [{ type: 'italic' }]),
          link('https://example.com', 'linked'),
        ),
      ),
      chromeWith(),
    );

    expect(src).toContain('<strong>bold</strong>');
    expect(src).toContain('<em>italic</em>');
    expect(src).toContain('>linked</a>');
  });

  it('nests bold inside a link when both marks are present', () => {
    const src = docToMjml(
      makeDoc(
        para(
          text('both', [
            { type: 'bold' },
            { type: 'link', attrs: { href: 'https://example.com' } },
          ]),
        ),
      ),
      chromeWith(),
    );

    expect(src).toMatch(/<a\b[^>]*><strong>both<\/strong><\/a>/);
  });

  it('ignores unknown mark types instead of emitting them', () => {
    const src = docToMjml(
      makeDoc(para(text('plain', [{ type: 'onmouseover' }, { type: 'script' }]))),
      chromeWith(),
    );

    expect(src).toContain('plain');
    expect(src).not.toContain('<onmouseover>');
    expect(src).not.toContain('<script>');
  });

  it('renders bullet and ordered lists, including nesting', () => {
    const src = docToMjml(
      makeDoc(
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                para(text('outer')),
                {
                  type: 'orderedList',
                  content: [{ type: 'listItem', content: [para(text('inner'))] }],
                },
              ],
            },
          ],
        },
      ),
      chromeWith(),
    );

    expect(src).toContain('<ul>');
    expect(src).toContain('<ol>');
    expect(src).toContain('outer');
    expect(src).toContain('inner');
    expect(src.indexOf('<ol>')).toBeGreaterThan(src.indexOf('<ul>'));
  });

  it('renders a blockquote with its inner paragraphs', () => {
    const src = docToMjml(
      makeDoc({
        type: 'blockquote',
        content: [para(text('Quoted & noted'))],
      }),
      chromeWith(),
    );

    expect(src).toContain('<blockquote>');
    expect(src).toContain('Quoted &amp; noted');
  });

  it('renders a horizontal rule as an mj-divider', () => {
    const src = docToMjml(makeDoc({ type: 'horizontalRule' }), chromeWith());
    expect(src).toContain('<mj-divider');
    expect(src).not.toContain('<hr>');
  });

  it('renders a hard break as a <br />', () => {
    const src = docToMjml(
      makeDoc(para(text('one'), { type: 'hardBreak' }, text('two'))),
      chromeWith(),
    );

    expect(src).toContain('one<br />two');
  });

  it('renders a block-level image as an mj-image', () => {
    const src = docToMjml(
      makeDoc({
        type: 'image',
        attrs: { src: 'https://cdn.example.com/a.png', alt: 'A photo' },
      }),
      chromeWith(),
    );

    expect(src).toContain('<mj-image');
    expect(src).toContain('src="https://cdn.example.com/a.png"');
    expect(src).toContain('alt="A photo"');
  });

  it('renders an image with no alt attribute as alt=""', () => {
    const src = docToMjml(
      makeDoc({ type: 'image', attrs: { src: 'https://cdn.example.com/a.png' } }),
      chromeWith(),
    );

    expect(src).toContain('alt=""');
  });

  it('coerces a non-string alt to an empty attribute', () => {
    const src = docToMjml(
      makeDoc({ type: 'image', attrs: { src: 'https://cdn.example.com/a.png', alt: 42 } }),
      chromeWith(),
    );

    expect(src).toContain('alt=""');
    expect(src).not.toContain('alt="42"');
  });

  it('renders an image nested inside a paragraph as an inline img', () => {
    const src = docToMjml(
      makeDoc(
        para(text('Before '), {
          type: 'image',
          attrs: { src: 'https://cdn.example.com/inline.png', alt: 'In "line" & such' },
        }),
      ),
      chromeWith(),
    );

    expect(src).toContain('<img src="https://cdn.example.com/inline.png"');
    expect(src).toContain('alt="In &quot;line&quot; &amp; such"');
  });

  it('drops an inline image whose src uses a dangerous scheme', () => {
    const src = docToMjml(
      makeDoc(para(text('Before '), { type: 'image', attrs: { src: 'javascript:alert(1)' } })),
      chromeWith(),
    );

    expect(src.toLowerCase()).not.toContain('javascript:');
    expect(src).not.toContain('<img');
    expect(src).toContain('Before');
  });

  it('keeps the text of an unknown inline node but never its tag name', () => {
    const src = docToMjml(
      makeDoc(para(text('safe '), { type: 'object', content: [text('smuggled')] })),
      chromeWith(),
    );

    expect(src).toContain('safe smuggled');
    expect(src).not.toContain('<object');
  });

  it('renders a horizontal rule nested inside a blockquote as an <hr />', () => {
    const src = docToMjml(
      makeDoc({
        type: 'blockquote',
        content: [para(text('above')), { type: 'horizontalRule' }, para(text('below'))],
      }),
      chromeWith(),
    );

    expect(src).toContain('<hr />');
    expect(src).toContain('above');
    expect(src).toContain('below');
  });

  it('renders a list item whose child is a block other than a paragraph', () => {
    const src = docToMjml(
      makeDoc({
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [{ type: 'blockquote', content: [para(text('quoted item'))] }],
          },
        ],
      }),
      chromeWith(),
    );

    expect(src).toContain('<li><blockquote><p>quoted item</p></blockquote></li>');
  });

  it('tolerates a list whose children are not listItem nodes', () => {
    const src = docToMjml(
      makeDoc({ type: 'bulletList', content: [para(text('stray'))] }),
      chromeWith(),
    );

    expect(src).toContain('stray');
    expect(src).toContain('<ul>');
  });

  it('emits nothing for a list with no items', () => {
    const src = docToMjml(makeDoc({ type: 'bulletList', content: [] }), chromeWith());

    expect(src).not.toContain('<ul>');
    expect(src).toContain(ADDRESS);
  });

  it('ignores null and non-object entries in a content array', () => {
    const hostile = {
      type: 'doc',
      content: [
        null,
        'just a string',
        para(text('survivor'), null as unknown as EditorNode),
        { type: 'bulletList', content: [null] },
      ],
    } as unknown as EditorDoc;

    const src = docToMjml(hostile, chromeWith());

    expect(src).toContain('survivor');
    expect(src).toContain(ADDRESS);
  });

  it('applies no wrapping for an empty marks array', () => {
    const src = docToMjml(makeDoc(para(text('bare', []))), chromeWith());

    expect(src).toContain('<p>bare</p>');
  });

  it('skips an image with no src at all', () => {
    const src = docToMjml(makeDoc({ type: 'image', attrs: {} }), chromeWith());
    expect(src).not.toContain('<mj-image');
  });

  it('keeps the text of an unknown node but never its tag name', () => {
    // The node set is closed (§6.1); an unvalidated doc is an injection
    // vector, so an unknown type must degrade to plain text.
    const src = docToMjml(
      makeDoc({ type: 'iframe', content: [text('smuggled')] }),
      chromeWith(),
    );

    expect(src).toContain('smuggled');
    expect(src).not.toContain('<iframe');
  });

  it('survives a paragraph with no content and a text node with no text', () => {
    const src = docToMjml(
      makeDoc(para(), { type: 'paragraph', content: [{ type: 'text' }] }),
      chromeWith(),
    );

    expect(src).toContain('<mjml');
    expect(src).toContain(ADDRESS);
  });

  it('survives a doc with no content array at all', () => {
    const src = docToMjml({ type: 'doc' } as unknown as EditorDoc, chromeWith());

    expect(src).toContain('<mjml');
    expect(src).toContain(ADDRESS);
  });
});

describe('docToMjml — legally required chrome', () => {
  it('includes the physical postal address even for an empty document', () => {
    const src = docToMjml(makeDoc(), chromeWith());
    expect(src).toContain(ADDRESS);
  });

  it('includes an unsubscribe link built from the placeholder', () => {
    const src = docToMjml(makeDoc(para(text('Hi'))), chromeWith());

    expect(src).toContain('href="{{unsubscribe_url}}"');
    expect(src).toMatch(/Unsubscribe/i);
  });

  it('uses a resolved URL when preview passes a real unsubscribe link', () => {
    const url = 'https://mail.example.com/api/unsubscribe?t=abc';
    const src = docToMjml(
      makeDoc(para(text('Hi'))),
      chromeWith({ unsubscribePlaceholder: url }),
    );

    expect(src).toContain(`href="${url}"`);
  });

  it('falls back to the standard placeholder when none is supplied', () => {
    // Fail closed: an email without an unsubscribe link is illegal, so an
    // empty placeholder must not produce a footer without one.
    const src = docToMjml(
      makeDoc(para(text('Hi'))),
      chromeWith({ unsubscribePlaceholder: '' }),
    );

    expect(src).toContain('href="{{unsubscribe_url}}"');
  });

  it('omits the preview element when there is no preheader', () => {
    const src = docToMjml(makeDoc(para(text('Hi'))), chromeWith({ preheader: undefined }));
    expect(src).not.toContain('<mj-preview>');
  });

  it('omits the open pixel unless one is supplied', () => {
    expect(docToMjml(makeDoc(para(text('Hi'))), chromeWith())).not.toContain('<img');
  });

  it('omits the open pixel when its URL uses a dangerous scheme', () => {
    const src = docToMjml(
      makeDoc(para(text('Hi'))),
      chromeWith({ openPixelUrl: 'javascript:alert(1)' }),
    );

    expect(src).not.toContain('<img');
    expect(src.toLowerCase()).not.toContain('javascript:');
  });

  it('splits a multi-line postal address onto separate lines', () => {
    const src = docToMjml(
      makeDoc(para(text('Hi'))),
      chromeWith({ physicalAddress: 'Acme Ltd\n\n1 Example Street\nLondon' }),
    );

    expect(src).toContain('Acme Ltd<br />1 Example Street<br />London');
  });

  it('still renders the unsubscribe link when the chrome fields are the wrong type', () => {
    // Fail closed: a malformed list document must not silently produce an
    // email that is illegal to send.
    const src = docToMjml(
      makeDoc(para(text('Hi'))),
      {
        preheader: 12 as unknown as string,
        physicalAddress: null as unknown as string,
        listName: undefined as unknown as string,
        unsubscribePlaceholder: '{{unsubscribe_url}}',
      },
    );

    expect(src).toContain('href="{{unsubscribe_url}}"');
    expect(src).not.toContain('<mj-preview>');
    expect(src).not.toContain('<mj-title>');
  });
});

describe('docToMjml — merge placeholders', () => {
  it('leaves bare SES placeholders untouched', () => {
    const src = docToMjml(
      makeDoc(para(text('Hi {{first_name}}, from {{list_name}}.'))),
      chromeWith(),
    );

    expect(src).toContain('Hi {{first_name}}, from {{list_name}}.');
  });

  it('leaves placeholders inside link hrefs untouched', () => {
    const src = docToMjml(
      makeDoc(
        para(link('https://mail.example.com/api/t/c/tok?r={{recipient_token}}', 'Go')),
      ),
      chromeWith(),
    );

    expect(src).toContain('href="https://mail.example.com/api/t/c/tok?r={{recipient_token}}"');
  });
});

/* ------------------------------------------------------------ renderMjml */

describe('renderMjml', () => {
  it('renders valid MJML to a complete HTML document with no errors', async () => {
    const result = await renderMjml(
      '<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>',
    );

    expect(result.errors).toEqual([]);
    expect(result.html).toMatch(/^<!doctype html>/i);
    expect(result.html).toContain('Hi');
  });

  it('reports unknown MJML elements as errors rather than throwing', async () => {
    const result = await renderMjml(
      '<mjml><mj-body><mj-section><mj-column><mj-bogus>x</mj-bogus></mj-column></mj-section></mj-body></mjml>',
    );

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join(' ')).toContain('mj-bogus');
  });

  it('turns an unparseable source into an error instead of an exception', async () => {
    const result = await renderMjml('not mjml at all');

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.html).toBe('');
  });

  it('treats an empty source as an error, never as a valid email', async () => {
    const result = await renderMjml('');

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.html).toBe('');
  });

  it('reports a failure to load MJML itself rather than throwing', async () => {
    vi.resetModules();
    vi.doMock('mjml', () => {
      throw new Error('Cannot find module mjml');
    });

    try {
      const mod = await import('@/lib/render/html');
      // The contract is "resolves with an error", not "rejects" — callers have
      // exactly one error path, and a failed import must not become an
      // unhandled rejection inside the freeze step.
      const result = await mod.renderMjml('<mjml><mj-body /></mjml>');

      expect(result.html).toBe('');
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].length).toBeGreaterThan(0);
    } finally {
      vi.doUnmock('mjml');
      vi.resetModules();
    }
  });

  it('describes errors that carry no line or tag, and normalises a malformed result', async () => {
    vi.resetModules();
    vi.doMock('mjml', () => ({
      default: async () => ({
        // No `html` string and no `errors` array — a shape mjml should never
        // produce, but one that must not crash the freeze step if it does.
        errors: undefined,
      }),
    }));

    try {
      const mod = await import('@/lib/render/html');
      const result = await mod.renderMjml('<mjml><mj-body /></mjml>');

      expect(result.html).toBe('');
      expect(result.errors).toEqual([]);
    } finally {
      vi.doUnmock('mjml');
      vi.resetModules();
    }
  });

  it('falls back through message, formattedMessage and a generic description', async () => {
    vi.resetModules();
    vi.doMock('mjml', () => ({
      default: async () => ({
        html: '<html></html>',
        json: {},
        errors: [
          { message: 'plain message with no location' },
          { formattedMessage: 'only formatted', line: 4 },
          {},
        ],
      }),
    }));

    try {
      const mod = await import('@/lib/render/html');
      const result = await mod.renderMjml('<mjml><mj-body /></mjml>');

      expect(result.errors).toEqual([
        'plain message with no location',
        'line 4: only formatted',
        'unknown MJML error',
      ]);
    } finally {
      vi.doUnmock('mjml');
      vi.resetModules();
    }
  });
});

/* -------------------------------------------------------- docToEmailHtml */

const kitchenSink: EditorDoc = makeDoc(
  { type: 'heading', attrs: { level: 2 }, content: [text('<script>alert(1)</script> & co')] },
  para(text(`Hi {{first_name}}, welcome — "quoted" & 'apostrophed'.`)),
  para(link('https://example.com/post?a=1&b=2', 'Read more')),
  para(link('javascript:alert(1)', 'Do not click')),
  {
    type: 'bulletList',
    content: [{ type: 'listItem', content: [para(text('First & foremost'))] }],
  },
  { type: 'blockquote', content: [para(text('Quoted <b>text</b>'))] },
  { type: 'horizontalRule' },
  {
    type: 'image',
    attrs: { src: 'https://cdn.example.com/hero.png?v=1&w=2', alt: 'Hero "image" & more' },
  },
);

describe('docToEmailHtml', () => {
  let rendered = '';
  let empty = '';

  beforeAll(async () => {
    // Both resolving at all is itself an assertion: docToEmailHtml throws when
    // MJML reports any error, so a clean resolve proves every escaped value
    // still produced well-formed MJML.
    rendered = await docToEmailHtml(
      kitchenSink,
      chromeWith({
        openPixelUrl: 'https://mail.example.com/api/t/o/{{recipient_token}}',
      }),
    );
    empty = await docToEmailHtml(makeDoc(), chromeWith({ preheader: undefined }));
  });

  it('returns a complete HTML document', async () => {
    expect(rendered).toMatch(/^<!doctype html>/i);
    expect(rendered).toContain('<html');
    expect(rendered.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('never emits live script markup from user text', async () => {
    expect(rendered).not.toMatch(/<script/i);
    expect(rendered).toContain('&lt;script&gt;');
  });

  it('escapes quotes and ampersands in the delivered HTML', async () => {
    expect(rendered).toContain('&quot;quoted&quot;');
    expect(rendered).toContain('&#39;apostrophed&#39;');
    expect(rendered).toContain('Quoted &lt;b&gt;text&lt;/b&gt;');
  });

  it('keeps merge placeholders byte-identical through MJML and the CSS inliner', async () => {
    // The frozen HTML is handed to SES as a template. A mangled brace here
    // breaks every recipient of the send.
    expect(rendered).toContain('{{first_name}}');
    expect(rendered).toContain('{{unsubscribe_url}}');
    expect(rendered).toContain('{{recipient_token}}');
    expect(rendered).not.toContain('%7B%7B');
    expect(rendered).not.toContain('&#123;');
  });

  it('always carries the physical postal address', async () => {
    expect(rendered).toContain(ADDRESS);
    expect(empty).toContain(ADDRESS);
  });

  it('always carries an unsubscribe link built from the placeholder', async () => {
    const unsubscribe = anchors(rendered).filter((a) => a.includes('{{unsubscribe_url}}'));
    expect(unsubscribe.length).toBeGreaterThan(0);
    expect(anchors(empty).some((a) => a.includes('{{unsubscribe_url}}'))).toBe(true);
  });

  it('inlines its CSS so Gmail cannot strip the styling', async () => {
    const unsubscribe = anchors(rendered).find((a) => a.includes('{{unsubscribe_url}}'));
    expect(unsubscribe).toBeDefined();
    expect(unsubscribe).toMatch(/style="[^"]+"/);
  });

  it('renders the preheader as hidden preview text at the top of the body', async () => {
    const preview = rendered.match(
      /<div[^>]*display:none[^>]*>\s*The short version, up top\.\s*<\/div>/,
    );
    expect(preview).not.toBeNull();

    // Ahead of the body copy, which is what makes it the inbox preview.
    expect(rendered.indexOf('The short version, up top.')).toBeLessThan(
      rendered.indexOf('{{first_name}}'),
    );
  });

  it('renders the open pixel as a 1x1 image only when supplied', async () => {
    const pixel = images(rendered).find((img) => img.includes('/api/t/o/'));
    expect(pixel).toBeDefined();
    expect(pixel).toMatch(/width="1"/);
    expect(pixel).toMatch(/height="1"/);

    expect(images(empty).some((img) => img.includes('/api/t/o/'))).toBe(false);
  });

  it('defuses a dangerous href while preserving safe ones', async () => {
    expect(rendered.toLowerCase()).not.toContain('javascript:');
    expect(rendered).toContain('https://example.com/post?a=1&amp;b=2');
    expect(rendered).toContain('Do not click');
  });

  it('renders the structural nodes MJML is responsible for', async () => {
    expect(rendered).toMatch(/<h2\b/);
    expect(rendered).toContain('<ul');
    expect(rendered).toContain('<blockquote');
    expect(images(rendered).some((img) => img.includes('hero.png'))).toBe(true);
  });

  it('throws a descriptive error when MJML reports errors', async () => {
    vi.resetModules();
    vi.doMock('mjml', () => ({
      default: async () => ({
        html: '<html>partial</html>',
        json: {},
        errors: [
          {
            line: 3,
            message: "Element mj-bogus doesn't exist or is not registered",
            tagName: 'mj-bogus',
            formattedMessage: 'Line 3 (mj-bogus)',
          },
        ],
      }),
    }));

    try {
      const mod = await import('@/lib/render/html');
      await expect(
        mod.docToEmailHtml(makeDoc(para(text('Hi'))), chromeWith()),
      ).rejects.toThrow(/mj-bogus/);
    } finally {
      vi.doUnmock('mjml');
      vi.resetModules();
    }
  });
});
