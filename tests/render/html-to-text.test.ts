import { describe, expect, it } from 'vitest';
import { htmlToPlainText } from '@/lib/render/text';

/**
 * The plain-text alternative for a pasted HTML body (§6.2).
 *
 * Same contract as `docToPlainText`, from the other direction: never empty for
 * a non-empty body, never silently deletes a URL, and never touches a merge
 * placeholder — the text part is frozen as an SES template too.
 */

describe('htmlToPlainText', () => {
  it('returns nothing for nothing', () => {
    expect(htmlToPlainText('')).toBe('');
    expect(htmlToPlainText(undefined as unknown as string)).toBe('');
    expect(htmlToPlainText('<div>  </div>')).toBe('');
  });

  it('separates block elements and collapses source formatting', () => {
    expect(
      htmlToPlainText('<h2>Weekly update</h2>\n  <p>First line.</p>\n  <p>Second line.</p>'),
    ).toBe('Weekly update\n\nFirst line.\n\nSecond line.');
  });

  it('breaks on <br> without starting a new paragraph', () => {
    expect(htmlToPlainText('<p>One<br />Two</p>')).toBe('One\nTwo');
  });

  it('keeps a link URL, because the URL is the payload', () => {
    expect(htmlToPlainText('<p>Please <a href="https://example.com/post">read more</a>.</p>')).toBe(
      'Please read more (https://example.com/post).',
    );
  });

  it('does not print a URL twice when it is already the link text', () => {
    expect(htmlToPlainText('<a href="https://example.com">https://example.com</a>')).toBe(
      'https://example.com',
    );
  });

  it('renders a list with markers', () => {
    expect(htmlToPlainText('<ul><li>One</li><li>Two</li></ul>')).toBe('- One\n\n- Two');
  });

  it('reads a table layout as prose rather than one run-on line', () => {
    expect(
      htmlToPlainText('<table><tr><td>Left cell</td><td>Right cell</td></tr></table>'),
    ).toBe('Left cell\n\nRight cell');
  });

  it('keeps an image that says something and drops a spacer that does not', () => {
    expect(htmlToPlainText('<img src="https://a.test/1.png" alt="Our logo">')).toBe(
      '[Image: Our logo] (https://a.test/1.png)',
    );
    expect(htmlToPlainText('<p>Hi</p><img src="https://a.test/spacer.gif" alt="">')).toBe('Hi');
  });

  it('renders a horizontal rule as a divider', () => {
    expect(htmlToPlainText('<p>a</p><hr /><p>b</p>')).toBe(`a\n\n${'-'.repeat(32)}\n\nb`);
  });

  it('drops style, script and title content', () => {
    expect(
      htmlToPlainText(
        '<head><title>Subject</title><style>p{color:red}</style></head><body><p>Body</p></body>',
      ),
    ).toBe('Body');
  });

  it('leaves merge placeholders untouched', () => {
    expect(htmlToPlainText('<p>Hello {{ first_name | default: "there" }}.</p>')).toBe(
      'Hello {{ first_name | default: "there" }}.',
    );
  });

  it('decodes entities, case included', () => {
    expect(htmlToPlainText('<p>Caf&eacute; &amp; bar&nbsp;&mdash; open</p>')).toBe(
      'Café & bar — open',
    );
    // `&Auml;` is Ä and `&auml;` is ä — a case-insensitive table gets one wrong.
    expect(htmlToPlainText('<p>&Auml;&auml;</p>')).toBe('Ää');
  });

  it('does not lose text inside markup it does not model', () => {
    expect(htmlToPlainText('<v:roundrect><span>Button label</span></v:roundrect>')).toBe(
      'Button label',
    );
  });
});
