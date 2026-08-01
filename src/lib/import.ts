import { ObjectId } from 'mongodb';
import { collections } from './db';
import { isSyntacticallyValid, normalizeEmail } from './email-address';
import { suppressedSubset } from './suppressions';
import { upsertImportedSubscriber } from './subscribers';
import type { ImportJobDoc } from './types';

/**
 * CSV import (§4.3).
 *
 * Four properties this has to get right, in order of how much damage getting
 * them wrong causes:
 *
 * 1. Every address is checked against `suppressions` and skipped on a match. A
 *    suppressed address must never be resurrected by a re-import. This is the
 *    single most common way people destroy their sender reputation.
 * 2. Imported subscribers land as `confirmed` only under an explicit operator
 *    attestation of prior opt-in, which is recorded.
 * 3. Idempotent on `{listId, email}` — re-importing updates attributes, never
 *    duplicates and never resets consent state.
 * 4. Malformed rows are reported back, not silently dropped.
 *
 * Work arrives in chunks from the browser rather than as one long request:
 * 33,000 rows will not process inside a serverless function's time limit, and
 * chunking also gives the operator a live progress count.
 */

export const ATTESTATION_TEXT =
  'I confirm that every address in this file gave prior express consent to receive this newsletter, ' +
  'and that I can produce evidence of that consent on request.';

export interface ImportRow {
  [column: string]: string;
}

export interface ChunkResult {
  processed: number;
  created: number;
  updated: number;
  suppressed: number;
  invalid: number;
  errors: { row: number; email: string; reason: string }[];
}

const MAX_STORED_ERRORS = 200;

/**
 * `mapping` maps a target field to a CSV column header. `email` is required;
 * everything else becomes a subscriber attribute.
 */
export function mapRow(
  row: ImportRow,
  mapping: Record<string, string>,
): { email: string; attributes: Record<string, string> } {
  const emailColumn = mapping.email;
  const email = emailColumn ? normalizeEmail(row[emailColumn] ?? '') : '';

  const attributes: Record<string, string> = {};
  for (const [field, column] of Object.entries(mapping)) {
    if (field === 'email' || !column) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) continue;
    const value = (row[column] ?? '').trim();
    if (value !== '') attributes[field] = value;
  }

  return { email, attributes };
}

export async function processImportChunk(
  job: ImportJobDoc,
  rows: ImportRow[],
  startingRowNumber: number,
): Promise<ChunkResult> {
  const c = await collections();
  const result: ChunkResult = {
    processed: 0,
    created: 0,
    updated: 0,
    suppressed: 0,
    invalid: 0,
    errors: [],
  };

  interface Candidate {
    email: string;
    attributes: Record<string, string>;
    rowNumber: number;
  }
  const candidates: Candidate[] = [];

  rows.forEach((row, index) => {
    const rowNumber = startingRowNumber + index;
    const { email, attributes } = mapRow(row, job.mapping);

    if (email === '') {
      result.invalid += 1;
      result.errors.push({ row: rowNumber, email: '', reason: 'No email address in the mapped column' });
      return;
    }
    if (!isSyntacticallyValid(email)) {
      result.invalid += 1;
      result.errors.push({ row: rowNumber, email, reason: 'Malformed email address' });
      return;
    }
    candidates.push({ email, attributes, rowNumber });
  });

  // One suppression query per chunk, not per row.
  const suppressed = await suppressedSubset(candidates.map((candidate) => candidate.email));

  for (const candidate of candidates) {
    if (suppressed.has(candidate.email)) {
      result.suppressed += 1;
      result.errors.push({
        row: candidate.rowNumber,
        email: candidate.email,
        reason: 'Address is on the suppression list — skipped',
      });
      continue;
    }

    const outcome = await upsertImportedSubscriber({
      listId: job.listId,
      email: candidate.email,
      attributes: candidate.attributes,
      confirmed: job.attested,
      attestationId: job.attested ? job._id : null,
    });

    if (outcome === 'created') {
      result.created += 1;
      // Unattested imports go through the full double opt-in flow. The
      // confirmation emails are queued rather than sent inline: a 33,000-row
      // import cannot send 33,000 messages inside one request.
      if (!job.attested) {
        const subscriber = await c.subscribers.findOne(
          { listId: job.listId, email: candidate.email },
          { projection: { _id: 1, status: 1 } },
        );
        if (subscriber && subscriber.status === 'pending') {
          await c.confirmationQueue.insertOne({
            subscriberId: subscriber._id,
            listId: job.listId,
            status: 'pending',
            leaseUntil: new Date(0),
            attempts: 0,
            lastError: null,
            createdAt: new Date(),
          } as never);
        }
      }
    } else {
      result.updated += 1;
    }
    result.processed += 1;
  }

  result.processed += result.invalid + result.suppressed;

  await c.importJobs.updateOne(
    { _id: job._id },
    {
      $inc: {
        'counts.rows': rows.length,
        'counts.created': result.created,
        'counts.updated': result.updated,
        'counts.suppressed': result.suppressed,
        'counts.invalid': result.invalid,
      },
      // Errors are capped so a wholly malformed file cannot grow the document
      // past the BSON limit; the counters stay accurate either way.
      $push: { errors: { $each: result.errors.slice(0, 50), $slice: -MAX_STORED_ERRORS } },
    },
  );

  return result;
}

export async function createImportJob(input: {
  listId: ObjectId;
  filename: string;
  mapping: Record<string, string>;
  attested: boolean;
  attestedBy: string;
}): Promise<ImportJobDoc> {
  const c = await collections();
  const doc: Omit<ImportJobDoc, '_id'> = {
    listId: input.listId,
    filename: input.filename,
    status: 'open',
    attested: input.attested,
    attestationText: input.attested ? ATTESTATION_TEXT : null,
    attestedBy: input.attested ? input.attestedBy : null,
    attestedAt: input.attested ? new Date() : null,
    mapping: input.mapping,
    counts: { rows: 0, created: 0, updated: 0, suppressed: 0, invalid: 0 },
    errors: [],
    createdAt: new Date(),
    completedAt: null,
  };
  const result = await c.importJobs.insertOne(doc as ImportJobDoc);
  return { ...doc, _id: result.insertedId } as ImportJobDoc;
}
