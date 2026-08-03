import { describe, expect, it } from 'vitest';
import {
  collectHtmlImages,
  collectHtmlLinks,
  decodeHtmlEntities,
  htmlTextContent,
  isEmptyHtml,
  isFullHtmlDocument,
  isImageOnlyHtml,
  isSafeAttributeUrl,
  mapHtmlLinks,
  sanitizeEmailHtml,
  serializeTokens,
  tokenize,
} from '@/lib/render/sanitize';

/**
 * Operator-authored HTML (§6.2a).
 *
 * The interesting cases are not "does it strip a script" — they are the ones
 * where stripping too much would break a real email template, and the ones
 * where a naive parser lets something through: raw-text elements, MSO
 * conditional comments, namespaced VML tags, and every spelling of an unsafe
 * URL that a mail client normalises before following.
 */

describe('tokenize / serializeTokens', () => {
  it('round-trips ordinary markup byte for byte', () => {
    const source =
      '<!DOCTYPE html><html><body><p class="x" data-y=\'z\'>Hi<br />there</p><!-- note --></body></html>';
    expect(serializeTokens(tokenize(source))).toBe(source);
  });

  it('treats a lone angle bracket in prose as text, not a tag', () => {
    const tokens = tokenize('<p>2 < 3 and a > b</p>');
    expect(tokens.filter((t) => t.kind === 'tag')).toHaveLength(2);
    expect(serializeTokens(tokens)).toBe('<p>2 < 3 and a > b</p>');
  });

  it('does not parse markup inside a raw-text element', () => {
    // `<style>a{content:"<b>"}</style>` must not reopen the document as bold.
    const tokens = tokenize('<style>p::after{content:"<b>"}</style><p>after</p>');
    const names = tokens.filter((t) => t.kind === 'tag').map((t) => t.name);
    expect(names).toEqual(['style', 'style', 'p', 'p']);
  });

  it('ends a raw-text element only on its own closing tag', () => {
    const source = '<style>.styles { color: red }</style>';
    expect(serializeTokens(tokenize(source))).toBe(source);
  });

  it('keeps a quoted attribute value containing a closing bracket', () => {
    // A merge fallback with an angle bracket in it is ordinary prose, and the
    // `>` inside the quotes must not be read as the end of the tag.
    const source = "<a title='{{ x | default: \"a > b\" }}' href='https://e.test'>x</a>";
    const tag = tokenize(source).find((t) => t.kind === 'tag');

    expect(tag).toMatchObject({ name: 'a' });
    expect(tag && tag.kind === 'tag' && tag.attributes[0].value).toContain('a > b');
    expect(serializeTokens(tokenize(source))).toBe(source);
  });

  it('survives an unterminated attribute quote without losing the document', () => {
    expect(() => tokenize('<a href="https://e.test>text')).not.toThrow();
  });

  it('keeps bare attributes distinct from empty ones', () => {
    const tokens = tokenize('<td nowrap align="">x</td>');
    const tag = tokens.find((t) => t.kind === 'tag');
    expect(tag && tag.kind === 'tag' && tag.attributes).toEqual([
      { name: 'nowrap', value: null, quote: '' },
      { name: 'align', value: '', quote: '"' },
    ]);
  });

  it('reads namespaced tag names whole', () => {
    const tokens = tokenize('<v:roundrect arcsize="10%"><o:p>x</o:p></v:roundrect>');
    const names = tokens.filter((t) => t.kind === 'tag').map((t) => t.name);
    expect(names).toEqual(['v:roundrect', 'o:p', 'o:p', 'v:roundrect']);
  });

  it('returns nothing for a non-string or empty input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(undefined as unknown as string)).toEqual([]);
  });
});

describe('sanitizeEmailHtml — what it removes', () => {
  it('drops a script element and everything inside it', () => {
    const { html, removed } = sanitizeEmailHtml('<p>a</p><script>alert(1)</script><p>b</p>');
    expect(html).toBe('<p>a</p><p>b</p>');
    expect(removed).toContain('<script>');
  });

  it('drops event handlers however they are spelled', () => {
    const { html, removed } = sanitizeEmailHtml(
      '<img src="https://e.test/a.png" OnErRoR = "alert(1)" onclick=x />',
    );
    expect(html).not.toMatch(/onerror|onclick/i);
    expect(html).toContain('src="https://e.test/a.png"');
    expect(removed.some((entry) => entry.includes('onerror'))).toBe(true);
  });

  it('drops a javascript: href hidden behind whitespace', () => {
    // A mail client discards the tab before following the link.
    const { html } = sanitizeEmailHtml('<a href="java\tscript:alert(1)">x</a>');
    expect(html).toBe('<a>x</a>');
  });

  it('drops base and link, which rewrite or fetch for the whole document', () => {
    const { html, removed } = sanitizeEmailHtml(
      '<head><base href="https://evil.test/" /><link rel="stylesheet" href="https://evil.test/a.css" /></head>',
    );
    expect(html).toBe('<head></head>');
    expect(removed).toEqual(expect.arrayContaining(['<base>', '<link>']));
  });

  it('drops a meta refresh but keeps the charset and viewport', () => {
    const { html } = sanitizeEmailHtml(
      '<meta charset="utf-8" /><meta http-equiv="refresh" content="0;url=https://evil.test" />',
    );
    expect(html).toContain('charset="utf-8"');
    expect(html).not.toContain('refresh');
  });

  it('drops a form and its controls', () => {
    const { html } = sanitizeEmailHtml(
      '<p>before</p><form action="https://evil.test"><input name="password" /></form><p>after</p>',
    );
    expect(html).toBe('<p>before</p><p>after</p>');
  });

  it('neutralises executable CSS in a style attribute and a style block', () => {
    const { html, removed } = sanitizeEmailHtml(
      '<style>@import url(https://evil.test/a.css); b { behavior: url(#x) }</style>' +
        '<div style="width:expression(alert(1));color:red">x</div>',
    );
    expect(html).not.toMatch(/@import|behavior:|expression\(/);
    expect(html).toContain('color:red');
    expect(removed.length).toBeGreaterThan(0);
  });

  it('counts nesting so a dropped element does not swallow the rest', () => {
    const { html } = sanitizeEmailHtml(
      '<div><form><div><form></form></div></form><p>kept</p></div>',
    );
    expect(html).toContain('<p>kept</p>');
  });

  it('returns an empty result for empty input', () => {
    expect(sanitizeEmailHtml('')).toEqual({ html: '', removed: [] });
    expect(sanitizeEmailHtml(null as unknown as string).html).toBe('');
  });
});

describe('sanitizeEmailHtml — what it keeps', () => {
  it('keeps the table-and-inline-style markup an email is actually made of', () => {
    const source =
      '<table role="presentation" width="600" cellpadding="0" bgcolor="#59334D">' +
      '<tr><td style="padding:24px;font-family:Georgia,serif;">Hi</td></tr></table>';
    expect(sanitizeEmailHtml(source).html).toBe(source);
  });

  it('keeps MSO conditional comments and VML', () => {
    const source =
      '<!--[if mso]><v:roundrect arcsize="8%" fillcolor="#975077"><w:anchorlock/></v:roundrect><![endif]-->';
    expect(sanitizeEmailHtml(source).html).toBe(source);
  });

  it('keeps merge placeholders byte for byte, including in attributes', () => {
    const source =
      '<a href="{{unsubscribe_url}}">Unsubscribe</a>' +
      '<p title="{{ first_name | default: &quot;there&quot; }}">{{ first_name | default: "there" }}</p>';
    expect(sanitizeEmailHtml(source).html).toBe(source);
  });

  it('keeps the doctype, so the document does not render in quirks mode', () => {
    expect(sanitizeEmailHtml('<!DOCTYPE html><html></html>').html).toContain('<!DOCTYPE html>');
  });

  it('keeps an inline data: image but not a data: document', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(sanitizeEmailHtml(`<img src="${png}" />`).html).toContain(png);
    expect(sanitizeEmailHtml('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>').html).toBe(
      '<a>x</a>',
    );
  });
});

describe('isSafeAttributeUrl', () => {
  it.each([
    ['https://example.com/a?b=1', true],
    ['http://example.com', true],
    ['mailto:hi@example.com', true],
    ['tel:+441234567890', true],
    ['cid:logo', true],
    ['/relative/path', true],
    ['#anchor', true],
    ['{{unsubscribe_url}}', true],
    ['', true],
    ['javascript:alert(1)', false],
    ['JaVaScRiPt:alert(1)', false],
    ['vbscript:msgbox', false],
    ['data:text/html,<script>', false],
  ])('%s → %s', (value, expected) => {
    expect(isSafeAttributeUrl(value)).toBe(expected);
  });
});

describe('link collection and rewriting', () => {
  const source =
    '<a href="https://a.test/x?p=1&amp;q=2">one</a>' +
    '<a href="mailto:hi@a.test">mail</a>' +
    '<a href="{{unsubscribe_url}}">out</a>' +
    '<a href="https://b.test">two</a>';

  it('collects every href, decoded', () => {
    expect(collectHtmlLinks(source)).toEqual([
      'https://a.test/x?p=1&q=2',
      'mailto:hi@a.test',
      '{{unsubscribe_url}}',
      'https://b.test',
    ]);
  });

  it('rewrites only trackable links, and indexes those alone', () => {
    const seen: [string, number][] = [];
    const out = mapHtmlLinks(source, (href, index) => {
      seen.push([href, index]);
      return `https://track.test/${index}`;
    });

    // mailto: and the unsubscribe placeholder are left alone — routing
    // one-click unsubscribe through a redirector would break it.
    expect(seen).toEqual([
      ['https://a.test/x?p=1&q=2', 0],
      ['https://b.test', 1],
    ]);
    expect(out).toContain('href="mailto:hi@a.test"');
    expect(out).toContain('href="{{unsubscribe_url}}"');
    expect(out).toContain('https://track.test/0');
  });

  it('re-escapes a rewritten href and quotes a bare attribute', () => {
    const out = mapHtmlLinks('<a href=https://a.test>x</a>', () => 'https://t.test/a?b=1&c=2');
    expect(out).toContain('href="https://t.test/a?b=1&amp;c=2"');
  });

  it('collects images', () => {
    expect(collectHtmlImages('<img src="https://a.test/1.png"><img src=" ">')).toEqual([
      'https://a.test/1.png',
    ]);
  });
});

describe('text extraction', () => {
  it('reads the visible text, skipping markup and style', () => {
    expect(
      htmlTextContent('<style>p{color:red}</style><p>Hello <b>there</b></p><!-- hidden -->'),
    ).toBe('Hello there');
  });

  it('decodes entities and drops zero-width padding', () => {
    expect(htmlTextContent('<p>caf&eacute;&nbsp;&amp;&#8203; bar &#x2014;</p>')).toBe(
      'café & bar —',
    );
  });

  it('leaves an unknown entity alone rather than guessing', () => {
    expect(decodeHtmlEntities('&notanentity; &#999999999999;')).toBe(
      '&notanentity; &#999999999999;',
    );
  });

  it('knows an empty body from an image-only one', () => {
    expect(isEmptyHtml('<div>   </div>')).toBe(true);
    expect(isEmptyHtml('<img src="https://a.test/1.png">')).toBe(false);
    expect(isImageOnlyHtml('<img src="https://a.test/1.png" alt="a spam signal">')).toBe(true);
    expect(isImageOnlyHtml('<p>words</p><img src="https://a.test/1.png">')).toBe(false);
  });
});

describe('isFullHtmlDocument', () => {
  it.each([
    ['<!DOCTYPE html><html><body>x</body></html>', true],
    ['<html lang="en">x</html>', true],
    ['<p>just a fragment</p>', false],
    ['<table><tr><td>layout</td></tr></table>', false],
  ])('%s → %s', (value, expected) => {
    expect(isFullHtmlDocument(value)).toBe(expected);
  });
});
