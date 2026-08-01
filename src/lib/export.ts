import type { Filter } from 'mongodb';
import { collections } from './db';
import type { SubscriberDoc } from './types';

/**
 * CSV export (§4.4).
 *
 * "Export exists partly so this application is never a lock-in trap. It should
 * work on day one." It streams, so a 19,000-row export does not have to fit in
 * a serverless function's memory or finish inside its time limit before the
 * first byte reaches the browser.
 */

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  // A leading =, +, - or @ is interpreted as a formula by spreadsheet software.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function csvRow(values: unknown[]): string {
  return values.map(csvEscape).join(',') + '\n';
}

export const SUBSCRIBER_EXPORT_COLUMNS = [
  'email',
  'status',
  'source',
  'created_at',
  'confirmed_at',
  'confirm_ip',
  'confirm_user_agent',
  'unsubscribed_at',
  'unsubscribe_source',
  'bounced_at',
  'complained_at',
] as const;

/**
 * Streams subscribers as CSV. Consent evidence columns are included by design:
 * an export that omits them is not a portable record of consent (§5.3).
 */
export function streamSubscribersCsv(filter: Filter<SubscriberDoc>, attributeKeys: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const c = await collections();
      controller.enqueue(encoder.encode(csvRow([...SUBSCRIBER_EXPORT_COLUMNS, ...attributeKeys])));

      const cursor = c.subscribers.find(filter).sort({ _id: 1 });
      try {
        for await (const subscriber of cursor) {
          controller.enqueue(
            encoder.encode(
              csvRow([
                subscriber.email,
                subscriber.status,
                subscriber.source,
                subscriber.createdAt,
                subscriber.confirmedAt ?? '',
                subscriber.confirmIp ?? '',
                subscriber.confirmUserAgent ?? '',
                subscriber.unsubscribedAt ?? '',
                subscriber.unsubscribeSource ?? '',
                subscriber.bouncedAt ?? '',
                subscriber.complainedAt ?? '',
                ...attributeKeys.map((key) => subscriber.attributes?.[key] ?? ''),
              ]),
            ),
          );
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        await cursor.close();
      }
    },
  });
}

/** Suppressions export — separate file, per §4.4. */
export function streamSuppressionsCsv(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const c = await collections();
      controller.enqueue(encoder.encode(csvRow(['email', 'reason', 'created_at', 'source_campaign_id', 'detail'])));

      const cursor = c.suppressions.find({}).sort({ _id: 1 });
      try {
        for await (const suppression of cursor) {
          controller.enqueue(
            encoder.encode(
              csvRow([
                suppression.email,
                suppression.reason,
                suppression.createdAt,
                suppression.sourceCampaignId ?? '',
                suppression.detail ?? '',
              ]),
            ),
          );
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        await cursor.close();
      }
    },
  });
}

/** Attribute keys present on a list, so the export has stable columns. */
export async function listAttributeKeys(filter: Filter<SubscriberDoc>): Promise<string[]> {
  const c = await collections();
  const sample = await c.subscribers.find(filter, { projection: { attributes: 1 } }).limit(500).toArray();
  const keys = new Set<string>();
  for (const subscriber of sample) {
    for (const key of Object.keys(subscriber.attributes ?? {})) keys.add(key);
  }
  return [...keys].sort();
}
