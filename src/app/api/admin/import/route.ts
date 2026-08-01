import { badRequest, readJson, toObjectId, withAdmin } from '@/lib/api/guard';
import { importSubscribers } from '@/lib/csv/import';
import { listsCollection } from '@/lib/db/collections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * CSV import (section 4.3).
 *
 * `markConfirmed` is honoured only alongside an explicit attestation, whose
 * wording is stored verbatim as the consent evidence.
 */
export const POST = withAdmin(async (request) => {
  const body = await readJson(request);
  const listId = toObjectId(typeof body?.listId === 'string' ? body.listId : undefined);
  if (!listId) return badRequest('a valid listId is required');

  // Shape alone is not enough: importing against a list that does not exist
  // creates subscribers nobody can see and nobody can ever send to.
  const list = await (await listsCollection()).findOne({ _id: listId });
  if (!list) return badRequest('unknown list');

  const csv = typeof body?.csv === 'string' ? body.csv : '';
  if (!csv.trim()) return badRequest('csv content is required');

  const mapping = body?.mapping as { email?: string; attributes?: Record<string, string> };
  if (!mapping || typeof mapping.email !== 'string') {
    return badRequest('mapping.email must name the column holding the address');
  }

  const attestation = body?.attestation as { text?: string; by?: string } | undefined;

  const result = await importSubscribers({
    listId,
    csv,
    mapping: { email: mapping.email, attributes: mapping.attributes },
    markConfirmed: body?.markConfirmed === true,
    attestation:
      attestation &&
      typeof attestation.text === 'string' &&
      attestation.text.trim() !== '' &&
      typeof attestation.by === 'string' &&
      // The attestation is the legal record for importing tens of thousands of
      // addresses as confirmed, so a whitespace-only attester is not one.
      attestation.by.trim() !== ''
        ? { text: attestation.text.trim(), by: attestation.by.trim() }
        : undefined,
    filename: typeof body?.filename === 'string' ? body.filename : undefined,
  });

  if ('error' in result) return badRequest(result.error);

  return Response.json({
    ok: true,
    ...result,
    attestationId: result.attestationId?.toHexString() ?? null,
  });
});
