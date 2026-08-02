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
import { DEFAULT_TEMPLATE_HTML } from '@/lib/render/template';
import { createList } from '@tests/helpers/factories';
import type { ListDoc } from '@/lib/types';

/**
 * Template storage (§6.2a).
 *
 * One template per list, validated before it is stored, and reversible: the
 * built-in layout is always one delete away, and nothing here can change an
 * email that has already been frozen.
 */

const MINIMAL = '<html><body><h1>{{list_name}}</h1>{{content}}</body></html>';

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
    const result = await saveTemplate(list._id, MINIMAL);

    expect(result.ok).toBe(true);
    expect(result.template?.html).toBe(MINIMAL);
    expect(await getTemplateHtml(list._id)).toBe(MINIMAL);
  });

  it('updates in place rather than accumulating documents', async () => {
    await saveTemplate(list._id, MINIMAL);
    await saveTemplate(list._id, MINIMAL.replace('h1', 'h2'));

    expect(await (await emailTemplatesCollection()).countDocuments({ listId: list._id })).toBe(1);
    expect(await getTemplateHtml(list._id)).toContain('<h2>');
  });

  it('keeps createdAt across an update', async () => {
    const first = await saveTemplate(list._id, MINIMAL, new Date('2026-01-01T00:00:00Z'));
    const second = await saveTemplate(list._id, MINIMAL, new Date('2026-02-01T00:00:00Z'));

    expect(second.template?.createdAt).toEqual(first.template?.createdAt);
    expect(second.template?.updatedAt).toEqual(new Date('2026-02-01T00:00:00Z'));
  });

  it('refuses an invalid template rather than storing something unrenderable', async () => {
    const result = await saveTemplate(list._id, '<html><body>no slot</body></html>');

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('{{content}}');
    expect(await getTemplate(list._id)).toBeNull();
  });

  it('reports what the sanitizer will strip, without refusing the save', async () => {
    const result = await saveTemplate(list._id, `<script>x</script>${MINIMAL}`);

    expect(result.ok).toBe(true);
    expect(result.removed).toContain('<script>');
  });

  it('refuses a template for a list that does not exist', async () => {
    const result = await saveTemplate(new ObjectId(), MINIMAL);
    expect(result).toMatchObject({ ok: false, errors: ['no such list'] });
  });
});

describe('deleteTemplate', () => {
  it('returns the list to the built-in layout', async () => {
    await saveTemplate(list._id, MINIMAL);

    expect(await deleteTemplate(list._id)).toBe(true);
    expect(await getTemplateHtml(list._id)).toBeNull();
  });

  it('is a no-op for a list that never had one', async () => {
    expect(await deleteTemplate(list._id)).toBe(false);
  });
});

describe('templateSummaries', () => {
  it('offers the default to a list that has not chosen one', async () => {
    const summaries = await templateSummaries();

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ stored: false, html: DEFAULT_TEMPLATE_HTML });
  });

  it('reports the stored template once there is one', async () => {
    await saveTemplate(list._id, MINIMAL);
    const summaries = await templateSummaries();

    expect(summaries[0]).toMatchObject({ stored: true, html: MINIMAL, listName: list.name });
    expect(summaries[0].updatedAt).toBeInstanceOf(Date);
  });

  it('lists every list, in name order', async () => {
    await createList({ name: 'A Second List', sendingDomain: 'news.domain-b.com', fromEmail: 'hi@news.domain-b.com' });
    const summaries = await templateSummaries();

    expect(summaries.map((summary) => summary.listName)).toEqual([
      'A Second List',
      'Domain A Weekly',
    ]);
  });
});

describe('renderTemplatePreview', () => {
  it('renders sample content through the real render path', async () => {
    const result = await renderTemplatePreview(list._id, MINIMAL);

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
    const result = await renderTemplatePreview(list._id, MINIMAL);

    expect(result.html).toContain('<h2>');
    expect(result.html).toContain('<ul>');
    expect(result.html).toContain('<blockquote>');
    expect(result.html).toContain('<hr');
  });

  it('surfaces a validation failure instead of a broken preview', async () => {
    const result = await renderTemplatePreview(list._id, '<html><body>no slot</body></html>');

    expect(result.ok).toBe(false);
    expect(result.html).toBe('');
    expect(result.errors.join(' ')).toContain('{{content}}');
  });

  it('refuses a preview for a list that does not exist', async () => {
    expect(await renderTemplatePreview(new ObjectId(), MINIMAL)).toMatchObject({
      ok: false,
      errors: ['no such list'],
    });
  });
});
