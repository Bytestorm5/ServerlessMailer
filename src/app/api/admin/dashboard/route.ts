import { NextResponse } from 'next/server';
import { collections } from '@/lib/db';
import { handle } from '@/lib/api';
import { requireAdmin } from '@/lib/auth';
import { pipelineHealth, rollingReputation } from '@/lib/reputation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Dashboard data.
 *
 * Rolling bounce and complaint rates are returned first-class rather than
 * buried in a metrics tab (§8.3) — they are the numbers that decide whether
 * the SES account survives.
 */
export async function GET() {
  return handle(async () => {
    await requireAdmin();
    const c = await collections();

    const [reputation, health, lists, active, recent, suppressionCount] = await Promise.all([
      rollingReputation(),
      pipelineHealth(),
      c.lists.find({}).sort({ name: 1 }).toArray(),
      c.campaigns
        .find(
          { status: { $in: ['sending', 'paused', 'scheduled'] } },
          { projection: { bodySource: 0, bodyHtml: 0, bodyText: 0 } },
        )
        .sort({ startedAt: -1 })
        .toArray(),
      c.campaigns
        .find({ status: { $in: ['sent', 'failed'] } }, { projection: { bodySource: 0, bodyHtml: 0, bodyText: 0 } })
        .sort({ completedAt: -1 })
        .limit(10)
        .toArray(),
      c.suppressions.estimatedDocumentCount(),
    ]);

    const listStats = await Promise.all(
      lists.map(async (list) => ({
        id: String(list._id),
        name: list.name,
        active: list.active,
        confirmed: await c.subscribers.countDocuments({ listId: list._id, status: 'confirmed' }),
        pending: await c.subscribers.countDocuments({ listId: list._id, status: 'pending' }),
        unsubscribed: await c.subscribers.countDocuments({ listId: list._id, status: 'unsubscribed' }),
      })),
    );

    return NextResponse.json({
      reputation,
      health,
      lists: listStats,
      activeCampaigns: active,
      recentCampaigns: recent,
      suppressionCount,
    });
  });
}
