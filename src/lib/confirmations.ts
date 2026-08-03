import { listsCollection, subscribersCollection } from '@/lib/db/collections';
import { generateConfirmToken } from '@/lib/crypto/tokens';
import { buildConfirmationEmail } from '@/lib/email/confirmation';
import { logger } from '@/lib/logging';
import { getSesAdapter } from '@/lib/ses/registry';
import { setConfirmToken } from '@/lib/subscribers';
import { filterSuppressed } from '@/lib/suppressions';
import { getTemplateHtml } from '@/lib/templates';
import type { ListDoc } from '@/lib/types';

/**
 * Outstanding double opt-in confirmations (spec §4.3).
 *
 * A subscriber imported *without* a prior-consent attestation lands as
 * `pending` and must receive a confirmation email. Import cannot send those
 * inline — a 33,000-row file would blow the function's time budget long before
 * it finished — so import just creates the records and this job mints each
 * token and sends the email.
 *
 * It runs on the per-minute send cron, bounded per invocation, so a large
 * import drains over a few minutes instead of stalling one request.
 */
export async function sendPendingConfirmations(
  opts: { limit?: number; now?: Date } = {},
): Promise<{ sent: number; failed: number }> {
  const limit = opts.limit ?? 50;
  const now = opts.now ?? new Date();
  const result = { sent: 0, failed: 0 };
  if (limit <= 0) return result;

  const subscribers = await subscribersCollection();
  // Never sent one: a subscriber whose confirmation has already gone out has
  // `confirmEmailSentAt` set, and re-sending is the signup endpoint's job
  // (rate-limited to once per hour per address).
  const pending = await subscribers
    .find({ status: 'pending', confirmEmailSentAt: { $exists: false } })
    .limit(limit)
    .toArray();

  if (pending.length === 0) return result;

  // The suppression list is sacred: every send path checks it, no exceptions
  // (§1.2). An address can be suppressed between the import and this run.
  const suppressed = await filterSuppressed(pending.map((s) => s.email));

  const listIds = new Map(pending.map((s) => [s.listId.toHexString(), s.listId]));
  const lists = new Map<string, ListDoc>(
    (await (await listsCollection()).find({ _id: { $in: [...listIds.values()] } }).toArray()).map(
      (list) => [list._id.toHexString(), list],
    ),
  );

  const ses = await getSesAdapter();
  // One lookup per list rather than one per subscriber: a drain of 50 rows
  // spans at most two lists.
  const confirmationTemplates = new Map<string, string | null>(
    await Promise.all(
      [...listIds.values()].map(
        async (id) =>
          [id.toHexString(), await getTemplateHtml(id, 'confirmation')] as [string, string | null],
      ),
    ),
  );

  for (const subscriber of pending) {
    if (suppressed.has(subscriber.email)) {
      // Mark it handled so this address is not reconsidered every minute. The
      // record stays `pending` and is purged after seven days like any other.
      await subscribers.updateOne(
        { _id: subscriber._id },
        { $set: { confirmEmailSentAt: now } },
      );
      continue;
    }

    const list = lists.get(subscriber.listId.toHexString());
    if (!list) {
      // An import against a list that has since been removed. Nothing to send,
      // and nothing this job can do about it.
      logger.warn('pending subscriber has no list', {
        listId: subscriber.listId.toHexString(),
      });
      result.failed += 1;
      continue;
    }

    const { token, tokenHash, expiresAt } = generateConfirmToken(now);
    // Written before the send so a crash mid-loop cannot produce an email whose
    // token was never stored — better a wasted token than a dead link.
    await setConfirmToken(subscriber._id, tokenHash, expiresAt, now);

    try {
      await ses.sendSimple({
        fromName: list.fromName,
        fromEmail: list.fromEmail,
        replyTo: list.replyTo,
        to: subscriber.email,
        configurationSet: list.sesConfigurationSet,
        content: await buildConfirmationEmail({
          list,
          token,
          templateHtml: confirmationTemplates.get(list._id.toHexString()) ?? null,
          attributes: subscriber.attributes,
          email: subscriber.email,
        }),
      });
      result.sent += 1;
    } catch (err) {
      // Clear the marker so the next run retries this subscriber.
      await subscribers.updateOne(
        { _id: subscriber._id },
        { $unset: { confirmEmailSentAt: '' } },
      );
      result.failed += 1;
      logger.error('pending confirmation email failed', {
        domain: subscriber.emailDomain,
        error: (err as Error).message,
      });
    }
  }

  if (result.sent > 0 || result.failed > 0) {
    logger.info('pending confirmations processed', result);
  }
  return result;
}
