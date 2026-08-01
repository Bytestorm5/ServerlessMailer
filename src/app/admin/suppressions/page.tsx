import { listSuppressions } from '@/lib/suppressions';
import { SuppressionControls } from '@/components/admin/SuppressionControls';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Suppressions — ServerlessMailer' };

export default async function SuppressionsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; skip?: string }>;
}) {
  const params = await searchParams;
  const skip = Number(params.skip ?? 0) || 0;
  const { items, total } = await listSuppressions({ search: params.search, limit: 100, skip });

  return (
    <>
      <h1>Suppressions</h1>
      <p className="muted">
        Global across every list and both sending domains, because SES reputation
        thresholds are account-level. Every send path checks this list.
      </p>

      <SuppressionControls />

      <form method="get" style={{ margin: '1rem 0' }}>
        <input
          name="search"
          type="search"
          placeholder="Search by email"
          defaultValue={params.search ?? ''}
          aria-label="Search suppressions"
        />
        <button type="submit">Search</button>
      </form>

      <p className="muted">{total.toLocaleString('en-GB')} suppressed addresses</p>

      <div className="sm-scroll">
        <table className="sm-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Reason</th>
              <th>When</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {items.map((doc) => (
              <tr key={doc._id.toHexString()}>
                <td>{doc.email}</td>
                <td>
                  <span className="sm-badge">{doc.reason}</span>
                </td>
                <td>{doc.createdAt.toISOString().slice(0, 10)}</td>
                <td className="muted">{doc.detail ?? ''}</td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  Nothing suppressed.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
