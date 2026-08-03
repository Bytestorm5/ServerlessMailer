import { badRequest, notFound, readJson, toObjectId, withAdmin } from '@/lib/api/guard';
import { isTemplateKind } from '@/lib/render/template';
import { renderTemplatePreview } from '@/lib/templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ listId: string; kind: string }> };

/**
 * Live preview of an **unsaved** template (§6.2a).
 *
 * Renders the draft the editor sends up against sample data, through the same
 * code a real send uses. A problem is surfaced rather than swallowed: a
 * template that does not render must not be shown as if it did.
 */
export const POST = withAdmin<Ctx>(async (request, ctx) => {
  const { listId: rawListId, kind } = await ctx.params;
  const listId = toObjectId(rawListId);
  if (!listId) return badRequest('invalid list id');
  if (!isTemplateKind(kind)) return badRequest('invalid template kind');

  const body = await readJson(request);
  if (!body) return badRequest('invalid body');

  const result = await renderTemplatePreview(listId, kind, body.html);
  if (!result.ok) {
    if (result.errors[0] === 'no such list') return notFound('list not found');
    return Response.json(
      { ok: false, errors: result.errors, removed: result.removed },
      { status: 422 },
    );
  }

  return Response.json({ ok: true, html: result.html, removed: result.removed });
});
