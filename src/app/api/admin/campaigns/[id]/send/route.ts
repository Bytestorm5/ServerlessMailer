import { ObjectId } from 'mongodb';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { collections } from '@/lib/db';
import { env } from '@/lib/env';
import { badRequest, handle, notFound, parseJson } from '@/lib/api';
import { requireAdmin } from '@/lib/auth';
import { freezeCampaign, scheduleCampaign, unscheduleCampaign } from '@/lib/campaigns';
import { runPreSendGate } from '@/lib/validation';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

const schema = z.object({
  /** Present when the recipient count crosses the typed-confirmation threshold. */
  typedConfirmation: z.string().optional(),
  /** ISO timestamp. Omit to send now. */
  scheduledFor: z.string().nullable().optional(),
});

/**
 * The send button (§6.6, §6.7, §7.1).
 *
 * The gate runs here, server-side, immediately before the transition. A gate
 * that only ran in the browser would be a suggestion.
 */
export async function POST(request: Request, { params }: Params) {
  return handle(async () => {
    const admin = await requireAdmin();
    const { id } = await params;
    if (!ObjectId.isValid(id)) return notFound();

    const body = await parseJson(request, schema);
    const c = await collections();
    const _id = new ObjectId(id);

    const campaign = await c.campaigns.findOne({ _id });
    if (!campaign) return notFound();
    const list = await c.lists.findOne({ _id: campaign.listId });
    if (!list) return notFound();

    if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
      return badRequest(`This campaign is ${campaign.status} and cannot be sent again.`);
    }

    const gate = await runPreSendGate(campaign, list);
    if (!gate.passed) {
      return NextResponse.json(
        { error: 'Pre-send checks failed', checks: gate.checks.filter((check) => !check.passed) },
        { status: 422 },
      );
    }

    if (gate.recipientCount >= env.typedConfirmThreshold) {
      if ((body.typedConfirmation ?? '').trim() !== list.name) {
        return badRequest(
          `This send needs typed confirmation. Type the list name exactly: "${list.name}".`,
          { typedConfirmationRequired: true },
        );
      }
    }

    if (body.scheduledFor) {
      const when = new Date(body.scheduledFor);
      if (Number.isNaN(when.getTime())) return badRequest('Invalid scheduledFor');
      if (when.getTime() < Date.now() - 60_000) return badRequest('Scheduled time is in the past.');

      // A campaign already scheduled has to return to draft before it can be
      // re-scheduled, so there is only one path into `scheduled`.
      if (campaign.status === 'scheduled') await unscheduleCampaign(_id);
      const scheduled = await scheduleCampaign(_id, when);
      if (!scheduled) return badRequest('Could not schedule this campaign.');

      log.info('campaign scheduled', { campaignId: id, by: admin.email, when: when.toISOString() });
      return NextResponse.json({ ok: true, scheduled: true, scheduledFor: when.toISOString() });
    }

    const result = await freezeCampaign(_id);
    if (!result.ok) {
      const messages: Record<string, string> = {
        not_found: 'Campaign or list not found.',
        wrong_status: 'This campaign is no longer in a sendable state.',
        already_freezing: 'This campaign is already being prepared for sending.',
        no_recipients: 'The segment matched nobody after suppressions were applied.',
      };
      return badRequest(messages[result.reason] ?? result.reason);
    }

    log.info('campaign send started', {
      campaignId: id,
      by: admin.email,
      recipients: result.recipients,
      batches: result.batches,
    });

    // The cron picks it up within the minute; no work happens in this request.
    return NextResponse.json({ ok: true, recipients: result.recipients, batches: result.batches });
  });
}
