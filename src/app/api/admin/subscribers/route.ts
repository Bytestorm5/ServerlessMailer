import { ObjectId, type Filter } from 'mongodb';
import { NextResponse } from 'next/server';
import { collections } from '@/lib/db';
import { handle } from '@/lib/api';
import { requireAdmin } from '@/lib/auth';
import { normalizeEmail } from '@/lib/email-address';
import type { SubscriberDoc, SubscriberStatus } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES: SubscriberStatus[] = ['pending', 'confirmed', 'unsubscribed', 'bounced', 'complained'];

/** Subscriber list with search, status filter and sorting (§4.5). */
export async function GET(request: Request) {
  return handle(async () => {
    await requireAdmin();
    const url = new URL(request.url);
    const c = await collections();

    const filter: Filter<SubscriberDoc> = {};

    const listId = url.searchParams.get('listId');
    if (listId && ObjectId.isValid(listId)) filter.listId = new ObjectId(listId);

    const status = url.searchParams.get('status');
    if (status && STATUSES.includes(status as SubscriberStatus)) filter.status = status as SubscriberStatus;

    const search = url.searchParams.get('q')?.trim();
    if (search) {
      const normalized = normalizeEmail(search);
      // Exact match first (it hits the unique index); otherwise an anchored
      // prefix search, which can still use the index. No unanchored regex —
      // that is a collection scan over 33,000 documents on every keystroke.
      filter.email = search.includes('@')
        ? normalized
        : { $regex: `^${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, $options: 'i' };
    }

    const sortField = url.searchParams.get('sort') === 'email' ? 'email' : 'createdAt';
    const sortDirection = url.searchParams.get('dir') === 'asc' ? 1 : -1;

    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
    const page = Math.max(0, Number(url.searchParams.get('page') ?? 0));

    const [subscribers, total] = await Promise.all([
      c.subscribers
        .find(filter)
        .sort({ [sortField]: sortDirection })
        .skip(page * limit)
        .limit(limit)
        .toArray(),
      c.subscribers.countDocuments(filter),
    ]);

    return NextResponse.json({ subscribers, total, page, limit });
  });
}
