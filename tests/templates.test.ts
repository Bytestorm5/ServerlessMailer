import { beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import {
  deleteTemplate,
  getTemplate,
  getTemplateHtml,
  renderTemplatePreview,
  saveTemplate,
  templateSummaries,
} from '@/lib/templates';
import { emailTemplatesCollection, listsCollection } from '@/lib/db/collections';
import { ensureIndexes } from '@/lib/db/indexes';
import {
  DEFAULT_CONFIRMATION_TEMPLATE_HTML,
  DEFAULT_TEMPLATE_HTML,
} from '@/lib/render/template';
import { createList } from '@tests/helpers/factories';
import type { ListDoc } from '@/lib/types';

/**
 * Template storage (§6.2a).
 *
 * One template per list *per kind*, validated before it is stored, and
 * reversible: the built-in layout is always one delete away, and nothing here
 * can change an email that has already been frozen.
 */

const MINIMAL = '<html><body><h1>{{list_name}}</h1>{{content}}</body></html>';
const CONFIRMATION =
  '<html><body><h1>{{list_name}}</h1><a href="{{confirm_url}}">Confirm</a></body></html>';

let list: ListDoc;

beforeEach(async () => {
  await ensureIndexes();
  await Promise.all([
    (await listsCollection()).deleteMany({}),
    (await emailTemplatesCollection()).deleteMany({}),
  ]);
  list = await createList();
});

describe('saveTemplate', () => {
  it('stores a valid template and reads it back', async () => {
    const result = await saveTemplate(list._id, 'campaign', MINIMAL);

    expect(result.ok).toBe(true);
    expect(result.template?.html).toBe(MINIMAL);
    expect(await getTemplateHtml(list._id)).toBe(MINIMAL);
  });

  it('updates in place rather than accumulating documents', async () => {
    await saveTemplate(list._id, 'campaign', MINIMAL);
    await saveTemplate(list._id, 'campaign', MINIMAL.replace('h1', 'h2'));

    expect(await (await emailTemplatesCollection()).countDocuments({ listId: list._id })).toBe(1);
    expect(await getTemplateHtml(list._id)).toContain('<h2>');
  });

  it('keeps createdAt across an update', async () => {
    const first = await saveTemplate(list._id, 'campaign', MINIMAL, new Date('2026-01-01T00:00:00Z'));
    const second = await saveTemplate(list._id, 'campaign', MINIMAL, new Date('2026-02-01T00:00:00Z'));

    expect(second.template?.createdAt).toEqual(first.template?.createdAt);
    expect(second.template?.updatedAt).toEqual(new Date('2026-02-01T00:00:00Z'));
  });

  it('refuses an invalid template rather than storing something unrenderable', async () => {
    const result = await saveTemplate(list._id, 'campaign', '<html><body>no slot</body></html>');

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('{{content}}');
    expect(await getTemplate(list._id)).toBeNull();
  });

  it('reports what the sanitizer will strip, without refusing the save', async () => {
    const result = await saveTemplate(list._id, 'campaign', `<script>x</script>${MINIMAL}`);

    expect(result.ok).toBe(true);
    expect(result.removed).toContain('<script>');
  });

  it('refuses a template for a list that does not exist', async () => {
    const result = await saveTemplate(new ObjectId(), 'campaign', MINIMAL);
    expect(result).toMatchObject({ ok: false, errors: ['no such list'] });
  });
});

describe('deleteTemplate', () => {
  it('returns the list to the built-in layout', async () => {
    await saveTemplate(list._id, 'campaign', MINIMAL);

    expect(await deleteTemplate(list._id)).toBe(true);
    expect(await getTemplateHtml(list._id)).toBeNull();
  });

  it('is a no-op for a list that never had one', async () => {
    expect(await deleteTemplate(list._id)).toBe(false);
  });
});

describe('templateSummaries', () => {
  it('offers each kind its own default to a list that has not chosen one', async () => {
    const summaries = await templateSummaries();

    expect(summaries).toHaveLength(2);
    expect(summaries).toEqual([
      expect.objectContaining({ kind: 'campaign', stored: false, html: DEFAULT_TEMPLATE_HTML }),
      expect.objectContaining({
        kind: 'confirmation',
        stored: false,
        html: DEFAULT_CONFIRMATION_TEMPLATE_HTML,
      }),
    ]);
  });

  it('reports the stored template once there is one, kind by kind', async () => {
    await saveTemplate(list._id, 'confirmation', CONFIRMATION);
    const summaries = await templateSummaries();

    expect(summaries[0]).toMatchObject({ kind: 'campaign', stored: false });
    expect(summaries[1]).toMatchObject({
      kind: 'confirmation',
      stored: true,
      html: CONFIRMATION,
      listName: list.name,
    });
    expect(summaries[1].updatedAt).toBeInstanceOf(Date);
  });

  it('lists every list, in name order', async () => {
    await createList({ name: 'A Second List', sendingDomain: 'news.domain-b.com', fromEmail: 'hi@news.domain-b.com' });
    const summaries = await templateSummaries();

    expect(summaries.map((summary) => summary.listName)).toEqual([
      'A Second List',
      'A Second List',
      'Domain A Weekly',
      'Domain A Weekly',
    ]);
  });
});

describe('the two kinds are stored independently', () => {
  it('lets one list hold a campaign template and a confirmation template', async () => {
    // The unique index is on {listId, kind}: one per kind, not one per list.
    expect((await saveTemplate(list._id, 'campaign', MINIMAL)).ok).toBe(true);
    expect((await saveTemplate(list._id, 'confirmation', CONFIRMATION)).ok).toBe(true);

    expect(await getTemplateHtml(list._id, 'campaign')).toBe(MINIMAL);
    expect(await getTemplateHtml(list._id, 'confirmation')).toBe(CONFIRMATION);
  });

  it('deletes one kind without touching the other', async () => {
    await saveTemplate(list._id, 'campaign', MINIMAL);
    await saveTemplate(list._id, 'confirmation', CONFIRMATION);

    expect(await deleteTemplate(list._id, 'confirmation')).toBe(true);
    expect(await getTemplateHtml(list._id, 'confirmation')).toBeNull();
    expect(await getTemplateHtml(list._id, 'campaign')).toBe(MINIMAL);
  });

  it('holds each kind to its own rules', async () => {
    // A campaign template needs somewhere to put the body; a confirmation
    // template needs the link it exists to get clicked.
    expect((await saveTemplate(list._id, 'confirmation', MINIMAL)).errors.join(' ')).toContain(
      '{{confirm_url}}',
    );
    expect((await saveTemplate(list._id, 'campaign', CONFIRMATION)).errors.join(' ')).toContain(
      '{{content}}',
    );
  });

  it('previews a confirmation template as the whole email', async () => {
    const result = await renderTemplatePreview(list._id, 'confirmation', CONFIRMATION);

    expect(result.ok).toBe(true);
    expect(result.html).toContain(list.name);
    expect(result.html).toContain('https://example.com/confirm');
    // No sample campaign body: a confirmation email has no slot to put one in.
    expect(result.html).not.toContain('A heading');
    expect(result.html).not.toMatch(/unsubscribe/i);
  });
});

describe('renderTemplatePreview', () => {
  it('renders sample content through the real render path', async () => {
    const result = await renderTemplatePreview(list._id, 'campaign', MINIMAL);

    expect(result.ok).toBe(true);
    expect(result.html).toContain(list.name);
    expect(result.html).toContain('A heading');
    // Same guaranteed footer a real send gets, with the link resolved so the
    // preview reads like an email rather than like a template.
    expect(result.html).toContain(list.physicalAddress.slice(0, 24));
    expect(result.html).toContain('https://example.com/unsubscribe');
    expect(result.html).not.toContain('{{');
  });

  it('exercises every block the editor can produce', async () => {
    // A template whose <h2> is invisible is a template you want to find out
    // about here, not from a campaign.
    const result = await renderTemplatePreview(list._id, 'campaign', MINIMAL);

    expect(result.html).toContain('<h2>');
    expect(result.html).toContain('<ul>');
    expect(result.html).toContain('<blockquote>');
    expect(result.html).toContain('<hr');
  });

  it('surfaces a validation failure instead of a broken preview', async () => {
    const result = await renderTemplatePreview(list._id, 'campaign', '<html><body>no slot</body></html>');

    expect(result.ok).toBe(false);
    expect(result.html).toBe('');
    expect(result.errors.join(' ')).toContain('{{content}}');
  });

  it('refuses a preview for a list that does not exist', async () => {
    expect(await renderTemplatePreview(new ObjectId(), 'campaign', MINIMAL)).toMatchObject({
      ok: false,
      errors: ['no such list'],
    });
  });
});
