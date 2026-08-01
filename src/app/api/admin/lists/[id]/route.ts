import { badRequest, notFound, readJson, toObjectId, withAdmin } from '@/lib/api/guard';
import {
  ListValidationError,
  deleteList,
  getList,
  serializeList,
  updateList,
  type ListInput,
} from '@/lib/lists';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Editable fields. `createdAt` and `_id` are the database's, not the operator's. */
const EDITABLE = [
  'name',
  'sendingDomain',
  'fromName',
  'fromEmail',
  'replyTo',
  'physicalAddress',
  'sesConfigurationSet',
  'welcomeUrl',
] as const;

/**
 * Builds a patch from the keys actually present in the body, so a PATCH that
 * carries one field cannot blank the other seven.
 */
function readPatch(body: Record<string, unknown>): Partial<ListInput> {
  const patch: Partial<ListInput> = {};
  for (const key of EDITABLE) {
    const value = body[key];
    if (typeof value === 'string') patch[key] = value;
  }
  if (typeof body.active === 'boolean') patch.active = body.active;
  return patch;
}

export const GET = withAdmin<Ctx>(async (_request, ctx) => {
  const id = toObjectId((await ctx.params).id);
  if (!id) return badRequest('invalid list id');

  const list = await getList(id);
  if (!list) return notFound('list not found');
  return Response.json({ ok: true, list: serializeList(list) });
});

export const PATCH = withAdmin<Ctx>(async (request, ctx) => {
  const id = toObjectId((await ctx.params).id);
  if (!id) return badRequest('invalid list id');

  const body = await readJson(request);
  if (!body) return badRequest('a JSON body is required');

  const patch = readPatch(body);
  if (Object.keys(patch).length === 0) return badRequest('no editable fields in request');

  try {
    const list = await updateList(id, patch);
    if (!list) return notFound('list not found');
    return Response.json({ ok: true, list: serializeList(list) });
  } catch (err) {
    if (err instanceof ListValidationError) return badRequest(err.message);
    throw err;
  }
});

/**
 * Deletion is refused for a list anything still references (§3.1). The refusal
 * carries the counts and names deactivation as the alternative, because that is
 * what the operator almost always meant.
 */
export const DELETE = withAdmin<Ctx>(async (_request, ctx) => {
  const id = toObjectId((await ctx.params).id);
  if (!id) return badRequest('invalid list id');

  const result = await deleteList(id);
  if (result.deleted) return Response.json({ ok: true, deleted: true });
  if (result.reason === 'not_found') return notFound('list not found');

  return Response.json(
    {
      ok: false,
      error: result.message,
      subscribers: result.subscribers,
      campaigns: result.campaigns,
    },
    { status: 409 },
  );
});
