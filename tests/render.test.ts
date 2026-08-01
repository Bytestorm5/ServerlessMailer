import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setupEnv } from './helpers/setup';
import { renderCampaign } from '../src/lib/render/render-campaign';
import {
  MergePlanBuilder,
  applyTemplateData,
  parseMergeFields,
  resolveMergePlan,
  sanitizeMergeValue,
} from '../src/lib/merge';
import { documentHasImage, documentTextContent } from '../src/lib/render/tiptap-to-mjml';
import { LinkRegistry } from '../src/lib/render/link-registry';
import type { SubscriberDoc, TiptapDoc } from '../src/lib/types';

// Safe to call after the imports: every module in this project reads the
// environment lazily, at call time rather than at module load.
setupEnv();

const list = { name: 'Test Weekly', physicalAddress: 'Test Ltd, 1 Test Street, Testville' };

function doc(content: TiptapDoc['content']): TiptapDoc {
  return { type: 'doc', content };
}

describe('merge fields (§6.4)', () => {
  it('parses a field with a fallback', () => {
    const fields = parseMergeFields('Hi {{ first_name | default: "there" }}!');
    assert.equal(fields.length, 1);
    assert.equal(fields[0]?.field, 'first_name');
    assert.equal(fields[0]?.fallback, 'there');
  });

  it('reports a missing fallback as null rather than an empty string', () => {
    const fields = parseMergeFields('Hi {{ first_name }}');
    assert.equal(fields[0]?.fallback, null);
  });

  it('gives the same field with different fallbacks distinct variables', () => {
    const builder = new MergePlanBuilder();
    const a = builder.add('first_name', 'there');
    const b = builder.add('first_name', 'friend');
    const c = builder.add('first_name', 'there');

    assert.notEqual(a, b, 'different fallbacks collided on one variable');
    assert.equal(a, c, 'the same field and fallback should reuse one variable');
    assert.equal(builder.plan().length, 2);
  });

  it('resolves a fallback when the subscriber value is missing or blank', () => {
    const builder = new MergePlanBuilder();
    builder.add('first_name', 'there');
    const plan = builder.plan();

    const blank = { email: 'a@b.com', attributes: { first_name: '  ' } } as unknown as SubscriberDoc;
    const named = { email: 'a@b.com', attributes: { first_name: 'Ada' } } as unknown as SubscriberDoc;

    assert.equal(resolveMergePlan(plan, blank).m0, 'there');
    assert.equal(resolveMergePlan(plan, named).m0, 'Ada');
  });

  it('strips characters that could inject markup through merge data', () => {
    assert.equal(sanitizeMergeValue('<script>alert(1)</script>'), 'scriptalert(1)/script');
    assert.equal(sanitizeMergeValue('  Ada  '), 'Ada');
  });
});

describe('campaign render (§6.2)', () => {
  const campaign = {
    subject: 'Hello {{ first_name | default: "there" }}',
    preheader: 'This week in review',
    bodySource: doc([
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Headline' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Hi {{ first_name | default: "there" }}, see ' },
          {
            type: 'text',
            text: 'this post',
            marks: [{ type: 'link', attrs: { href: 'https://example.com/post' } }],
          },
          { type: 'text', text: '.' },
        ],
      },
      { type: 'bulletList', content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Two' }] }] },
      ] },
      { type: 'horizontalRule' },
    ]),
  };

  it('produces both an HTML and a plain-text part', () => {
    const rendered = renderCampaign(campaign, list, { trackOpens: false, trackClicks: false });

    assert.ok(rendered.html.includes('<html'), 'no HTML document produced');
    assert.ok(rendered.html.includes('Headline'));
    assert.ok(rendered.text.includes('Headline'));
    assert.ok(rendered.text.includes('- One'), 'list markers missing from the text part');
    assert.equal(rendered.mjmlErrors.length, 0, rendered.mjmlErrors.join(' | '));
  });

  it('always includes the unsubscribe placeholder and postal address in both parts', () => {
    const rendered = renderCampaign(campaign, list, { trackOpens: false, trackClicks: false });

    assert.ok(rendered.html.includes('{{unsubscribe_url}}'));
    assert.ok(rendered.text.includes('{{unsubscribe_url}}'));
    assert.ok(rendered.html.includes('Test Ltd, 1 Test Street, Testville'));
    assert.ok(rendered.text.includes('Test Ltd, 1 Test Street, Testville'));
  });

  it('compiles merge fields in the subject and body onto one plan', () => {
    const rendered = renderCampaign(campaign, list, { trackOpens: false, trackClicks: false });

    assert.equal(rendered.mergePlan.length, 1, 'the same field+fallback should share one variable');
    assert.equal(rendered.mergePlan[0]?.field, 'first_name');
    assert.equal(rendered.mergePlan[0]?.fallback, 'there');
    assert.ok(rendered.subjectTemplate.includes('{{m0}}'));
    assert.ok(rendered.html.includes('{{m0}}'));
    assert.ok(rendered.text.includes('{{m0}}'));
  });

  it('substitutes identically into the HTML and text parts from one data object', () => {
    const rendered = renderCampaign(campaign, list, { trackOpens: false, trackClicks: false });
    const data = { m0: 'Ada', unsubscribe_url: 'https://mail.test/u', preferences_url: 'https://mail.test/p' };

    const html = applyTemplateData(rendered.html, data);
    const text = applyTemplateData(rendered.text, data);

    assert.ok(html.includes('Hi Ada,'));
    assert.ok(text.includes('Hi Ada,'));
    assert.ok(!html.includes('{{m0}}'));
    assert.ok(!text.includes('{{m0}}'));
  });

  it('emits raw URLs when click tracking is off', () => {
    const rendered = renderCampaign(campaign, list, { trackOpens: false, trackClicks: false });

    assert.ok(rendered.html.includes('https://example.com/post'));
    assert.ok(rendered.text.includes('<https://example.com/post>'));
    assert.equal(rendered.trackedLinks.length, 0);
    assert.ok(!rendered.html.includes('{{c0}}'));
  });

  it('rewrites links to per-recipient variables when click tracking is on', () => {
    const rendered = renderCampaign(campaign, list, { trackOpens: false, trackClicks: true });

    assert.deepEqual(rendered.trackedLinks, ['https://example.com/post']);
    assert.ok(rendered.html.includes('{{c0}}'), 'HTML link was not rewritten');
    assert.ok(rendered.text.includes('{{c0}}'), 'text link was not rewritten');
    assert.ok(!rendered.html.includes('href="https://example.com/post"'));
  });

  it('numbers link placeholders consistently across the HTML and text renders', () => {
    // Two links, plus a relative one the HTML renderer rejects. If the two
    // renderers numbered by traversal position, the text part would point at
    // the wrong URL from here on.
    const multi = {
      subject: 'x',
      preheader: '',
      bodySource: doc([
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a', marks: [{ type: 'link', attrs: { href: 'https://a.example.com' } }] },
            { type: 'text', text: 'bad', marks: [{ type: 'link', attrs: { href: '/relative' } }] },
            { type: 'text', text: 'b', marks: [{ type: 'link', attrs: { href: 'https://b.example.com' } }] },
          ],
        },
      ]),
    };

    const rendered = renderCampaign(multi, list, { trackOpens: false, trackClicks: true });

    assert.deepEqual(rendered.trackedLinks, ['https://a.example.com', 'https://b.example.com']);
    assert.deepEqual(rendered.invalidLinks, ['/relative']);

    // c0 → a, c1 → b, in both parts.
    const html = applyTemplateData(rendered.html, { c0: 'A_URL', c1: 'B_URL' });
    const text = applyTemplateData(rendered.text, { c0: 'A_URL', c1: 'B_URL' });
    assert.ok(html.includes('href="A_URL"'));
    assert.ok(html.includes('href="B_URL"'));
    assert.ok(text.includes('a <A_URL>'));
    assert.ok(text.includes('b <B_URL>'));
  });

  it('adds the open pixel only when open tracking is on', () => {
    const off = renderCampaign(campaign, list, { trackOpens: false, trackClicks: false });
    const on = renderCampaign(campaign, list, { trackOpens: true, trackClicks: false });

    assert.ok(!off.html.includes('open_pixel_url'));
    assert.ok(on.html.includes('{{open_pixel_url}}'));
    assert.ok(on.html.indexOf('open_pixel_url') < on.html.lastIndexOf('</body>'));
  });

  it('escapes author text so a body cannot inject markup', () => {
    const nasty = {
      subject: 'x',
      preheader: '',
      bodySource: doc([{ type: 'paragraph', content: [{ type: 'text', text: '<script>alert(1)</script>' }] }]),
    };
    const rendered = renderCampaign(nasty, list, { trackOpens: false, trackClicks: false });
    assert.ok(!rendered.html.includes('<script>'));
    assert.ok(rendered.html.includes('&lt;script&gt;'));
  });

  it('drops node types the renderer does not support rather than passing them through', () => {
    const unknown = {
      subject: 'x',
      preheader: '',
      bodySource: doc([
        { type: 'codeBlock', content: [{ type: 'text', text: 'rm -rf /' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'kept' }] },
      ]),
    };
    const rendered = renderCampaign(unknown, list, { trackOpens: false, trackClicks: false });
    assert.ok(rendered.html.includes('kept'));
    assert.ok(!rendered.html.includes('rm -rf /'));
  });
});

describe('body inspection for the pre-send gate (§6.6)', () => {
  it('detects an image-only body', () => {
    const imageOnly = doc([{ type: 'image', attrs: { src: 'https://example.com/a.png', alt: '' } }]);
    assert.equal(documentTextContent(imageOnly), '');
    assert.equal(documentHasImage(imageOnly), true);
  });

  it('detects an empty body', () => {
    const empty = doc([{ type: 'paragraph' }]);
    assert.equal(documentTextContent(empty), '');
    assert.equal(documentHasImage(empty), false);
  });
});

describe('link registry', () => {
  it('rejects anything that is not an absolute http(s) URL', () => {
    const registry = new LinkRegistry();
    assert.equal(registry.add('/relative'), null);
    assert.equal(registry.add('javascript:alert(1)'), null);
    assert.equal(registry.add('mailto:a@b.com'), null);
    assert.equal(registry.add(''), null);
    assert.ok(registry.add('https://example.com'));
    assert.equal(registry.list().length, 1);
    assert.equal(registry.invalidLinks().length, 4);
  });

  it('gives repeated uses of one URL a single entry', () => {
    const registry = new LinkRegistry();
    assert.equal(registry.add('https://example.com'), registry.add('https://example.com'));
    assert.equal(registry.list().length, 1);
  });
});
