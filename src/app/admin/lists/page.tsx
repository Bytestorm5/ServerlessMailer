import { ListsManager, type ListRow } from '@/components/admin/ListsManager';
import { config } from '@/lib/config';
import { listSummaries } from '@/lib/lists';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Lists — ServerlessMailer' };

export default async function ListsPage() {
  const summaries = await listSummaries();

  const rows: ListRow[] = summaries.map(
    ({ list, confirmed, pending, unsubscribed, campaigns }) => ({
      id: list._id.toHexString(),
      name: list.name,
      sendingDomain: list.sendingDomain,
      fromName: list.fromName,
      fromEmail: list.fromEmail,
      replyTo: list.replyTo,
      physicalAddress: list.physicalAddress,
      sesConfigurationSet: list.sesConfigurationSet,
      active: list.active,
      welcomeUrl: list.welcomeUrl ?? null,
      counts: { confirmed, pending, unsubscribed, campaigns },
    }),
  );

  return (
    <>
      <h1>Lists</h1>
      <p className="muted">
        One list per newsletter. Every campaign inherits its sending domain, From
        and Reply-To addresses, physical address and SES configuration set from
        here, so a mistake on this page reaches every recipient.
      </p>

      {/*
        The join command has to point at the public origin the confirmation and
        unsubscribe links use, not at whatever host the admin happens to be open
        on — a preview deployment would otherwise hand out its own URL. Only
        whether Turnstile is configured crosses to the client, never the secret.
      */}
      <ListsManager
        lists={rows}
        baseUrl={config.appBaseUrl()}
        turnstileRequired={config.turnstileSecret() !== undefined}
      />
    </>
  );
}
