import { NextResponse } from 'next/server';
import { z } from 'zod';
import { collections } from '@/lib/db';
import { handle, parseJson } from '@/lib/api';
import { requireAdmin } from '@/lib/auth';
import { normalizeEmail } from '@/lib/email-address';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return handle(async () => {
    await requireAdmin();
    const c = await collections();
    const lists = await c.lists.find({}).sort({ name: 1 }).toArray();

    // Subscriber counts per list, in one pass rather than one query per list.
    const counts = await c.subscribers
      .aggregate<{ _id: { listId: unknown; status: string }; n: number }>([
        { $group: { _id: { listId: '$listId', status: '$status' }, n: { $sum: 1 } } },
      ])
      .toArray();

    const byList = new Map<string, Record<string, number>>();
    for (const row of counts) {
      const key = String(row._id.listId);
      const entry = byList.get(key) ?? {};
      entry[row._id.status] = row.n;
      byList.set(key, entry);
    }

    return NextResponse.json({
      lists: lists.map((list) => ({ ...list, counts: byList.get(String(list._id)) ?? {} })),
    });
  });
}

const createSchema = z.object({
  name: z.string().min(1).max(120),
  sendingDomain: z.string().min(3).max(253),
  fromName: z.string().min(1).max(120),
  fromEmail: z.string().min(3).max(254),
  replyTo: z.string().min(3).max(254),
  physicalAddress: z.string().min(1).max(500),
  sesConfigurationSet: z.string().max(120).default(''),
  welcomeUrl: z.string().max(500).optional(),
  mergeFields: z.array(z.string().regex(/^[a-z_][a-z0-9_]*$/)).default([]),
  seedEmails: z.array(z.string().max(254)).default([]),
  active: z.boolean().default(true),
});

export async function POST(request: Request) {
  return handle(async () => {
    await requireAdmin();
    const body = await parseJson(request, createSchema);
    const c = await collections();
    const now = new Date();

    const result = await c.lists.insertOne({
      ...body,
      fromEmail: normalizeEmail(body.fromEmail),
      replyTo: normalizeEmail(body.replyTo),
      seedEmails: body.seedEmails.map(normalizeEmail),
      createdAt: now,
      updatedAt: now,
    } as never);

    return NextResponse.json({ ok: true, id: String(result.insertedId) }, { status: 201 });
  });
}
