import { ObjectId, type Filter } from 'mongodb';
import { NextResponse } from 'next/server';
import { handle } from '@/lib/api';
import { requireAdmin } from '@/lib/auth';
import { listAttributeKeys, streamSubscribersCsv } from '@/lib/export';
import { buildSegmentFilter } from '@/lib/segments';
import type { SegmentQuery, SubscriberDoc, SubscriberStatus } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const STATUSES: SubscriberStatus[] = ['pending', 'confirmed', 'unsubscribed', 'bounced', 'complained'];

/**
 * Full CSV export of any list or segment, including status and consent
 * evidence fields (§4.4).
 *
 * `?segment=<json>` exports a segment; otherwise `?status=` filters, and
 * omitting both exports the whole list including tombstones.
 */
export async function GET(request: Request) {
  return handle(async () => {
    await requireAdmin();
    const url = new URL(request.url);

    const listIdParam = url.searchParams.get('listId');
    if (!listIdParam || !ObjectId.isValid(listIdParam)) {
      return NextResponse.json({ error: 'listId is required' }, { status: 400 });
    }
    const listId = new ObjectId(listIdParam);

    let filter: Filter<SubscriberDoc>;
    const segmentParam = url.searchParams.get('segment');
    if (segmentParam) {
      let query: SegmentQuery;
      try {
        query = JSON.parse(segmentParam) as SegmentQuery;
      } catch {
        return NextResponse.json({ error: 'segment must be valid JSON' }, { status: 400 });
      }
      filter = await buildSegmentFilter(listId, query);
    } else {
      filter = { listId };
      const status = url.searchParams.get('status');
      if (status && STATUSES.includes(status as SubscriberStatus)) {
        filter.status = status as SubscriberStatus;
      }
    }

    const attributeKeys = await listAttributeKeys({ listId });
    const stamp = new Date().toISOString().slice(0, 10);

    return new NextResponse(streamSubscribersCsv(filter, attributeKeys), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="subscribers-${listIdParam}-${stamp}.csv"`,
        'cache-control': 'no-store',
      },
    });
  });
}
