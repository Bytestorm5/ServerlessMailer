import { notFound } from 'next/navigation';
import { ObjectId } from 'mongodb';
import {
  campaignsCollection,
  eventsCollection,
  sentLogCollection,
  subscribersCollection,
} from '@/lib/db/collections';
import { displayName } from '@/lib/subscriber-name';
import { isSuppressed } from '@/lib/suppressions';

export const dynamic = 'force-dynamic';

/**
 * Individual subscriber detail (spec section 4.5): full status history, consent
 * evidence, campaigns sent, and events received.
 */
export default async function SubscriberDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!ObjectId.isValid(id)) notFound();

  const subscriber = await (await subscribersCollection()).findOne({ _id: new ObjectId(id) });
  if (!subscriber) notFound();

  const sent = await (await sentLogCollection())
    .find({ subscriberId: subscriber._id })
    .sort({ sentAt: -1 })
    .limit(50)
    .toArray();
  const campaigns = await (await campaignsCollection())
    .find({ _id: { $in: sent.map((entry) => entry.campaignId) } })
    .toArray();
  const subjects = new Map(campaigns.map((c) => [c._id.toHexString(), c.subject]));
  const events = await (await eventsCollection())
    .find({ subscriberId: subscriber._id })
    .sort({ ts: -1 })
    .limit(100)
    .toArray();
  const suppressed = await isSuppressed(subscriber.email);

  const name = displayName(subscriber);

  return (
    <>
      <h1 style={{ fontSize: '1.25rem' }}>{subscriber.email}</h1>
      {name && <p style={{ margin: '0.25rem 0 0' }}>{name}</p>}
      <p>
        <span className={`sm-badge is-${subscriber.status}`}>{subscriber.status}</span>{' '}
        {suppressed && <span className="sm-badge is-bounced">suppressed</span>}
      </p>

      <h2 style={{ fontSize: '1rem' }}>Consent evidence</h2>
      <p className="muted">
        Written once and never modified, including after unsubscribe. This is the record
        produced if a complaint is ever escalated.
      </p>
      <dl className="sm-cards">
        <div className="sm-card">
          <dt>Confirmed at</dt>
          <dd style={{ fontSize: '0.95rem' }}>
            {subscriber.confirmedAt?.toISOString() ?? 'never'}
          </dd>
        </div>
        <div className="sm-card">
          <dt>Confirm IP</dt>
          <dd style={{ fontSize: '0.95rem' }}>{subscriber.confirmIp ?? '—'}</dd>
        </div>
        <div className="sm-card">
          <dt>Signed up via</dt>
          <dd style={{ fontSize: '0.95rem' }}>{subscriber.source}</dd>
        </div>
      </dl>
      {subscriber.confirmUserAgent && (
        <p className="muted">User agent: {subscriber.confirmUserAgent}</p>
      )}

      <h2 style={{ fontSize: '1rem' }}>Attributes</h2>
      {Object.keys(subscriber.attributes ?? {}).length === 0 ? (
        <p className="muted">None recorded.</p>
      ) : (
        <table className="sm-table">
          <tbody>
            {Object.entries(subscriber.attributes).map(([key, value]) => (
              <tr key={key}>
                <th style={{ width: '12rem' }}>{key}</th>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={{ fontSize: '1rem' }}>Status history</h2>
      <table className="sm-table">
        <thead>
          <tr>
            <th>When</th>
            <th>From</th>
            <th>To</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {(subscriber.history ?? []).map((entry, index) => (
            <tr key={index}>
              <td>{entry.at.toISOString()}</td>
              <td>{entry.from ?? '—'}</td>
              <td>{entry.to}</td>
              <td>{entry.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ fontSize: '1rem' }}>Campaigns sent</h2>
      <table className="sm-table">
        <tbody>
          {sent.map((entry) => (
            <tr key={entry._id.toHexString()}>
              <td>{subjects.get(entry.campaignId.toHexString()) ?? '(deleted)'}</td>
              <td>{entry.sentAt.toISOString()}</td>
            </tr>
          ))}
          {sent.length === 0 && (
            <tr>
              <td className="muted">No campaigns sent to this address.</td>
            </tr>
          )}
        </tbody>
      </table>

      <h2 style={{ fontSize: '1rem' }}>Events</h2>
      <table className="sm-table">
        <tbody>
          {events.map((event) => (
            <tr key={event._id.toHexString()}>
              <td>{event.type}</td>
              <td>{event.ts.toISOString()}</td>
              <td>{event.url ?? event.detail ?? ''}</td>
            </tr>
          ))}
          {events.length === 0 && (
            <tr>
              <td className="muted">No events received.</td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
