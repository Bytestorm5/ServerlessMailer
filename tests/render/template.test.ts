import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATE_HTML,
  MAX_TEMPLATE_LENGTH,
  TEMPLATE_PLACEHOLDERS,
  TemplateRenderError,
  applyTemplate,
  hasContentSlot,
  renderEmailDocument,
  stripTemplateOnlyPlaceholders,
  validateTemplateHtml,
} from '@/lib/render/template';
import type { EmailChrome } from '@/lib/render/html';

/**
 * Hand-authored templates (§6.2a).
 *
 * The load-bearing behaviours: the operator's markup survives, the campaign's
 * merge placeholders survive, the legally required footer cannot be omitted,
 * and the CSS that Gmail would drop is inlined before it leaves.
 */

const CHROME: EmailChrome = {
  preheader: 'The short version, up top.',
  physicalAddress: '1 Example Street\nLondon\nEC1A 1AA',
  listName: 'Domain A Weekly',
  unsubscribePlaceholder: '{{unsubscribe_url}}',
};

const MINIMAL = '<html><body><div id="slot">{{content}}</div></body></html>';

describe('validateTemplateHtml', () => {
  it('accepts the default template', () => {
    const result = validateTemplateHtml(DEFAULT_TEMPLATE_HTML);
    expect(result).toMatchObject({ ok: true, errors: [], removed: [] });
  });

  it('rejects a template with nowhere to put the body', () => {
    const result = validateTemplateHtml('<html><body><p>no slot</p></body></html>');
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('{{content}}');
  });

  it('accepts {{ content }} with whitespace inside the braces', () => {
    expect(validateTemplateHtml('<body>{{  content  }}</body>').ok).toBe(true);
  });

  it('rejects an empty template, a non-string, and an oversized one', () => {
    expect(validateTemplateHtml('   ').errors).toEqual(['template is empty']);
    expect(validateTemplateHtml(42).errors).toEqual(['template must be a string']);
    expect(validateTemplateHtml('x'.repeat(MAX_TEMPLATE_LENGTH + 1)).ok).toBe(false);
  });

  it('applies the merge-field rules the send gate applies to a body', () => {
    // A greeting in the template shell is no different from one in the body:
    // without a fallback it renders "Hi ,".
    const result = validateTemplateHtml('<body><p>Hi {{first_name}}</p>{{content}}</body>');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('needs a fallback');

    expect(
      validateTemplateHtml('<body><p>Hi {{ first_name | default: "there" }}</p>{{content}}</body>')
        .ok,
    ).toBe(true);
  });

  it('reports an unknown placeholder rather than shipping it as literal text', () => {
    const result = validateTemplateHtml('<body>{{content}} {{ nonsense }}</body>');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('nonsense');
  });

  it('does not mistake the template-only placeholders for merge fields', () => {
    expect(validateTemplateHtml('<body>{{preheader}}{{content}}</body>').ok).toBe(true);
  });

  it('reports what the sanitizer would strip without failing the template', () => {
    // Removals are warnings: the output is already safe, and a hard block on a
    // stray <script> teaches people to fight the editor.
    const result = validateTemplateHtml('<body><script>x</script>{{content}}</body>');
    expect(result.ok).toBe(true);
    expect(result.removed).toContain('<script>');
  });
});

describe('stripTemplateOnlyPlaceholders / hasContentSlot', () => {
  it('removes only the template-only placeholders', () => {
    expect(stripTemplateOnlyPlaceholders('a{{content}}b{{ preheader }}c{{list_name}}')).toBe(
      'a b c{{list_name}}',
    );
  });

  it('detects the content slot', () => {
    expect(hasContentSlot(MINIMAL)).toBe(true);
    expect(hasContentSlot('<body></body>')).toBe(false);
  });
});

describe('applyTemplate', () => {
  it('puts the body in the slot and keeps the operator markup around it', async () => {
    const html = await applyTemplate({
      templateHtml: MINIMAL,
      contentHtml: '<p>Body copy</p>',
      chrome: CHROME,
    });

    expect(html).toContain('<div id="slot"><p>Body copy</p></div>');
  });

  it('never treats the body as a replacement pattern', async () => {
    // `$&` in a replacement string means "the whole match". A campaign
    // mentioning a price would otherwise inject the placeholder back in.
    const html = await applyTemplate({
      templateHtml: MINIMAL,
      contentHtml: '<p>$& and $` cost $19.99</p>',
      chrome: CHROME,
    });

    expect(html).toContain('$& and $` cost $19.99');
  });

  it('fails closed when the template has no slot', async () => {
    await expect(
      applyTemplate({ templateHtml: '<body></body>', contentHtml: 'x', chrome: CHROME }),
    ).rejects.toBeInstanceOf(TemplateRenderError);
  });

  it('resolves the campaign-constant placeholders and escapes them', async () => {
    const html = await applyTemplate({
      templateHtml:
        '<html><body><span>{{list_name}}</span><i>{{preheader}}</i><b>{{physical_address}}</b>{{content}}</body></html>',
      contentHtml: '<p>x</p>',
      chrome: { ...CHROME, listName: 'A & B <news>' },
    });

    expect(html).toContain('A &amp; B &lt;news&gt;');
    expect(html).toContain('The short version, up top.');
    // A multi-line postal address must not run together on one line. The
    // inliner re-serialises void elements, so the break is matched loosely.
    expect(html).toMatch(/1 Example Street<br ?\/?>London<br ?\/?>EC1A 1AA/);
  });

  it('leaves the unsubscribe placeholder for SES on a real send', async () => {
    const html = await applyTemplate({
      templateHtml: '<html><body><a href="{{unsubscribe_url}}">Out</a>{{content}}</body></html>',
      contentHtml: '<p>x</p>',
      chrome: CHROME,
    });

    expect(html).toContain('href="{{unsubscribe_url}}"');
  });

  it('resolves the unsubscribe link when the caller supplies a real URL', async () => {
    const html = await applyTemplate({
      templateHtml: '<html><body><a href="{{unsubscribe_url}}">Out</a>{{content}}</body></html>',
      contentHtml: '<p>x</p>',
      chrome: { ...CHROME, unsubscribePlaceholder: 'https://mail.example.com/u?t=abc&x=1' },
    });

    expect(html).toContain('https://mail.example.com/u?t=abc&amp;x=1');
  });
});

describe('applyTemplate — the guaranteed footer', () => {
  it('appends the unsubscribe link and address a template left out', async () => {
    const html = await applyTemplate({
      templateHtml: MINIMAL,
      contentHtml: '<p>x</p>',
      chrome: CHROME,
    });

    expect(html).toContain('{{unsubscribe_url}}');
    expect(html).toContain('1 Example Street');
    // Before </body>, not after it.
    expect(html.indexOf('{{unsubscribe_url}}')).toBeLessThan(html.lastIndexOf('</body>'));
  });

  it('does not duplicate what the template already carries', async () => {
    const html = await applyTemplate({
      templateHtml:
        '<html><body>{{content}}<p>{{physical_address}}</p><a href="{{unsubscribe_url}}">Out</a></body></html>',
      contentHtml: '<p>x</p>',
      chrome: CHROME,
    });

    expect(html.match(/\{\{unsubscribe_url\}\}/g)).toHaveLength(1);
    expect(html.match(/1 Example Street/g)).toHaveLength(1);
  });

  it('appends only the missing half', async () => {
    const html = await applyTemplate({
      templateHtml: '<html><body>{{content}}<a href="{{unsubscribe_url}}">Out</a></body></html>',
      contentHtml: '<p>x</p>',
      chrome: CHROME,
    });

    expect(html.match(/\{\{unsubscribe_url\}\}/g)).toHaveLength(1);
    expect(html).toContain('1 Example Street');
  });

  it('appends nothing about an address the list does not have', async () => {
    const html = await applyTemplate({
      templateHtml: MINIMAL,
      contentHtml: '<p>x</p>',
      chrome: { ...CHROME, physicalAddress: '' },
    });

    expect(html).toContain('{{unsubscribe_url}}');
  });

  it('still appends when the document has no </body> to insert before', async () => {
    const html = await applyTemplate({
      templateHtml: '<div>{{content}}</div>',
      contentHtml: '<p>x</p>',
      chrome: CHROME,
    });

    expect(html).toContain('{{unsubscribe_url}}');
  });
});

describe('applyTemplate — sanitizing and inlining', () => {
  it('strips active content from the template', async () => {
    const html = await applyTemplate({
      templateHtml: '<html><body><script>alert(1)</script>{{content}}</body></html>',
      contentHtml: '<p>x</p>',
      chrome: CHROME,
    });

    expect(html).not.toContain('alert(1)');
  });

  it('inlines the template CSS, because Gmail drops <style>', async () => {
    const html = await applyTemplate({
      templateHtml:
        '<html><head><style>.sm-content p { color: #483F38; }</style></head>' +
        '<body><div class="sm-content">{{content}}</div></body></html>',
      contentHtml: '<p>Body copy</p>',
      chrome: CHROME,
    });

    expect(html).toMatch(/<p style="[^"]*color: ?#483F38/i);
  });

  it('keeps media queries, which cannot be inlined onto an element', async () => {
    const html = await applyTemplate({
      templateHtml:
        '<html><head><style>@media only screen and (max-width: 620px) { .card { width: 100% !important; } }</style></head>' +
        '<body><div class="card">{{content}}</div></body></html>',
      contentHtml: '<p>x</p>',
      chrome: CHROME,
    });

    expect(html).toContain('@media only screen and (max-width: 620px)');
  });

  it('adds the open pixel when the campaign tracks opens', async () => {
    const html = await applyTemplate({
      templateHtml: MINIMAL,
      contentHtml: '<p>x</p>',
      chrome: { ...CHROME, openPixelUrl: 'https://mail.example.com/api/t/o/abc' },
    });

    expect(html).toContain('https://mail.example.com/api/t/o/abc');
    expect(html).toMatch(/width="1"/);
  });
});

describe('renderEmailDocument', () => {
  it('gives a whole pasted document the same chrome guarantees', async () => {
    const html = await renderEmailDocument(
      '<!DOCTYPE html><html><body><p>Designed elsewhere.</p></body></html>',
      CHROME,
    );

    expect(html).toContain('Designed elsewhere.');
    expect(html).toContain('{{unsubscribe_url}}');
    expect(html).toContain('1 Example Street');
  });
});

describe('the default template', () => {
  it('renders a complete, compliant email', async () => {
    const html = await applyTemplate({
      templateHtml: DEFAULT_TEMPLATE_HTML,
      contentHtml: '<h2>A heading</h2><p>Body copy.</p>',
      chrome: CHROME,
    });

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Domain A Weekly');
    expect(html).toContain('A heading');
    expect(html).toContain('{{unsubscribe_url}}');
    expect(html).toMatch(/1 Example Street<br ?\/?>London<br ?\/?>EC1A 1AA/);
    // Table-based, so Outlook's Word engine has something it understands.
    expect(html).toContain('<table');
  });

  it('inlines its type scale onto the body copy', async () => {
    const html = await applyTemplate({
      templateHtml: DEFAULT_TEMPLATE_HTML,
      contentHtml: '<p>Body copy.</p><h2>A heading</h2>',
      chrome: CHROME,
    });

    expect(html).toMatch(/<p style="[^"]*font-family: ?Arial/i);
    expect(html).toMatch(/<h2 style="[^"]*Georgia/i);
  });

  it('documents every placeholder it uses', () => {
    const documented = new Set(TEMPLATE_PLACEHOLDERS.map((placeholder) => placeholder.key));
    const used = new Set(
      [...DEFAULT_TEMPLATE_HTML.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((match) => match[1]),
    );

    for (const key of used) expect(documented).toContain(key);
  });
});
