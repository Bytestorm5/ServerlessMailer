import { ObjectId } from 'mongodb';
import { importAttestationsCollection, subscribersCollection } from '@/lib/db/collections';
import { parseCsv } from '@/lib/csv/parse';
import { normalizeAndValidate } from '@/lib/email/normalize';
import { logger } from '@/lib/logging';
import { splitNameAttributes } from '@/lib/subscriber-name';
import { filterSuppressed } from '@/lib/suppressions';
import type { ImportAttestationDoc, SubscriberDoc } from '@/lib/types';

/**
 * CSV import (spec §4.3).
 *
 * Three rules, in order of how much damage breaking them does:
 *
 *  1. Every address is checked against `suppressions` and skipped on a match.
 *     A suppressed address must never be resurrected by a re-import — this is
 *     the single most common way people destroy their sender reputation.
 *  2. Import never resets consent state. Re-importing someone who unsubscribed
 *     updates their attributes and leaves them unsubscribed.
 *  3. Malformed rows are reported back, not silently dropped.
 */

export interface ImportRowError {
  row: number;
  email?: string;
  reason: string;
}

export interface ImportResult {
  total: number;
  imported: number;
  updated: number;
  skippedSuppressed: number;
  skippedTombstoned: number;
  errors: ImportRowError[];
  attestationId?: ObjectId;
}

export interface ImportMapping {
  /** CSV header holding the email address. */
  email: string;
  /**
   * CSV header -> subscriber attribute key. Columns mapped to `first_name` /
   * `last_name` are stored on the first-party `firstName`/`lastName` fields
   * rather than in the attribute map.
   */
  attributes?: Record<string, string>;
}

const SAFE_ATTRIBUTE_KEY = /^[A-Za-z0-9_-]{1,64}$/;

export async function importSubscribers(input: {
  listId: ObjectId;
  csv: string;
  mapping: ImportMapping;
  markConfirmed: boolean;
  attestation?: { text: string; by: string };
  filename?: string;
  now?: Date;
}): Promise<ImportResult | { error: string }> {
  const now = input.now ?? new Date();

  const { headers, rows } = parseCsv(input.csv);
  if (headers.length === 0) return { error: 'The file has no header row.' };

  const emailIndex = headers.indexOf(input.mapping.email);
  if (emailIndex === -1) {
    return { error: `The file has no column named "${input.mapping.email}".` };
  }

  // Imported subscribers land as `confirmed` ONLY when the operator
  // affirmatively attests prior opt-in consent, and the wording is logged.
  const asConfirmed = input.markConfirmed && Boolean(input.attestation);
  if (input.markConfirmed && !input.attestation) {
    return {
      error:
        'Importing as confirmed requires an explicit prior-consent attestation.',
    };
  }

  const attributeColumns: { index: number; key: string }[] = [];
  for (const [header, key] of Object.entries(input.mapping.attributes ?? {})) {
    const index = headers.indexOf(header);
    if (index === -1) continue;
    if (!SAFE_ATTRIBUTE_KEY.test(key)) continue;
    attributeColumns.push({ index, key });
  }

  const result: ImportResult = {
    total: rows.length,
    imported: 0,
    updated: 0,
    skippedSuppressed: 0,
    skippedTombstoned: 0,
    errors: [],
  };

  // Validate and normalise first, so the suppression check is one query rather
  // than one per row.
  interface Candidate {
    row: number;
    email: string;
    domain: string;
    firstName?: string;
    lastName?: string;
    attributes: Record<string, string>;
  }
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  rows.forEach((cells, index) => {
    const rowNumber = index + 2; // 1-based, plus the header row.
    const raw = cells[emailIndex];

    if (raw === undefined || raw.trim() === '') {
      result.errors.push({ row: rowNumber, reason: 'No email address in this row' });
      return;
    }

    const check = normalizeAndValidate(raw);
    if (!check.ok) {
      result.errors.push({
        row: rowNumber,
        email: raw.trim(),
        reason: `Not a valid email address (${check.reason})`,
      });
      return;
    }

    if (seen.has(check.email)) {
      result.errors.push({
        row: rowNumber,
        email: check.email,
        reason: 'Duplicate of an earlier row in this file',
      });
      return;
    }
    seen.add(check.email);

    const mapped: Record<string, string> = {};
    for (const column of attributeColumns) {
      const value = cells[column.index];
      if (value !== undefined && value.trim() !== '') {
        mapped[column.key] = value.trim().slice(0, 512);
      }
    }
    const { firstName, lastName, attributes } = splitNameAttributes(mapped);

    candidates.push({
      row: rowNumber,
      email: check.email,
      domain: check.domain,
      ...(firstName !== undefined ? { firstName } : {}),
      ...(lastName !== undefined ? { lastName } : {}),
      attributes,
    });
  });

  const suppressed = await filterSuppressed(candidates.map((c) => c.email));
  const collection = await subscribersCollection();

  let attestationId: ObjectId | undefined;
  if (input.attestation) {
    const record: ImportAttestationDoc = {
      _id: new ObjectId(),
      listId: input.listId,
      // Stored verbatim: this is the evidence if consent is ever questioned.
      attestationText: input.attestation.text,
      attestedBy: input.attestation.by,
      attestedAt: now,
      filename: input.filename,
      rowCount: rows.length,
      importedAsConfirmed: asConfirmed,
    };
    await (await importAttestationsCollection()).insertOne(record);
    attestationId = record._id;
    result.attestationId = attestationId;
  }

  for (const candidate of candidates) {
    if (suppressed.has(candidate.email)) {
      result.skippedSuppressed += 1;
      continue;
    }

    const existing = await collection.findOne({
      listId: input.listId,
      email: candidate.email,
    });

    const attributeUpdates: Record<string, string> = {};
    for (const [key, value] of Object.entries(candidate.attributes)) {
      attributeUpdates[`attributes.${key}`] = value;
    }
    if (candidate.firstName !== undefined) attributeUpdates.firstName = candidate.firstName;
    if (candidate.lastName !== undefined) attributeUpdates.lastName = candidate.lastName;

    if (!existing) {
      const doc: SubscriberDoc = {
        _id: new ObjectId(),
        listId: input.listId,
        email: candidate.email,
        emailDomain: candidate.domain,
        status: asConfirmed ? 'confirmed' : 'pending',
        ...(candidate.firstName !== undefined ? { firstName: candidate.firstName } : {}),
        ...(candidate.lastName !== undefined ? { lastName: candidate.lastName } : {}),
        attributes: candidate.attributes,
        source: 'import',
        createdAt: now,
        ...(asConfirmed ? { confirmedAt: now } : {}),
        history: [
          {
            at: now,
            from: null,
            to: asConfirmed ? 'confirmed' : 'pending',
            reason: attestationId
              ? `import:attestation:${attestationId.toHexString()}`
              : 'import',
          },
        ],
      };
      try {
        await collection.insertOne(doc);
        result.imported += 1;
      } catch (err) {
        if ((err as { code?: number }).code === 11000) {
          // Raced with a concurrent import of the same file.
          result.updated += 1;
        } else {
          throw err;
        }
      }
      continue;
    }

    // Already known. Update attributes and never touch consent state — a
    // re-import must not resurrect an unsubscribe or a bounce.
    if (
      existing.status === 'unsubscribed' ||
      existing.status === 'bounced' ||
      existing.status === 'complained'
    ) {
      if (Object.keys(attributeUpdates).length > 0) {
        await collection.updateOne({ _id: existing._id }, { $set: attributeUpdates });
      }
      result.skippedTombstoned += 1;
      continue;
    }

    const promote = asConfirmed && existing.status === 'pending';
    await collection.updateOne(
      { _id: existing._id },
      {
        $set: {
          ...attributeUpdates,
          ...(promote ? { status: 'confirmed', confirmedAt: existing.confirmedAt ?? now } : {}),
        },
        ...(promote
          ? {
              $push: {
                history: {
                  at: now,
                  from: existing.status,
                  to: 'confirmed' as const,
                  reason: attestationId
                    ? `import:attestation:${attestationId.toHexString()}`
                    : 'import',
                },
              },
            }
          : {}),
      },
    );
    result.updated += 1;
  }

  logger.info('subscriber import complete', {
    listId: input.listId.toHexString(),
    total: result.total,
    imported: result.imported,
    updated: result.updated,
    skippedSuppressed: result.skippedSuppressed,
    skippedTombstoned: result.skippedTombstoned,
    errors: result.errors.length,
    asConfirmed,
  });

  return result;
}
