import { TemplateManager, type TemplateListOption } from '@/components/template/TemplateManager';
import { DEFAULT_TEMPLATE_HTML, TEMPLATE_PLACEHOLDERS } from '@/lib/render/template';
import { templateSummaries } from '@/lib/templates';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Templates — ServerlessMailer' };

export default async function TemplatesPage() {
  const summaries = await templateSummaries();

  const lists: TemplateListOption[] = summaries.map((summary) => ({
    id: summary.listId.toHexString(),
    name: summary.listName,
    stored: summary.stored,
    html: summary.html,
    updatedAt: summary.updatedAt?.toISOString() ?? null,
  }));

  return (
    <>
      <h1>Templates</h1>
      <p className="muted">
        The email around the email: one HTML document per list, with{' '}
        <code>{'{{content}}'}</code> where the campaign body lands. Write whatever you
        like — tables, media queries, Outlook conditional comments — and the renderer
        inlines your CSS before sending, because Gmail drops <code>&lt;style&gt;</code>.
        The postal address and unsubscribe link are appended automatically if you leave
        them out; they are legally required and not optional.
      </p>

      {/*
        The default is passed down rather than fetched by the client, so the
        editor never has to import the renderer — and neither does the browser
        bundle.
      */}
      <TemplateManager
        lists={lists}
        defaultHtml={DEFAULT_TEMPLATE_HTML}
        placeholders={TEMPLATE_PLACEHOLDERS.map((placeholder) => ({
          key: placeholder.key,
          label: placeholder.label,
          description: placeholder.description,
        }))}
      />
    </>
  );
}
