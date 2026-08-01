import { badRequest, toObjectId, withAdmin } from '@/lib/api/guard';
import { exportSubscribersCsv, exportSuppressionsCsv } from '@/lib/csv/export';
import type { SubscriberStatus } from '@/lib/types';
import { SUBSCRIBER_STATUSES } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * CSV export (section 4.4). Exists partly so this application is never a
 * lock-in trap, so it works on day one and includes consent evidence.
 */
export const GET = withAdmin(async (request) => {
  const url = new URL(request.url);
  const what = url.searchParams.get('what') ?? 'subscribers';

  if (what === 'suppressions') {
    return csvResponse(await exportSuppressionsCsv(), 'suppressions.csv');
  }

  const listId = toObjectId(url.searchParams.get('listId') ?? undefined);
  if (!listId) return badRequest('a valid listId is required');

  const statusParam = url.searchParams.get('status') ?? undefined;
  const status = SUBSCRIBER_STATUSES.includes(statusParam as SubscriberStatus)
    ? (statusParam as SubscriberStatus)
    : undefined;

  const csv = await exportSubscribersCsv({ listId, status });
  return csvResponse(csv, `subscribers-${listId.toHexString()}.csv`);
});

function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}
