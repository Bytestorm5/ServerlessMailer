import { badRequest, toObjectId, withAdmin } from '@/lib/api/guard';
import { validateCampaignForSend } from '@/lib/presend';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

/** The §6.6 gate, surfaced to the UI. The UI cannot bypass it — freeze re-runs it. */
export const GET = withAdmin<Ctx>(async (_request, ctx) => {
  const id = toObjectId((await ctx.params).id);
  if (!id) return badRequest('invalid campaign id');
  return Response.json({ ok: true, ...(await validateCampaignForSend(id)) });
});
