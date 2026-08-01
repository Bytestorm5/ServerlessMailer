import type { Filter, ObjectId } from 'mongodb';
import { subscribersCollection, suppressionsCollection } from '@/lib/db/collections';
import { serializeCsv } from '@/lib/csv/parse';
import { segmentToFilter } from '@/lib/segments';
import type { SegmentQuery, SubscriberDoc, SubscriberStatus } from '@/lib/types';

/**
 * CSV export (spec §4.4).
 *
 * Export exists partly so this application is never a lock-in trap, so it
 * includes everything: status, the full consent evidence, and every attribute.
 * It should work on day one.
 */

const BASE_HEADERS = [
  'email',
  'status',
  'source',
  'created_at',
  'confirmed_at',
  'confirm_ip',
  'confirm_user_agent',
  'unsubscribed_at',
  'unsubscribe_source',
];

const iso = (value: Date | undefined) => (value ? value.toISOString() : '');

export async function exportSubscribersCsv(input: {
  listId: ObjectId;
  query?: SegmentQuery;
  status?: SubscriberStatus;
}): Promise<string> {
  const collection = await subscribersCollection();

  // A segment query implies confirmed-only; an explicit status filter is used
  // as given so an operator can export their bounces or unsubscribes.
  let filter: Filter<SubscriberDoc>;
  if (input.query) {
    filter = segmentToFilter(input.listId, input.query);
  } else {
    filter = {
      listId: input.listId,
      ...(input.status ? { status: input.status } : {}),
    } as Filter<SubscriberDoc>;
  }

  const docs = await collection.find(filter).sort({ createdAt: 1 }).toArray();

  // Attribute columns are the union across the export, so no data is lost.
  const attributeKeys = [
    ...new Set(docs.flatMap((doc) => Object.keys(doc.attributes ?? {}))),
  ].sort();

  const headers = [...BASE_HEADERS, ...attributeKeys];
  const rows = docs.map((doc) => [
    doc.email,
    doc.status,
    doc.source,
    iso(doc.createdAt),
    iso(doc.confirmedAt),
    doc.confirmIp ?? '',
    doc.confirmUserAgent ?? '',
    iso(doc.unsubscribedAt),
    doc.unsubscribeSource ?? '',
    ...attributeKeys.map((key) => doc.attributes?.[key] ?? ''),
  ]);

  return serializeCsv(headers, rows);
}

/** The suppression list exports separately (§4.4). */
export async function exportSuppressionsCsv(): Promise<string> {
  const docs = await (await suppressionsCollection())
    .find({})
    .sort({ createdAt: 1 })
    .toArray();

  return serializeCsv(
    ['email', 'reason', 'created_at', 'source_campaign_id', 'detail'],
    docs.map((doc) => [
      doc.email,
      doc.reason,
      iso(doc.createdAt),
      doc.sourceCampaignId?.toHexString() ?? '',
      doc.detail ?? '',
    ]),
  );
}
