import { ObjectId, type Filter } from 'mongodb';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { collections } from '@/lib/db';
import { badRequest, handle, parseJson } from '@/lib/api';
import { requireAdmin } from '@/lib/auth';
import { EMPTY_COUNTS } from '@/lib/campaigns';
import { EMPTY_SEGMENT } from '@/lib/segments';
import type { CampaignDoc, CampaignStatus } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES: CampaignStatus[] = ['draft', 'scheduled', 'sending', 'paused', 'sent', 'failed'];

export async function GET(request: Request) {
  return handle(async () => {
    await requireAdmin();
    const url = new URL(request.url);
    const c = await collections();

    const filter: Filter<CampaignDoc> = {};
    const listId = url.searchParams.get('listId');
    if (listId && ObjectId.isValid(listId)) filter.listId = new ObjectId(listId);
    const status = url.searchParams.get('status');
    if (status && STATUSES.includes(status as CampaignStatus)) filter.status = status as CampaignStatus;

    const campaigns = await c.campaigns
      .find(filter, { projection: { bodySource: 0, bodyHtml: 0, bodyText: 0 } })
      .sort({ updatedAt: -1 })
      .limit(200)
      .toArray();

    const lists = await c.lists.find({}, { projection: { name: 1 } }).toArray();
    const listNames = Object.fromEntries(lists.map((list) => [String(list._id), list.name]));

    return NextResponse.json({ campaigns, listNames });
  });
}

const createSchema = z.object({
  listId: z.string(),
  name: z.string().min(1).max(200).default('Untitled campaign'),
  subject: z.string().max(300).default(''),
});

export async function POST(request: Request) {
  return handle(async () => {
    await requireAdmin();
    const body = await parseJson(request, createSchema);
    if (!ObjectId.isValid(body.listId)) return badRequest('Invalid listId');

    const c = await collections();
    const now = new Date();

    const result = await c.campaigns.insertOne({
      listId: new ObjectId(body.listId),
      name: body.name,
      subject: body.subject,
      preheader: '',
      bodySource: { type: 'doc', content: [{ type: 'paragraph' }] },
      bodyHtml: null,
      bodyText: null,
      subjectTemplate: null,
      mergePlan: null,
      trackedLinks: null,
      status: 'draft',
      segmentQuery: EMPTY_SEGMENT,
      scheduledFor: null,
      frozenAt: null,
      startedAt: null,
      completedAt: null,
      pausedAt: null,
      pauseReason: null,
      trackOpens: false,
      trackClicks: false,
      counts: { ...EMPTY_COUNTS },
      createdAt: now,
      updatedAt: now,
      lastEditedAt: now,
    } as never);

    return NextResponse.json({ ok: true, id: String(result.insertedId) }, { status: 201 });
  });
}
