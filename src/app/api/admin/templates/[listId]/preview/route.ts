import { badRequest, notFound, readJson, toObjectId, withAdmin } from '@/lib/api/guard';
import { renderTemplatePreview } from '@/lib/templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ listId: string }> };

/**
 * Live preview of an **unsaved** template (§6.2a).
 *
 * Renders the draft the editor sends up against sample content, through the
 * same code a real send uses. A problem is surfaced rather than swallowed: a
 * template that does not render must not be shown as if it did.
 */
export const POST = withAdmin<Ctx>(async (request, ctx) => {
  const listId = toObjectId((await ctx.params).listId);
  if (!listId) return badRequest('invalid list id');

  const body = await readJson(request);
  if (!body) return badRequest('invalid body');

  const result = await renderTemplatePreview(listId, body.html);
  if (!result.ok) {
    if (result.errors[0] === 'no such list') return notFound('list not found');
    return Response.json(
      { ok: false, errors: result.errors, removed: result.removed },
      { status: 422 },
    );
  }

  return Response.json({ ok: true, html: result.html, removed: result.removed });
});
