import { ObjectId } from 'mongodb';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { collections } from '@/lib/db';
import { handle, notFound, parseJson } from '@/lib/api';
import { requireAdmin } from '@/lib/auth';
import { normalizeEmail } from '@/lib/email-address';
import { getMailer } from '@/lib/mailer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    await requireAdmin();
    const { id } = await params;
    if (!ObjectId.isValid(id)) return notFound();

    const c = await collections();
    const list = await c.lists.findOne({ _id: new ObjectId(id) });
    if (!list) return notFound();

    // Surfaced here so a misconfigured identity is visible before send day,
    // not at the pre-send gate five minutes before a campaign goes out.
    let identityVerified: boolean | null = null;
    try {
      identityVerified = await getMailer().isIdentityVerified(list.fromEmail);
    } catch {
      identityVerified = null;
    }

    return NextResponse.json({ list, identityVerified });
  });
}

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  sendingDomain: z.string().min(3).max(253).optional(),
  fromName: z.string().min(1).max(120).optional(),
  fromEmail: z.string().min(3).max(254).optional(),
  replyTo: z.string().min(3).max(254).optional(),
  physicalAddress: z.string().min(1).max(500).optional(),
  sesConfigurationSet: z.string().max(120).optional(),
  welcomeUrl: z.string().max(500).optional(),
  mergeFields: z.array(z.string().regex(/^[a-z_][a-z0-9_]*$/)).optional(),
  seedEmails: z.array(z.string().max(254)).optional(),
  active: z.boolean().optional(),
});

export async function PATCH(request: Request, { params }: Params) {
  return handle(async () => {
    await requireAdmin();
    const { id } = await params;
    if (!ObjectId.isValid(id)) return notFound();

    const body = await parseJson(request, patchSchema);
    const update: Record<string, unknown> = { ...body, updatedAt: new Date() };
    if (body.fromEmail) update.fromEmail = normalizeEmail(body.fromEmail);
    if (body.replyTo) update.replyTo = normalizeEmail(body.replyTo);
    if (body.seedEmails) update.seedEmails = body.seedEmails.map(normalizeEmail);

    const c = await collections();
    const result = await c.lists.updateOne({ _id: new ObjectId(id) }, { $set: update });
    if (result.matchedCount === 0) return notFound();

    return NextResponse.json({ ok: true });
  });
}
