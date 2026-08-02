import { ObjectId } from 'mongodb';
import { emailTemplatesCollection, listsCollection } from '@/lib/db/collections';
import { logger } from '@/lib/logging';
import { docToContentHtml } from '@/lib/render/html';
import {
  DEFAULT_TEMPLATE_HTML,
  applyTemplate,
  validateTemplateHtml,
  type TemplateValidation,
} from '@/lib/render/template';
import type { EditorDoc, EmailTemplateDoc } from '@/lib/types';

/**
 * Template storage (spec §6.2a).
 *
 * One template per list, because a list *is* a newsletter: the sending domain,
 * the From pair and the postal address already live there, and the branding
 * belongs with them. A list with no template document renders through the
 * built-in MJML layout, which is what every list starts with — storing a
 * template is the opt-in, and deleting it is the way back.
 *
 * Validation is not advisory. A template is stored only if it is valid, so the
 * only way to reach the renderer with a broken one is to edit the database by
 * hand; the renderer still fails closed for that case.
 */

export interface SaveTemplateResult {
  ok: boolean;
  errors: string[];
  /** What the sanitizer stripped. Reported even on success. */
  removed: string[];
  template?: EmailTemplateDoc;
}

export async function getTemplate(listId: ObjectId): Promise<EmailTemplateDoc | null> {
  return (await emailTemplatesCollection()).findOne({ listId });
}

/**
 * The template HTML a campaign on this list should render through, or `null`
 * for the built-in layout.
 *
 * Every render path calls this rather than reading the collection directly, so
 * "no template means MJML" is decided in exactly one place.
 */
export async function getTemplateHtml(listId: ObjectId): Promise<string | null> {
  const template = await getTemplate(listId);
  return template?.html ?? null;
}

export async function saveTemplate(
  listId: ObjectId,
  html: unknown,
  now: Date = new Date(),
): Promise<SaveTemplateResult> {
  const list = await (await listsCollection()).findOne({ _id: listId });
  if (!list) return { ok: false, errors: ['no such list'], removed: [] };

  const validation: TemplateValidation = validateTemplateHtml(html);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors, removed: validation.removed };
  }

  const templates = await emailTemplatesCollection();
  const updated = await templates.findOneAndUpdate(
    { listId },
    {
      $set: { html: html as string, updatedAt: now },
      $setOnInsert: { _id: new ObjectId(), listId, createdAt: now },
    },
    { upsert: true, returnDocument: 'after' },
  );

  logger.info('email template saved', {
    listId: listId.toHexString(),
    bytes: (html as string).length,
    removed: validation.removed.length,
  });

  return {
    ok: true,
    errors: [],
    removed: validation.removed,
    ...(updated ? { template: updated } : {}),
  };
}

/**
 * Drops the custom template, returning the list to the built-in layout.
 *
 * Reversible and non-destructive to anything already sent: a frozen campaign
 * carries its own copy of the template it rendered through (§7.1), so removing
 * one here cannot change an email that is already on its way.
 */
export async function deleteTemplate(listId: ObjectId): Promise<boolean> {
  const result = await (await emailTemplatesCollection()).deleteOne({ listId });
  if (result.deletedCount > 0) {
    logger.info('email template removed', { listId: listId.toHexString() });
  }
  return result.deletedCount > 0;
}

/* ------------------------------------------------------------------ */
/* preview                                                             */
/* ------------------------------------------------------------------ */

/**
 * A stand-in campaign body for the template preview.
 *
 * Deliberately uses every block the editor can produce — heading, paragraph,
 * list, quote, rule, link — because the point of the preview is to show what
 * the template's CSS does to each of them, and a template whose `<h2>` is
 * invisible is a template you want to find out about here.
 */
const SAMPLE_BODY: EditorDoc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'A heading' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'A paragraph of body copy, with ' },
        { type: 'text', marks: [{ type: 'bold' }], text: 'bold' },
        { type: 'text', text: ', ' },
        { type: 'text', marks: [{ type: 'italic' }], text: 'italic' },
        { type: 'text', text: ' and ' },
        {
          type: 'text',
          marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
          text: 'a link',
        },
        { type: 'text', text: '.' },
      ],
    },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A list item' }] }],
        },
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'And another' }] }],
        },
      ],
    },
    {
      type: 'blockquote',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'A quotation, set apart.' }] },
      ],
    },
    { type: 'horizontalRule' },
    { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'A subheading' }] },
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'A closing paragraph to show the spacing.' }],
    },
  ],
};

export interface TemplatePreviewResult {
  ok: boolean;
  errors: string[];
  removed: string[];
  html: string;
}

/**
 * Renders an unsaved template against sample content, for the live preview on
 * the template page.
 *
 * Uses the real render path — same substitution, same guaranteed footer, same
 * sanitizer, same CSS inlining — because a preview that takes a shortcut is a
 * preview that lies about what will be sent.
 */
export async function renderTemplatePreview(
  listId: ObjectId,
  html: unknown,
): Promise<TemplatePreviewResult> {
  const list = await (await listsCollection()).findOne({ _id: listId });
  if (!list) return { ok: false, errors: ['no such list'], removed: [], html: '' };

  const validation = validateTemplateHtml(html);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors, removed: validation.removed, html: '' };
  }

  try {
    const rendered = await applyTemplate({
      templateHtml: html as string,
      contentHtml: docToContentHtml(SAMPLE_BODY),
      chrome: {
        preheader: 'The line the inbox shows next to the subject.',
        physicalAddress: list.physicalAddress,
        listName: list.name,
        // Resolved rather than left as a placeholder: the preview should read
        // like an email, not like a template.
        unsubscribePlaceholder: 'https://example.com/unsubscribe',
      },
    });
    return { ok: true, errors: [], removed: validation.removed, html: rendered };
  } catch (err) {
    return {
      ok: false,
      errors: [err instanceof Error ? err.message : String(err)],
      removed: validation.removed,
      html: '',
    };
  }
}

/** Every list, with its template if it has one. Backs the template page. */
export async function templateSummaries(): Promise<
  { listId: ObjectId; listName: string; html: string; stored: boolean; updatedAt?: Date }[]
> {
  const lists = await (await listsCollection()).find({}).sort({ name: 1 }).toArray();
  const templates = await (await emailTemplatesCollection()).find({}).toArray();
  const byList = new Map(templates.map((doc) => [doc.listId.toHexString(), doc]));

  return lists.map((list) => {
    const template = byList.get(list._id.toHexString());
    return {
      listId: list._id,
      listName: list.name,
      // A list with no template is shown the default, ready to save: the
      // starting point should be a real design, not an empty box.
      html: template?.html ?? DEFAULT_TEMPLATE_HTML,
      stored: template !== undefined,
      ...(template ? { updatedAt: template.updatedAt } : {}),
    };
  });
}
