import { env } from './env';
import { log } from './logger';

/**
 * Alerting for the circuit breaker, failed batches and SES `Reject` events.
 *
 * §17 leaves the channel open. This posts a JSON payload to an optional
 * webhook — Slack incoming webhooks and most alerting tools accept that shape
 * directly — and always logs, so a deployment with no webhook configured is
 * still auditable rather than silent.
 */
export async function sendAlert(title: string, fields: Record<string, unknown> = {}): Promise<void> {
  log.warn(`ALERT: ${title}`, fields);

  const url = env.alertWebhookUrl;
  if (!url) return;

  const summary = Object.entries(fields)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join('\n');

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `*${title}*\n${summary}`, title, fields }),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (error) {
    // An alerting failure must never take down the send path.
    log.error('alert delivery failed', { title, error: String(error) });
  }
}
