import { NextResponse } from 'next/server';
import { collections } from '@/lib/db';
import { log } from '@/lib/logger';
import { handleSesNotification, type SesNotification } from '@/lib/ses-events';
import { confirmSubscription, verifySnsMessage, type SnsMessage } from '@/lib/sns-verify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * SES → SNS → this endpoint (§8).
 *
 * Signature verification is not optional and is not replaceable by a secret in
 * the URL: an attacker who can post here can suppress the entire list.
 */
export async function POST(request: Request) {
  let message: SnsMessage;
  try {
    message = (await request.json()) as SnsMessage;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const verification = await verifySnsMessage(message);
  if (!verification.ok) {
    log.warn('rejected SNS message', { reason: verification.reason, type: message.Type });
    return NextResponse.json({ error: 'Signature verification failed' }, { status: 403 });
  }

  // SNS delivers at least once. Recording the message id makes replays cheap
  // no-ops rather than duplicated suppression writes and inflated counters.
  const c = await collections();
  if (message.MessageId) {
    try {
      await c.snsMessages.insertOne({
        _id: message.MessageId,
        receivedAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });
    } catch {
      return NextResponse.json({ ok: true, duplicate: true });
    }
  }

  if (message.Type === 'SubscriptionConfirmation') {
    if (!message.SubscribeURL) return NextResponse.json({ error: 'Missing SubscribeURL' }, { status: 400 });
    const confirmed = await confirmSubscription(message.SubscribeURL);
    log.info('SNS subscription confirmation', { confirmed, topic: message.TopicArn });
    return NextResponse.json({ ok: confirmed });
  }

  if (message.Type === 'UnsubscribeConfirmation') {
    log.warn('SNS topic unsubscribed — bounce and complaint feedback has stopped', {
      topic: message.TopicArn,
    });
    return NextResponse.json({ ok: true });
  }

  if (message.Type !== 'Notification') {
    return NextResponse.json({ ok: true, ignored: message.Type });
  }

  let notification: SesNotification;
  try {
    notification = JSON.parse(message.Message) as SesNotification;
  } catch {
    log.warn('SNS notification body was not JSON');
    return NextResponse.json({ error: 'Invalid notification body' }, { status: 400 });
  }

  const result = await handleSesNotification(notification);
  return NextResponse.json({ ok: true, ...result });
}
