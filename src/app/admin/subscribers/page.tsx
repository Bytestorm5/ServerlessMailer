import Link from 'next/link';
import { listsCollection } from '@/lib/db/collections';
import { displayName } from '@/lib/subscriber-name';
import { findSubscribers } from '@/lib/subscribers';
import { SUBSCRIBER_STATUSES, type SubscriberStatus } from '@/lib/types';
import { ObjectId } from 'mongodb';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Subscribers — ServerlessMailer' };

interface SearchParams {
  listId?: string;
  status?: string;
  search?: string;
  skip?: string;
}

const PAGE = 50;

export default async function SubscribersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const lists = await (await listsCollection()).find({}).sort({ name: 1 }).toArray();

  const listId =
    params.listId && ObjectId.isValid(params.listId)
      ? new ObjectId(params.listId)
      : lists[0]?._id;
  const status = SUBSCRIBER_STATUSES.includes(params.status as SubscriberStatus)
    ? (params.status as SubscriberStatus)
    : undefined;
  const skip = Number(params.skip ?? 0) || 0;

  const { items, total } = await findSubscribers({
    listId,
    status,
    search: params.search,
    limit: PAGE,
    skip,
  });

  const link = (patch: Record<string, string>) => {
    const next = new URLSearchParams({
      ...(listId ? { listId: listId.toHexString() } : {}),
      ...(status ? { status } : {}),
      ...(params.search ? { search: params.search } : {}),
      ...patch,
    });
    return `/admin/subscribers?${next.toString()}`;
  };

  return (
    <>
      <h1>Subscribers</h1>

      <form method="get" style={{ display: 'flex', gap: '0.5rem', margin: '0 0 1rem' }}>
        {lists.length > 1 && (
          <select name="listId" defaultValue={listId?.toHexString()} aria-label="List">
            {lists.map((list) => (
              <option key={list._id.toHexString()} value={list._id.toHexString()}>
                {list.name}
              </option>
            ))}
          </select>
        )}
        <select name="status" defaultValue={status ?? ''} aria-label="Status">
          <option value="">All statuses</option>
          {SUBSCRIBER_STATUSES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <input
          name="search"
          type="search"
          placeholder="Search by email or name"
          defaultValue={params.search ?? ''}
          aria-label="Search by email or name"
        />
        <button type="submit">Filter</button>
      </form>

      <p className="muted">{total.toLocaleString('en-GB')} matching subscribers</p>

      <div className="sm-scroll">
        <table className="sm-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Status</th>
              <th>Source</th>
              <th>Signed up</th>
              <th>Confirmed</th>
            </tr>
          </thead>
          <tbody>
            {items.map((subscriber) => (
              <tr key={subscriber._id.toHexString()}>
                <td>
                  <Link href={`/admin/subscribers/${subscriber._id.toHexString()}`}>
                    {subscriber.email}
                  </Link>
                </td>
                <td>{displayName(subscriber) ?? '—'}</td>
                <td>
                  <span className={`sm-badge is-${subscriber.status}`}>{subscriber.status}</span>
                </td>
                <td>{subscriber.source}</td>
                <td>{subscriber.createdAt.toISOString().slice(0, 10)}</td>
                <td>{subscriber.confirmedAt?.toISOString().slice(0, 10) ?? '—'}</td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  Nobody matches these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
        {skip > 0 && <Link href={link({ skip: String(Math.max(0, skip - PAGE)) })}>Previous</Link>}
        {skip + PAGE < total && <Link href={link({ skip: String(skip + PAGE) })}>Next</Link>}
      </div>
    </>
  );
}
