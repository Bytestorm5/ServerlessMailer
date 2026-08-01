import { NextResponse } from 'next/server';
import { collections } from '@/lib/db';
import { env } from '@/lib/env';
import { handle, invocationId, verifyCronRequest } from '@/lib/api';
import { issueConfirmToken } from '@/lib/subscribers';
import { sendConfirmationEmail } from '@/lib/transactional';
import { isSuppressed } from '@/lib/suppressions';
import { ThrottlingError } from '@/lib/mailer';
import { errorMessage, log } from '@/lib/logger';
import { sleep } from '@/lib/pipeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Drains queued double opt-in confirmations from bulk imports (§4.3).
 *
 * Web-form signups send their confirmation inline (§5.1); this exists only for
 * imports, where the alternative is 33,000 transactional sends inside one HTTP
 * request. Same lease-and-reclaim shape as the campaign pipeline, so a crash
 * mid-drain loses nothing.
 */
export async function GET(request: Request) {
  return handle(async () => {
    if (!verifyCronRequest(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const id = invocationId();
    const c = await collections();
    const deadline = Date.now() + env.cronRunBudgetMs;

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    while (Date.now() < deadline && sent + failed + skipped < 200) {
      const now = new Date();
      const item = await c.confirmationQueue.findOneAndUpdate(
        {
          $or: [{ status: 'pending' }, { status: 'claimed', leaseUntil: { $lt: now } }],
          attempts: { $lt: env.maxBatchAttempts },
        },
        {
          $set: { status: 'claimed', leaseUntil: new Date(now.getTime() + env.batchLeaseMs) },
          $inc: { attempts: 1 },
        },
        { returnDocument: 'after' },
      );
      if (!item) break;

      try {
        const subscriber = await c.subscribers.findOne({ _id: item.subscriberId });
        const list = await c.lists.findOne({ _id: item.listId });

        // Anything that changed since the import wins: a confirmation email to
        // a suppressed address is exactly what §4.3 exists to prevent.
        if (!subscriber || !list || subscriber.status !== 'pending' || (await isSuppressed(subscriber.email))) {
          await c.confirmationQueue.updateOne(
            { _id: item._id },
            { $set: { status: 'sent', lastError: 'Skipped: no longer eligible' } },
          );
          skipped += 1;
          continue;
        }

        const token = await issueConfirmToken(subscriber._id);
        if (!token) {
          await c.confirmationQueue.updateOne(
            { _id: item._id },
            { $set: { status: 'sent', lastError: 'Skipped: not pending' } },
          );
          skipped += 1;
          continue;
        }

        await sendConfirmationEmail(list, subscriber.email, token);
        await c.confirmationQueue.updateOne({ _id: item._id }, { $set: { status: 'sent', lastError: null } });
        sent += 1;

        // Same pacing rule as the campaign pipeline: one message per slot.
        await sleep(Math.ceil(1000 / env.sesMaxSendRate));
      } catch (error) {
        if (error instanceof ThrottlingError) {
          await c.confirmationQueue.updateOne(
            { _id: item._id },
            { $set: { status: 'pending', leaseUntil: new Date(0) }, $inc: { attempts: -1 } },
          );
          log.warn('confirmation queue throttled, ending run', { invocationId: id });
          break;
        }
        const message = errorMessage(error);
        const exhausted = item.attempts >= env.maxBatchAttempts;
        await c.confirmationQueue.updateOne(
          { _id: item._id },
          { $set: { status: exhausted ? 'failed' : 'pending', leaseUntil: new Date(0), lastError: message } },
        );
        failed += 1;
      }
    }

    log.info('cron/confirmations complete', { invocationId: id, sent, failed, skipped });
    return NextResponse.json({ ok: true, sent, failed, skipped });
  });
}

export const POST = GET;
