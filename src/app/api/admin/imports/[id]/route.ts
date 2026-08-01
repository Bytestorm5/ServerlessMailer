import { ObjectId } from 'mongodb';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { collections } from '@/lib/db';
import { badRequest, handle, notFound, parseJson } from '@/lib/api';
import { requireAdmin } from '@/lib/auth';
import { processImportChunk } from '@/lib/import';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    await requireAdmin();
    const { id } = await params;
    if (!ObjectId.isValid(id)) return notFound();

    const c = await collections();
    const job = await c.importJobs.findOne({ _id: new ObjectId(id) });
    if (!job) return notFound();
    return NextResponse.json({ job });
  });
}

const chunkSchema = z.object({
  action: z.literal('chunk'),
  /** Rows are parsed in the browser; 500 per request keeps each one well
   * inside the function time limit. */
  rows: z.array(z.record(z.string())).max(1000),
  startingRowNumber: z.number().int().min(1),
});

const completeSchema = z.object({ action: z.literal('complete') });

const bodySchema = z.union([chunkSchema, completeSchema]);

/**
 * Import chunk processor (§4.3).
 *
 * The browser parses the CSV and posts it in slices. 33,000 rows will not
 * process inside one serverless invocation, and chunking also gives the
 * operator a live progress count and a per-row error report.
 */
export async function POST(request: Request, { params }: Params) {
  return handle(async () => {
    await requireAdmin();
    const { id } = await params;
    if (!ObjectId.isValid(id)) return notFound();

    const body = await parseJson(request, bodySchema);
    const c = await collections();
    const job = await c.importJobs.findOne({ _id: new ObjectId(id) });
    if (!job) return notFound();

    if (body.action === 'complete') {
      await c.importJobs.updateOne(
        { _id: job._id },
        { $set: { status: 'completed', completedAt: new Date() } },
      );
      const finished = await c.importJobs.findOne({ _id: job._id });
      return NextResponse.json({ ok: true, job: finished });
    }

    if (job.status !== 'open') return badRequest('This import is already closed.');

    const result = await processImportChunk(job, body.rows, body.startingRowNumber);
    return NextResponse.json({ ok: true, ...result });
  });
}
