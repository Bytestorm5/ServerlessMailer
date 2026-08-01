import { listsCollection } from '@/lib/db/collections';
import { ImportPanel } from '@/components/admin/ImportPanel';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Import & export — ServerlessMailer' };

export default async function ImportPage() {
  const lists = await (await listsCollection()).find({}).sort({ name: 1 }).toArray();

  return (
    <>
      <h1>Import &amp; export</h1>
      <p className="muted">
        Import the suppression list <strong>before</strong> any subscribers. Importing
        without it re-mails people who opted out, which is a CAN-SPAM problem as well as a
        deliverability one.
      </p>

      <ImportPanel lists={lists.map((l) => ({ id: l._id.toHexString(), name: l.name }))} />

      <h2 style={{ fontSize: '1rem', marginTop: '2rem' }}>Export</h2>
      <p className="muted">
        Full CSV export including status and consent evidence. Export exists partly so
        this application is never a lock-in trap.
      </p>
      <ul>
        {lists.map((list) => (
          <li key={list._id.toHexString()}>
            <a href={`/api/admin/export?listId=${list._id.toHexString()}`}>
              {list.name} — all subscribers
            </a>
          </li>
        ))}
        <li>
          <a href="/api/admin/export?what=suppressions">Suppression list</a>
        </li>
      </ul>
    </>
  );
}
