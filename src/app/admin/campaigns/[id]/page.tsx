import { notFound } from 'next/navigation';
import { ObjectId } from 'mongodb';
import {
  campaignBatchesCollection,
  campaignsCollection,
  eventsCollection,
  listsCollection,
  subscribersCollection,
} from '@/lib/db/collections';
import { listCampaignVersions } from '@/lib/campaigns';
import { config } from '@/lib/config';
import { AVAILABLE_MERGE_FIELDS } from '@/lib/merge';
import { subscriberMergeData } from '@/lib/subscriber-name';
import { CampaignWorkspace } from '@/components/admin/CampaignWorkspace';

export const dynamic = 'force-dynamic';

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ObjectId.isValid(id)) notFound();

  const campaign = await (await campaignsCollection()).findOne({ _id: new ObjectId(id) });
  if (!campaign) notFound();
  const list = await (await listsCollection()).findOne({ _id: campaign.listId });
  if (!list) notFound();

  // A handful of real subscribers, so preview merge data is real data and
  // fallbacks actually get exercised (spec section 6.3).
  const previewSubscribers = await (await subscribersCollection())
    .find({ listId: campaign.listId, status: 'confirmed' })
    .limit(10)
    .toArray();

  const versions = await listCampaignVersions(campaign._id, 20);

  // Failed batches are surfaced with their lastError for manual review (§7.6),
  // and the top clicked links complete the campaign report (§13).
  const failedBatches = await (await campaignBatchesCollection())
    .find({ campaignId: campaign._id, status: 'failed' })
    .limit(50)
    .toArray();

  const topLinks = campaign.trackClicks
    ? await (await eventsCollection())
        .aggregate<{ _id: string; clicks: number }>([
          { $match: { campaignId: campaign._id, type: 'click' } },
          { $group: { _id: '$url', clicks: { $sum: 1 } } },
          { $sort: { clicks: -1 } },
          { $limit: 10 },
        ])
        .toArray()
    : [];

  return (
    <CampaignWorkspace
      campaignId={campaign._id.toHexString()}
      status={campaign.status}
      pausedReason={campaign.pausedReason ?? null}
      counts={campaign.counts}
      trackOpens={campaign.trackOpens}
      trackClicks={campaign.trackClicks}
      failedBatches={failedBatches.map((batch) => ({
        id: batch._id.toHexString(),
        recipients: batch.subscriberIds.length,
        attempts: batch.attempts,
        lastError: batch.lastError ?? 'no error recorded',
      }))}
      topLinks={topLinks
        .filter((row) => typeof row._id === 'string')
        .map((row) => ({ url: row._id, clicks: row.clicks }))}
      listId={campaign.listId.toHexString()}
      initialDraft={{
        subject: campaign.subject,
        preheader: campaign.preheader,
        bodySource: campaign.bodySource,
        bodyMode: campaign.bodyMode ?? 'rich',
        bodyHtmlSource: campaign.bodyHtmlSource ?? '',
        segmentQuery: campaign.segmentQuery,
      }}
      list={{
        name: list.name,
        fromName: list.fromName,
        fromEmail: list.fromEmail,
        replyTo: list.replyTo,
      }}
      mergeFields={AVAILABLE_MERGE_FIELDS.map((field) => ({
        key: field.key,
        label: field.label,
        description: field.description,
        system: field.system,
      }))}
      previewSubscribers={previewSubscribers.map((subscriber) => {
        // Merge data rather than raw attributes, so first-party names show up.
        const data = subscriberMergeData(subscriber);
        return {
          id: subscriber._id.toHexString(),
          email: subscriber.email,
          label: `${subscriber.email}${
            Object.keys(data).length
              ? ` — ${Object.entries(data)
                  .map(([key, value]) => `${key}: ${value}`)
                  .join(', ')}`
              : ' — no attributes'
          }`,
        };
      })}
      versions={versions.map((version) => ({
        id: version._id.toHexString(),
        createdAt: version.createdAt.toISOString(),
        subject: version.subject,
      }))}
      typedConfirmationThreshold={config.typedConfirmationThreshold()}
    />
  );
}
