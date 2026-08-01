import { ObjectId, type Filter } from 'mongodb';
import { collections } from './db';
import type { SegmentQuery, SubscriberDoc } from './types';

/**
 * Segmentation (§4.2).
 *
 * A segment is a saved query, not a materialized list. It is evaluated at
 * send-freeze time and the count shown in the UI is never trusted — it is
 * re-derived from the same code path that builds the recipient set.
 */

/** The half of the filter that needs no database access — pure, and tested as such. */
export function baseSegmentFilter(listId: ObjectId, query: SegmentQuery): Filter<SubscriberDoc> {
  // Status is always implicitly `confirmed`. It is not a user-selectable
  // dropdown, because there is no legitimate segment that includes anyone else.
  const filter: Filter<SubscriberDoc> = { listId, status: 'confirmed' };

  const createdAt: Record<string, Date> = {};
  if (query.signupAfter) {
    const date = new Date(query.signupAfter);
    if (!Number.isNaN(date.getTime())) createdAt.$gte = date;
  }
  if (query.signupBefore) {
    const date = new Date(query.signupBefore);
    if (!Number.isNaN(date.getTime())) createdAt.$lte = date;
  }
  if (Object.keys(createdAt).length > 0) filter.createdAt = createdAt;

  if (query.sources && query.sources.length > 0) {
    filter.source = { $in: query.sources };
  }

  for (const attribute of query.attributes ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(attribute.key)) continue;
    const path = `attributes.${attribute.key}`;
    switch (attribute.op) {
      case 'eq':
        (filter as Record<string, unknown>)[path] = attribute.value ?? '';
        break;
      case 'ne':
        (filter as Record<string, unknown>)[path] = { $ne: attribute.value ?? '' };
        break;
      case 'exists':
        (filter as Record<string, unknown>)[path] = { $exists: true, $nin: ['', null] };
        break;
      case 'not_exists':
        (filter as Record<string, unknown>)[path] = { $in: ['', null] };
        break;
    }
  }

  return filter;
}

/**
 * Full filter, including the engagement clause, which needs the recent
 * campaign history. Used by both the live count and the freeze.
 */
export async function buildSegmentFilter(
  listId: ObjectId,
  query: SegmentQuery,
): Promise<Filter<SubscriberDoc>> {
  const filter = baseSegmentFilter(listId, query);

  const n = query.openedInLastNCampaigns;
  if (n && n > 0) {
    const engaged = await subscribersWhoOpenedRecently(listId, n);
    filter._id = { $in: engaged };
  }

  return filter;
}

/**
 * Subscribers with at least one open across the list's N most recent completed
 * campaigns. This is what makes the §10.4 warm-up plan — most-engaged segments
 * first — expressible in the UI.
 */
export async function subscribersWhoOpenedRecently(listId: ObjectId, n: number): Promise<ObjectId[]> {
  const c = await collections();
  const recent = await c.campaigns
    .find({ listId, status: 'sent' }, { projection: { _id: 1 } })
    .sort({ completedAt: -1 })
    .limit(Math.min(50, n))
    .toArray();

  if (recent.length === 0) return [];

  const ids = await c.events.distinct('subscriberId', {
    campaignId: { $in: recent.map((campaign) => campaign._id) },
    type: 'open',
  });

  return ids.filter((id): id is ObjectId => id instanceof ObjectId);
}

export async function countSegment(listId: ObjectId, query: SegmentQuery): Promise<number> {
  const c = await collections();
  const filter = await buildSegmentFilter(listId, query);
  return c.subscribers.countDocuments(filter);
}

/** Human-readable summary for the send-confirmation modal (§6.7). */
export function describeSegment(query: SegmentQuery): string {
  const parts: string[] = ['confirmed subscribers'];
  if (query.signupAfter) parts.push(`signed up on or after ${query.signupAfter}`);
  if (query.signupBefore) parts.push(`signed up on or before ${query.signupBefore}`);
  if (query.sources && query.sources.length > 0) parts.push(`source in ${query.sources.join(', ')}`);
  for (const attribute of query.attributes ?? []) {
    switch (attribute.op) {
      case 'eq':
        parts.push(`${attribute.key} = "${attribute.value ?? ''}"`);
        break;
      case 'ne':
        parts.push(`${attribute.key} ≠ "${attribute.value ?? ''}"`);
        break;
      case 'exists':
        parts.push(`has ${attribute.key}`);
        break;
      case 'not_exists':
        parts.push(`no ${attribute.key}`);
        break;
    }
  }
  if (query.openedInLastNCampaigns) {
    parts.push(`opened at least one of the last ${query.openedInLastNCampaigns} campaigns`);
  }
  return parts.join(', ');
}

export const EMPTY_SEGMENT: SegmentQuery = {
  signupAfter: null,
  signupBefore: null,
  sources: null,
  attributes: null,
  openedInLastNCampaigns: null,
};
