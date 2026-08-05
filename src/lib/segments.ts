import type { Filter, ObjectId } from 'mongodb';
import {
  campaignsCollection,
  eventsCollection,
  sentLogCollection,
  subscribersCollection,
  suppressionsCollection,
} from '@/lib/db/collections';
import type { SegmentQuery, SubscriberDoc } from '@/lib/types';

/**
 * Segments are a saved query evaluated at send-freeze time (spec §4.2).
 *
 * The count shown in the UI is advisory only — it is always re-derived here at
 * freeze time, and never trusted from the client.
 */

/** Attribute keys are interpolated into a dotted path, so they must be inert. */
const SAFE_ATTRIBUTE_KEY = /^[A-Za-z0-9_-]{1,64}$/;

function assertSafeAttributeKey(key: string): void {
  if (!SAFE_ATTRIBUTE_KEY.test(key)) {
    throw new Error(
      `Unsafe segment attribute key: ${JSON.stringify(key)}. ` +
        'Attribute keys may contain only letters, numbers, underscore and hyphen.',
    );
  }
}

function parseDate(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    // Falling back to "no constraint" here would silently widen the segment,
    // which at this volume means mailing people the operator meant to exclude.
    throw new Error(`Invalid ${field} in segment query: ${JSON.stringify(value)}`);
  }
  return parsed;
}

/**
 * Builds the Mongo filter for everything except engagement, which needs a join
 * against `events` and is applied separately.
 */
export function segmentToFilter(
  listId: ObjectId,
  query: SegmentQuery,
): Filter<SubscriberDoc> {
  const filter: Record<string, unknown> = {
    listId,
    // Always last-word: only confirmed subscribers are ever sent a campaign.
    status: 'confirmed',
  };

  if (query.signedUpAfter || query.signedUpBefore) {
    const range: Record<string, Date> = {};
    if (query.signedUpAfter) range.$gte = parseDate(query.signedUpAfter, 'signedUpAfter');
    if (query.signedUpBefore) range.$lt = parseDate(query.signedUpBefore, 'signedUpBefore');
    filter.createdAt = range;
  }

  if (query.source) filter.source = query.source;

  // `first_name`/`last_name` are first-party fields; documents written before
  // that may still hold them in `attributes`. Each name constraint becomes an
  // $or over both locations, collected into $and so several name constraints
  // do not clobber one another.
  const nameField: Record<string, 'firstName' | 'lastName'> = {
    first_name: 'firstName',
    last_name: 'lastName',
  };
  const clauses: Record<string, unknown>[] = [];

  for (const { key, value } of query.attributeEquals ?? []) {
    assertSafeAttributeKey(key);
    const field = nameField[key];
    if (field) {
      clauses.push({
        $or: [
          { [field]: value },
          // The legacy value only counts where no first-party value overrides it.
          { [field]: { $in: [null, ''] }, [`attributes.${key}`]: value },
        ],
      });
    } else {
      filter[`attributes.${key}`] = value;
    }
  }

  for (const key of query.attributeExists ?? []) {
    assertSafeAttributeKey(key);
    // "Exists" means usable as a merge value, so blanks do not count.
    const usable = { $exists: true, $nin: [null, ''] };
    const field = nameField[key];
    if (field) {
      clauses.push({ $or: [{ [field]: usable }, { [`attributes.${key}`]: usable }] });
    } else {
      filter[`attributes.${key}`] = usable;
    }
  }

  if (clauses.length > 0) filter.$and = clauses;

  return filter as Filter<SubscriberDoc>;
}

/**
 * Subscriber ids that opened at least one of the list's last N campaigns.
 * Returns null when the query does not constrain on engagement.
 */
async function engagedSubscriberIds(
  listId: ObjectId,
  lastN: number | undefined,
): Promise<ObjectId[] | null> {
  if (!lastN || lastN <= 0) return null;

  const campaigns = await (await campaignsCollection())
    .find(
      { listId, status: 'sent' },
      { projection: { _id: 1 }, sort: { completedAt: -1 }, limit: lastN },
    )
    .toArray();

  if (campaigns.length === 0) return [];

  const ids = await (await eventsCollection()).distinct('subscriberId', {
    campaignId: { $in: campaigns.map((c) => c._id) },
    type: 'open',
  });

  return ids.filter((id): id is ObjectId => id != null);
}

export async function countSegment(
  listId: ObjectId,
  query: SegmentQuery,
): Promise<number> {
  const filter = segmentToFilter(listId, query) as Record<string, unknown>;
  const engaged = await engagedSubscriberIds(listId, query.openedInLastNCampaigns);
  if (engaged !== null) filter._id = { $in: engaged };

  return (await subscribersCollection()).countDocuments(filter as Filter<SubscriberDoc>);
}

/**
 * The freeze-time recipient set (§7.1 step 2). Applies the full exclusion list:
 * not confirmed, in `suppressions`, or already in `sent_log` for this campaign.
 *
 * Streams rather than loading every subscriber document, because the largest
 * list is ~19,000 and only the ids are needed.
 */
export async function resolveSegmentRecipients(input: {
  listId: ObjectId;
  query: SegmentQuery;
  campaignId: ObjectId;
}): Promise<ObjectId[]> {
  const filter = segmentToFilter(input.listId, input.query) as Record<string, unknown>;
  const engaged = await engagedSubscriberIds(
    input.listId,
    input.query.openedInLastNCampaigns,
  );
  if (engaged !== null) filter._id = { $in: engaged };

  // Anyone already sent this campaign is excluded up front — this is what makes
  // re-freezing a partially-sent campaign safe.
  const alreadySent = new Set(
    (
      await (await sentLogCollection())
        .find({ campaignId: input.campaignId }, { projection: { subscriberId: 1 } })
        .toArray()
    ).map((doc) => doc.subscriberId.toHexString()),
  );

  const suppressions = await suppressionsCollection();
  const candidates = (await subscribersCollection())
    .find(filter as Filter<SubscriberDoc>, { projection: { _id: 1, email: 1 } })
    .sort({ _id: 1 });

  const recipients: ObjectId[] = [];
  let buffer: { _id: ObjectId; email: string }[] = [];

  const flush = async () => {
    if (buffer.length === 0) return;
    const suppressed = new Set(
      (
        await suppressions
          .find(
            { email: { $in: buffer.map((s) => s.email) } },
            { projection: { email: 1 } },
          )
          .toArray()
      ).map((doc) => doc.email),
    );
    for (const candidate of buffer) {
      if (suppressed.has(candidate.email)) continue;
      if (alreadySent.has(candidate._id.toHexString())) continue;
      recipients.push(candidate._id);
    }
    buffer = [];
  };

  for await (const doc of candidates) {
    buffer.push({ _id: doc._id, email: doc.email });
    if (buffer.length >= 1000) await flush();
  }
  await flush();

  return recipients;
}
