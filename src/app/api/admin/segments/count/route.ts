import { ObjectId } from 'mongodb';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { badRequest, handle, parseJson } from '@/lib/api';
import { requireAdmin } from '@/lib/auth';
import { countSegment, describeSegment } from '@/lib/segments';
import { segmentQuerySchema } from '@/lib/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  listId: z.string(),
  query: segmentQuerySchema,
});

/**
 * The live count behind the segment dropdowns (§4.2).
 *
 * This number is for the operator's benefit only. It is never trusted at send
 * time — the recipient set is re-derived at freeze from the same query.
 */
export async function POST(request: Request) {
  return handle(async () => {
    await requireAdmin();
    const body = await parseJson(request, schema);
    if (!ObjectId.isValid(body.listId)) return badRequest('Invalid listId');

    const count = await countSegment(new ObjectId(body.listId), body.query);
    return NextResponse.json({ count, description: describeSegment(body.query) });
  });
}
