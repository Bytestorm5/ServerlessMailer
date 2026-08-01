import { badRequest, readJson, withAdmin } from '@/lib/api/guard';
import {
  ListValidationError,
  createList,
  listSummaries,
  serializeList,
  type ListInput,
} from '@/lib/lists';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * List configuration (§3.1).
 *
 * Until this existed a list could only be created by inserting a document into
 * MongoDB by hand, which put the sending identity — verified domain, From
 * address, physical address, configuration set — outside the application that
 * depends on all four.
 */

/** Reads the fields of a list from a request body. Validation lives in the lib. */
function readListInput(body: Record<string, unknown>): ListInput {
  return {
    name: str(body.name),
    sendingDomain: str(body.sendingDomain),
    fromName: str(body.fromName),
    fromEmail: str(body.fromEmail),
    replyTo: str(body.replyTo),
    physicalAddress: str(body.physicalAddress),
    sesConfigurationSet: str(body.sesConfigurationSet),
    active: body.active !== false,
    welcomeUrl: str(body.welcomeUrl),
  };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export const GET = withAdmin(async () => {
  const summaries = await listSummaries();
  return Response.json({
    ok: true,
    lists: summaries.map(({ list, confirmed, pending, unsubscribed, campaigns }) => ({
      ...serializeList(list),
      counts: { confirmed, pending, unsubscribed, campaigns },
    })),
  });
});

export const POST = withAdmin(async (request) => {
  const body = await readJson(request);
  if (!body) return badRequest('a JSON body is required');

  try {
    const list = await createList(readListInput(body));
    return Response.json({ ok: true, list: serializeList(list) }, { status: 201 });
  } catch (err) {
    // Anything that is not a validation failure is a genuine fault and belongs
    // in the 500 that `withAdmin` produces, not in a 400.
    if (err instanceof ListValidationError) return badRequest(err.message);
    throw err;
  }
});
