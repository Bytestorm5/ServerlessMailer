import type { ObjectId } from 'mongodb';
import { badRequest, notFound, readJson, toObjectId, withAdmin } from '@/lib/api/guard';
import { deleteTemplate, getTemplate, saveTemplate } from '@/lib/templates';
import { defaultTemplateHtml, isTemplateKind } from '@/lib/render/template';
import type { TemplateKind } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ listId: string; kind: string }> };

/**
 * One template for one list (§6.2a): `campaign` or `confirmation`.
 *
 * `GET` always answers with something renderable — a list with no stored
 * template of this kind gets the default, flagged as not-yet-stored, so the
 * editor opens on a real design rather than an empty box.
 */
type ParsedRoute =
  | { ok: true; listId: ObjectId; kind: TemplateKind }
  | { ok: false; response: Response };

async function parseRoute(ctx: Ctx): Promise<ParsedRoute> {
  const { listId, kind } = await ctx.params;
  const id = toObjectId(listId);
  if (!id) return { ok: false, response: badRequest('invalid list id') };
  if (!isTemplateKind(kind)) return { ok: false, response: badRequest('invalid template kind') };
  return { ok: true, listId: id, kind };
}

export const GET = withAdmin<Ctx>(async (_request, ctx) => {
  const parsed = await parseRoute(ctx);
  if (!parsed.ok) return parsed.response;

  const template = await getTemplate(parsed.listId, parsed.kind);
  return Response.json({
    ok: true,
    kind: parsed.kind,
    stored: template !== null,
    html: template?.html ?? defaultTemplateHtml(parsed.kind),
    updatedAt: template?.updatedAt ?? null,
  });
});

export const PUT = withAdmin<Ctx>(async (request, ctx) => {
  const parsed = await parseRoute(ctx);
  if (!parsed.ok) return parsed.response;

  const body = await readJson(request);
  if (!body) return badRequest('invalid body');

  const result = await saveTemplate(parsed.listId, parsed.kind, body.html);
  if (!result.ok) {
    if (result.errors[0] === 'no such list') return notFound('list not found');
    return Response.json(
      { ok: false, error: 'invalid_template', errors: result.errors, removed: result.removed },
      { status: 400 },
    );
  }

  return Response.json({ ok: true, removed: result.removed, stored: true });
});

/** Reverts this email to the built-in layout. Frozen campaigns keep theirs. */
export const DELETE = withAdmin<Ctx>(async (_request, ctx) => {
  const parsed = await parseRoute(ctx);
  if (!parsed.ok) return parsed.response;

  const removed = await deleteTemplate(parsed.listId, parsed.kind);
  return Response.json({
    ok: true,
    removed,
    html: defaultTemplateHtml(parsed.kind),
    stored: false,
  });
});
