import { ObjectId } from 'mongodb';
import { badRequest, notFound, readJson, toObjectId, withAdmin } from '@/lib/api/guard';
import {
  pauseCampaign,
  restoreCampaignVersion,
  resumeCampaign,
  scheduleCampaign,
  sendTestEmail,
  unscheduleCampaign,
} from '@/lib/campaigns';
import { campaignsCollection } from '@/lib/db/collections';
import { freezeCampaign } from '@/lib/pipeline/freeze';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Freezing renders the body and materialises batches for the whole list.
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

/**
 * Campaign lifecycle actions. Grouped into one endpoint because they share the
 * same guard, the same id resolution, and the same failure shape.
 */
export const POST = withAdmin<Ctx>(async (request, ctx) => {
  const id = toObjectId((await ctx.params).id);
  if (!id) return badRequest('invalid campaign id');

  const body = await readJson(request);
  const action = typeof body?.action === 'string' ? body.action : '';

  const campaign = await (await campaignsCollection()).findOne({ _id: id });
  if (!campaign) return notFound('campaign not found');

  switch (action) {
    case 'send': {
      // The pre-send gate runs inside freeze; there is no path around it.
      const result = await freezeCampaign(id);
      if (!result.ok) {
        return Response.json(
          { ok: false, error: result.reason, checks: result.checks ?? [] },
          { status: 409 },
        );
      }
      return Response.json({ ok: true, ...result });
    }

    case 'schedule': {
      const when = typeof body?.scheduledFor === 'string' ? new Date(body.scheduledFor) : null;
      if (!when) return badRequest('scheduledFor is required');
      const result = await scheduleCampaign(id, when);
      return result.ok
        ? Response.json({ ok: true })
        : Response.json({ ok: false, error: result.reason }, { status: 400 });
    }

    case 'unschedule':
      return Response.json({ ok: await unscheduleCampaign(id) });

    case 'pause': {
      const reason = typeof body?.reason === 'string' ? body.reason : undefined;
      return Response.json({ ok: await pauseCampaign(id, reason) });
    }

    case 'resume':
      return Response.json({ ok: await resumeCampaign(id) });

    case 'test': {
      const to = Array.isArray(body?.to)
        ? body.to.filter((value): value is string => typeof value === 'string')
        : [];
      const result = await sendTestEmail({
        campaignId: id,
        to,
        previewSubscriberId:
          typeof body?.previewSubscriberId === 'string' &&
          ObjectId.isValid(body.previewSubscriberId)
            ? new ObjectId(body.previewSubscriberId)
            : undefined,
      });
      return result.ok
        ? Response.json({ ok: true, sent: result.sent })
        : Response.json({ ok: false, error: result.reason }, { status: 400 });
    }

    case 'restore': {
      const versionId = toObjectId(
        typeof body?.versionId === 'string' ? body.versionId : undefined,
      );
      if (!versionId) return badRequest('versionId is required');
      return Response.json({ ok: await restoreCampaignVersion(id, versionId) });
    }

    default:
      return badRequest(`unknown action: ${action || '(none)'}`);
  }
});
