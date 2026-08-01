import Link from 'next/link';
import {
  campaignsCollection,
  listsCollection,
  subscribersCollection,
  suppressionsCollection,
} from '@/lib/db/collections';
import { reputationSnapshot } from '@/lib/stats';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Dashboard — ServerlessMailer' };

const pct = (value: number) => `${(value * 100).toFixed(3)}%`;

export default async function DashboardPage() {
  const [lists, subscribers, suppressions, campaigns, reputation] = await Promise.all([
    (await listsCollection()).find({}).sort({ name: 1 }).toArray(),
    subscribersCollection(),
    (await suppressionsCollection()).countDocuments(),
    (await campaignsCollection()).find({}).sort({ createdAt: -1 }).limit(8).toArray(),
    reputationSnapshot({}),
  ]);

  const perList = await Promise.all(
    lists.map(async (list) => ({
      list,
      confirmed: await subscribers.countDocuments({ listId: list._id, status: 'confirmed' }),
      pending: await subscribers.countDocuments({ listId: list._id, status: 'pending' }),
    })),
  );

  return (
    <>
      <h1>Dashboard</h1>

      {/* Reputation first: crossing these thresholds does not degrade delivery,
          it stops it (spec section 8.3). */}
      <h2 style={{ fontSize: '1rem' }}>Reputation — last {reputation.windowDays} days</h2>
      <dl className="sm-cards">
        <div className={`sm-card${reputation.bounceStatus !== 'ok' ? ' is-warning' : ''}`}>
          <dt>Bounce rate</dt>
          <dd>{pct(reputation.bounceRate)}</dd>
          <p className="muted">SES review at 5%, sending paused at 10%</p>
        </div>
        <div className={`sm-card${reputation.complaintStatus !== 'ok' ? ' is-warning' : ''}`}>
          <dt>Complaint rate</dt>
          <dd>{pct(reputation.complaintRate)}</dd>
          <p className="muted">SES review at 0.1%, sending paused at 0.5%</p>
        </div>
        <div className="sm-card">
          <dt>Messages sent</dt>
          <dd>{reputation.sent.toLocaleString('en-GB')}</dd>
        </div>
        <div className="sm-card">
          <dt>Suppressed</dt>
          <dd>{suppressions.toLocaleString('en-GB')}</dd>
        </div>
      </dl>

      <h2 style={{ fontSize: '1rem' }}>Lists</h2>
      <dl className="sm-cards">
        {perList.map(({ list, confirmed, pending }) => (
          <div className="sm-card" key={list._id.toHexString()}>
            <dt>{list.name}</dt>
            <dd>{confirmed.toLocaleString('en-GB')}</dd>
            <p className="muted">
              confirmed · {pending.toLocaleString('en-GB')} pending · {list.sendingDomain}
            </p>
          </div>
        ))}
        {perList.length === 0 && (
          <p className="muted">
            No lists configured yet — <Link href="/admin/lists">create one</Link>. Nothing can be
            sent until one exists.
          </p>
        )}
      </dl>

      <h2 style={{ fontSize: '1rem' }}>Recent campaigns</h2>
      <div className="sm-scroll">
        <table className="sm-table">
          <thead>
            <tr>
              <th>Subject</th>
              <th>Status</th>
              <th>Recipients</th>
              <th>Sent</th>
              <th>Bounced</th>
              <th>Complained</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((campaign) => (
              <tr key={campaign._id.toHexString()}>
                <td>
                  <Link href={`/admin/campaigns/${campaign._id.toHexString()}`}>
                    {campaign.subject || '(no subject yet)'}
                  </Link>
                </td>
                <td>
                  <span className={`sm-badge is-${campaign.status}`}>{campaign.status}</span>
                </td>
                <td>{campaign.counts.recipients.toLocaleString('en-GB')}</td>
                <td>{campaign.counts.sent.toLocaleString('en-GB')}</td>
                <td>{campaign.counts.bounced.toLocaleString('en-GB')}</td>
                <td>{campaign.counts.complained.toLocaleString('en-GB')}</td>
              </tr>
            ))}
            {campaigns.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No campaigns yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
