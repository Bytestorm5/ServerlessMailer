import Link from 'next/link';
import { campaignsCollection, listsCollection } from '@/lib/db/collections';
import { NewCampaignButton } from '@/components/admin/NewCampaignButton';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Campaigns — ServerlessMailer' };

export default async function CampaignsPage() {
  const [campaigns, lists] = await Promise.all([
    (await campaignsCollection()).find({}).sort({ createdAt: -1 }).limit(100).toArray(),
    (await listsCollection()).find({ active: true }).sort({ name: 1 }).toArray(),
  ]);
  const listNames = new Map(lists.map((list) => [list._id.toHexString(), list.name]));

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Campaigns</h1>
        <NewCampaignButton
          lists={lists.map((list) => ({ id: list._id.toHexString(), name: list.name }))}
        />
      </div>

      <div className="sm-scroll">
        <table className="sm-table">
          <thead>
            <tr>
              <th>Subject</th>
              <th>List</th>
              <th>Status</th>
              <th>Recipients</th>
              <th>Sent</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((campaign) => (
              <tr key={campaign._id.toHexString()}>
                <td>
                  <Link href={`/admin/campaigns/${campaign._id.toHexString()}`}>
                    {campaign.subject || '(no subject yet)'}
                  </Link>
                  {campaign.pausedReason && (
                    <div className="muted">{campaign.pausedReason}</div>
                  )}
                </td>
                <td>{listNames.get(campaign.listId.toHexString()) ?? '—'}</td>
                <td>
                  <span className={`sm-badge is-${campaign.status}`}>{campaign.status}</span>
                </td>
                <td>{campaign.counts.recipients.toLocaleString('en-GB')}</td>
                <td>{campaign.counts.sent.toLocaleString('en-GB')}</td>
                <td>{campaign.createdAt.toISOString().slice(0, 10)}</td>
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
