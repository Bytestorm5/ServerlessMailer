import { NextResponse } from 'next/server';
import { handle } from '@/lib/api';
import { requireAdmin } from '@/lib/auth';
import { streamSuppressionsCsv } from '@/lib/export';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** The suppression list exports separately (§4.4) — and is the half of a
 * migration people forget (§14). */
export async function GET() {
  return handle(async () => {
    await requireAdmin();
    const stamp = new Date().toISOString().slice(0, 10);

    return new NextResponse(streamSuppressionsCsv(), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="suppressions-${stamp}.csv"`,
        'cache-control': 'no-store',
      },
    });
  });
}
