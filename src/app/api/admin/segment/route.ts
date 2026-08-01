import { badRequest, readJson, toObjectId, withAdmin } from '@/lib/api/guard';
import { countSegment } from '@/lib/segments';
import type { SegmentQuery } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Live segment count for the editor (section 4.2). Advisory only — the count is
 * always re-derived at freeze time and never trusted from the UI.
 */
export const POST = withAdmin(async (request) => {
  const body = await readJson(request);
  const listId = toObjectId(typeof body?.listId === 'string' ? body.listId : undefined);
  if (!listId) return badRequest('a valid listId is required');

  try {
    const count = await countSegment(listId, (body?.query ?? {}) as SegmentQuery);
    return Response.json({ ok: true, count });
  } catch (err) {
    // A malformed segment (bad date, unsafe attribute key) is a user error.
    return badRequest((err as Error).message);
  }
});
