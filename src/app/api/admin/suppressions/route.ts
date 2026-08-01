import { badRequest, readJson, withAdmin } from '@/lib/api/guard';
import { addSuppression, listSuppressions, removeSuppression } from '@/lib/suppressions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAdmin(async (request) => {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit') ?? 50);
  const skip = Number(url.searchParams.get('skip') ?? 0);

  const result = await listSuppressions({
    search: url.searchParams.get('search') ?? undefined,
    limit: Number.isFinite(limit) ? limit : 50,
    skip: Number.isFinite(skip) ? skip : 0,
  });

  return Response.json({
    ok: true,
    total: result.total,
    suppressions: result.items.map((doc) => ({
      email: doc.email,
      reason: doc.reason,
      createdAt: doc.createdAt,
      sourceCampaignId: doc.sourceCampaignId?.toHexString() ?? null,
      detail: doc.detail ?? null,
    })),
  });
});

/** Manual add (section 4.5). */
export const POST = withAdmin(async (request) => {
  const body = await readJson(request);
  const email = typeof body?.email === 'string' ? body.email : '';
  if (!email) return badRequest('email is required');

  try {
    const result = await addSuppression({
      email,
      reason: 'manual',
      detail: typeof body?.detail === 'string' ? body.detail : 'Added manually by an operator',
    });
    return Response.json({ ok: true, created: result.created });
  } catch (err) {
    return badRequest((err as Error).message);
  }
});

/**
 * Removing a suppression is deliberately available but never automatic: it is
 * how an operator undoes a mistaken manual entry, and nothing else should call it.
 */
export const DELETE = withAdmin(async (request) => {
  const email = new URL(request.url).searchParams.get('email');
  if (!email) return badRequest('email is required');
  return Response.json({ ok: true, removed: await removeSuppression(email) });
});
