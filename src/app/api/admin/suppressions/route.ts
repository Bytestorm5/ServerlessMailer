import { NextResponse } from 'next/server';
import { z } from 'zod';
import { collections } from '@/lib/db';
import { handle, parseJson } from '@/lib/api';
import { requireAdmin } from '@/lib/auth';
import { isSyntacticallyValid, normalizeEmail } from '@/lib/email-address';
import { suppress, unsuppress } from '@/lib/suppressions';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Suppression list view with reason and origin, plus manual add (§4.5). */
export async function GET(request: Request) {
  return handle(async () => {
    await requireAdmin();
    const url = new URL(request.url);
    const c = await collections();

    const filter: Record<string, unknown> = {};
    const search = url.searchParams.get('q')?.trim();
    if (search) filter.email = normalizeEmail(search);
    const reason = url.searchParams.get('reason');
    if (reason) filter.reason = reason;

    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
    const page = Math.max(0, Number(url.searchParams.get('page') ?? 0));

    const [suppressions, total] = await Promise.all([
      c.suppressions.find(filter).sort({ createdAt: -1 }).skip(page * limit).limit(limit).toArray(),
      c.suppressions.countDocuments(filter),
    ]);

    return NextResponse.json({ suppressions, total, page, limit });
  });
}

const addSchema = z.object({
  emails: z.array(z.string().max(254)).min(1).max(5000),
  reason: z.enum(['manual', 'import', 'hard_bounce', 'complaint']).default('manual'),
  detail: z.string().max(500).optional(),
});

export async function POST(request: Request) {
  return handle(async () => {
    const admin = await requireAdmin();
    const body = await parseJson(request, addSchema);
    const c = await collections();

    let added = 0;
    let invalid = 0;
    const now = new Date();

    for (const raw of body.emails) {
      const email = normalizeEmail(raw);
      if (!isSyntacticallyValid(email)) {
        invalid += 1;
        continue;
      }
      const result = await suppress({
        email,
        reason: body.reason,
        detail: body.detail ?? `Added by ${admin.email}`,
      });
      if (result.created) added += 1;

      // A suppressed address must also stop being a live subscriber anywhere.
      await c.subscribers.updateMany(
        { email, status: { $in: ['pending', 'confirmed'] } },
        {
          $set: {
            status: 'unsubscribed',
            unsubscribedAt: now,
            unsubscribeSource: 'admin',
            updatedAt: now,
          },
        },
      );
    }

    return NextResponse.json({ ok: true, added, invalid });
  });
}

const removeSchema = z.object({ email: z.string().max(254) });

/**
 * Removing a suppression is a deliberate, logged act. It does not resubscribe
 * anyone — the subscriber record has to be changed separately, which keeps
 * "this address is deliverable again" and "this person wants our email" as two
 * distinct decisions.
 */
export async function DELETE(request: Request) {
  return handle(async () => {
    const admin = await requireAdmin();
    const body = await parseJson(request, removeSchema);
    const email = normalizeEmail(body.email);
    const removed = await unsuppress(email);
    log.warn('suppression removed by operator', { by: admin.email, domain: email.split('@')[1] });
    return NextResponse.json({ ok: removed });
  });
}
