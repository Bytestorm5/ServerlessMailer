import { ObjectId } from 'mongodb';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { collections } from '@/lib/db';
import { badRequest, handle, parseJson } from '@/lib/api';
import { requireAdmin } from '@/lib/auth';
import { ATTESTATION_TEXT, createImportJob } from '@/lib/import';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  listId: z.string(),
  filename: z.string().max(300),
  mapping: z.record(z.string().max(200)),
  /**
   * The operator affirmatively attests prior opt-in consent (§4.3). Without
   * it, imported addresses land as `pending` and receive a confirmation email.
   */
  attested: z.boolean(),
});

export async function GET(request: Request) {
  return handle(async () => {
    await requireAdmin();
    const url = new URL(request.url);
    const c = await collections();
    const filter: Record<string, unknown> = {};
    const listId = url.searchParams.get('listId');
    if (listId && ObjectId.isValid(listId)) filter.listId = new ObjectId(listId);

    const jobs = await c.importJobs.find(filter).sort({ createdAt: -1 }).limit(50).toArray();
    return NextResponse.json({ jobs, attestationText: ATTESTATION_TEXT });
  });
}

export async function POST(request: Request) {
  return handle(async () => {
    const admin = await requireAdmin();
    const body = await parseJson(request, schema);
    if (!ObjectId.isValid(body.listId)) return badRequest('Invalid listId');
    if (!body.mapping.email) return badRequest('The mapping must include an "email" column.');

    const job = await createImportJob({
      listId: new ObjectId(body.listId),
      filename: body.filename,
      mapping: body.mapping,
      attested: body.attested,
      attestedBy: admin.email,
    });

    log.info('import job created', {
      jobId: String(job._id),
      listId: body.listId,
      attested: body.attested,
      by: admin.email,
    });

    return NextResponse.json({ ok: true, jobId: String(job._id) }, { status: 201 });
  });
}
