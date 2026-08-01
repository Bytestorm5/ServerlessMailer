/**
 * A failed confirmation gets a friendly page offering to start over, not a raw
 * error (§5.2). The person clicking the link did what was asked of them.
 */
export default async function ConfirmFailedPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;

  const explanation =
    reason === 'expired'
      ? 'That confirmation link has expired — they are only valid for seven days.'
      : reason === 'missing'
        ? 'That link was missing its confirmation code.'
        : 'That confirmation link is no longer valid. It may have already been used.';

  return (
    <div className="space-y-3 text-center">
      <h1 className="text-xl font-semibold">We couldn&rsquo;t confirm that link</h1>
      <p className="text-ink-600">{explanation}</p>
      <p className="text-ink-600">
        No problem — sign up again and we&rsquo;ll send a fresh link straight away.
      </p>
    </div>
  );
}
