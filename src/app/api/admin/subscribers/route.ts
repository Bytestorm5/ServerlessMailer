import { toObjectId, withAdmin } from '@/lib/api/guard';
import { findSubscribers } from '@/lib/subscribers';
import type { SubscriberStatus } from '@/lib/types';
import { SUBSCRIBER_STATUSES } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAdmin(async (request) => {
  const url = new URL(request.url);
  const statusParam = url.searchParams.get('status') ?? undefined;
  const status = SUBSCRIBER_STATUSES.includes(statusParam as SubscriberStatus)
    ? (statusParam as SubscriberStatus)
    : undefined;

  const sortParam = url.searchParams.get('sort');
  const limit = Number(url.searchParams.get('limit') ?? 50);
  const skip = Number(url.searchParams.get('skip') ?? 0);

  const result = await findSubscribers({
    listId: toObjectId(url.searchParams.get('listId') ?? undefined) ?? undefined,
    status,
    search: url.searchParams.get('search') ?? undefined,
    sort: sortParam === 'email' ? 'email' : 'createdAt',
    direction: url.searchParams.get('direction') === 'asc' ? 1 : -1,
    limit: Number.isFinite(limit) ? limit : 50,
    skip: Number.isFinite(skip) ? skip : 0,
  });

  return Response.json({
    ok: true,
    total: result.total,
    subscribers: result.items.map((doc) => ({
      id: doc._id.toHexString(),
      email: doc.email,
      status: doc.status,
      source: doc.source,
      createdAt: doc.createdAt,
      confirmedAt: doc.confirmedAt ?? null,
      attributes: doc.attributes,
    })),
  });
});
