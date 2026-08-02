import { badRequest, notFound, readJson, toObjectId, withAdmin } from '@/lib/api/guard';
import { deleteTemplate, getTemplate, saveTemplate } from '@/lib/templates';
import { DEFAULT_TEMPLATE_HTML } from '@/lib/render/template';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ listId: string }> };

/**
 * The template for one list (§6.2a).
 *
 * `GET` always answers with something renderable: a list with no stored
 * template gets the default, flagged as not-yet-stored, so the editor opens on
 * a real design rather than an empty box.
 */
export const GET = withAdmin<Ctx>(async (_request, ctx) => {
  const listId = toObjectId((await ctx.params).listId);
  if (!listId) return badRequest('invalid list id');

  const template = await getTemplate(listId);
  return Response.json({
    ok: true,
    stored: template !== null,
    html: template?.html ?? DEFAULT_TEMPLATE_HTML,
    updatedAt: template?.updatedAt ?? null,
  });
});

export const PUT = withAdmin<Ctx>(async (request, ctx) => {
  const listId = toObjectId((await ctx.params).listId);
  if (!listId) return badRequest('invalid list id');

  const body = await readJson(request);
  if (!body) return badRequest('invalid body');

  const result = await saveTemplate(listId, body.html);
  if (!result.ok) {
    if (result.errors[0] === 'no such list') return notFound('list not found');
    return Response.json(
      { ok: false, error: 'invalid_template', errors: result.errors, removed: result.removed },
      { status: 400 },
    );
  }

  return Response.json({ ok: true, removed: result.removed, stored: true });
});

/** Reverts the list to the built-in layout. Campaigns already frozen keep theirs. */
export const DELETE = withAdmin<Ctx>(async (_request, ctx) => {
  const listId = toObjectId((await ctx.params).listId);
  if (!listId) return badRequest('invalid list id');

  const removed = await deleteTemplate(listId);
  return Response.json({ ok: true, removed, html: DEFAULT_TEMPLATE_HTML, stored: false });
});
