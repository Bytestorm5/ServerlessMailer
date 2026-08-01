import { ObjectId } from 'mongodb';
import { NextResponse } from 'next/server';
import { collections } from '@/lib/db';
import { handle, notFound } from '@/lib/api';
import { requireAdmin } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * Campaign report (§13): delivered, bounced, complained, unsubscribed, opens,
 * clicks, and top clicked links — plus live batch progress while sending.
 */
export async function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    await requireAdmin();
    const { id } = await params;
    if (!ObjectId.isValid(id)) return notFound();

    const c = await collections();
    const campaignId = new ObjectId(id);
    const campaign = await c.campaigns.findOne({ _id: campaignId });
    if (!campaign) return notFound();

    const [list, batchStates, topLinks, failedBatches, sentTotal] = await Promise.all([
      c.lists.findOne({ _id: campaign.listId }),
      c.campaignBatches
        .aggregate<{ _id: string; n: number; recipients: number }>([
          { $match: { campaignId } },
          { $group: { _id: '$status', n: { $sum: 1 }, recipients: { $sum: { $size: '$subscriberIds' } } } },
        ])
        .toArray(),
      c.events
        .aggregate<{ _id: string; clicks: number; uniqueSubscribers: number }>([
          { $match: { campaignId, type: 'click' } },
          { $group: { _id: '$url', clicks: { $sum: 1 }, subscribers: { $addToSet: '$subscriberId' } } },
          { $project: { clicks: 1, uniqueSubscribers: { $size: '$subscribers' } } },
          { $sort: { clicks: -1 } },
          { $limit: 20 },
        ])
        .toArray(),
      c.campaignBatches.find({ campaignId, status: 'failed' }).limit(50).toArray(),
      c.sentLog.countDocuments({ campaignId }),
    ]);

    const batches: Record<string, { batches: number; recipients: number }> = {};
    for (const row of batchStates) {
      batches[row._id] = { batches: row.n, recipients: row.recipients };
    }

    const delivered = campaign.counts.delivered;
    const denominator = sentTotal || campaign.counts.sent;

    return NextResponse.json({
      campaign,
      list,
      batches,
      failedBatches,
      sentTotal,
      topLinks,
      rates: {
        // Open rate is presented as approximate wherever it is shown: Apple
        // Mail Privacy Protection pre-fetches images and inflates it (§13).
        openRate: delivered > 0 ? campaign.counts.opened / delivered : 0,
        clickRate: delivered > 0 ? campaign.counts.clicked / delivered : 0,
        bounceRate: denominator > 0 ? campaign.counts.bounced / denominator : 0,
        complaintRate: denominator > 0 ? campaign.counts.complained / denominator : 0,
        unsubscribeRate: denominator > 0 ? campaign.counts.unsubscribed / denominator : 0,
      },
    });
  });
}
