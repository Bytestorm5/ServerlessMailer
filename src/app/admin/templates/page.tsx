import { TemplateManager, type TemplateEntry } from '@/components/template/TemplateManager';
import {
  DEFAULT_CONFIRMATION_TEMPLATE_HTML,
  DEFAULT_TEMPLATE_HTML,
  TEMPLATE_PLACEHOLDERS,
} from '@/lib/render/template';
import { templateSummaries } from '@/lib/templates';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Templates — ServerlessMailer' };

export default async function TemplatesPage() {
  const summaries = await templateSummaries();

  const entries: TemplateEntry[] = summaries.map((summary) => ({
    listId: summary.listId.toHexString(),
    listName: summary.listName,
    kind: summary.kind,
    stored: summary.stored,
    html: summary.html,
    updatedAt: summary.updatedAt?.toISOString() ?? null,
  }));

  return (
    <>
      <h1>Templates</h1>
      <p className="muted">
        The email around the email: one HTML document per list, for each of the two emails
        a list sends. Write whatever you like — tables, media queries, Outlook conditional
        comments — and the renderer inlines your CSS before sending, because Gmail drops{' '}
        <code>&lt;style&gt;</code>. The postal address is appended if you leave it out, as
        is the unsubscribe link on a campaign; they are legally required and not optional.
      </p>

      {/*
        The defaults are passed down rather than fetched by the client, so the
        editor never has to import the renderer — and neither does the browser
        bundle.
      */}
      <TemplateManager
        entries={entries}
        defaults={{
          campaign: DEFAULT_TEMPLATE_HTML,
          confirmation: DEFAULT_CONFIRMATION_TEMPLATE_HTML,
        }}
        placeholders={{
          campaign: TEMPLATE_PLACEHOLDERS.campaign.map((placeholder) => ({ ...placeholder })),
          confirmation: TEMPLATE_PLACEHOLDERS.confirmation.map((placeholder) => ({
            ...placeholder,
          })),
        }}
      />
    </>
  );
}
