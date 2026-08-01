import { badRequest, notFound, readJson, toObjectId, withAdmin } from '@/lib/api/guard';
import { sendListTestEmail } from '@/lib/lists';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * List test send (§6.5) — the campaign-free variant.
 *
 * `/api/admin/campaigns/[id]/actions` with `action: 'test'` tests a campaign
 * body. This tests the *sending identity*, which is what a newly configured
 * list needs verified before any campaign exists.
 */
export const POST = withAdmin<Ctx>(async (request, ctx) => {
  const id = toObjectId((await ctx.params).id);
  if (!id) return badRequest('invalid list id');

  const body = await readJson(request);
  const to = Array.isArray(body?.to)
    ? body.to.filter((value): value is string => typeof value === 'string')
    : [];

  const result = await sendListTestEmail({ listId: id, to });
  if (result.ok) return Response.json({ ok: true, sent: result.sent });
  if (result.reason === 'list_not_found') return notFound('list not found');

  return badRequest(explain(result.reason));
});

/** Turns a machine reason into something an operator can act on. */
function explain(reason: string): string {
  if (reason === 'no_recipients') return 'Enter an address to send the test to.';
  if (reason === 'too_many_recipients') return 'A test send is limited to 10 addresses.';
  if (reason.startsWith('invalid_address')) return 'That is not a valid email address.';
  if (reason === 'suppressed_address') {
    return (
      'That address is on the suppression list, so it is never sent to — including for a test. ' +
      'Use a different address.'
    );
  }
  if (reason === 'send_failed') {
    return 'SES rejected the test send. Check the sending domain is verified and the configuration set exists.';
  }
  return reason;
}
