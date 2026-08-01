import mjml2html from 'mjml';
import { compileMergeFields, MergePlanBuilder } from '../merge';
import type { CampaignDoc, ListDoc, MergePlanEntry, TiptapDoc } from '../types';
import { OPEN_PIXEL_VARIABLE, clickVariable } from '../tracking';
import { buildCampaignMjml, buildFooterText } from './layout';
import { LinkRegistry, resolveLinkPlaceholders } from './link-registry';
import { escapeHtml, tiptapToMjmlBody } from './tiptap-to-mjml';
import { tiptapToText } from './tiptap-to-text';

/**
 * The single render path.
 *
 * Freeze, preview and test sends all call this function. A test send that
 * exercised a different code path would not be a test (§6.5), and a preview
 * that rendered differently from the send would be a lie.
 *
 * The output still contains `{{…}}` placeholders: per-recipient substitution
 * happens at SES, from the merge plan returned here.
 */

export interface RenderedCampaign {
  /** Subject with merge fields compiled to template variables. */
  subjectTemplate: string;
  html: string;
  text: string;
  mergePlan: MergePlanEntry[];
  /** Click-tracked destinations in `c0`, `c1`, … order. Empty when untracked. */
  trackedLinks: string[];
  /** Every absolute link in the body, tracked or not — used by the gate. */
  allLinks: string[];
  /** Hrefs that were rejected for being relative, empty or non-http. */
  invalidLinks: string[];
  mjmlErrors: string[];
}

export interface RenderOptions {
  trackOpens: boolean;
  trackClicks: boolean;
}

export interface RenderableCampaign {
  subject: string;
  preheader: string;
  bodySource: TiptapDoc;
}

export interface RenderableList {
  name: string;
  physicalAddress: string;
}

const UNSUBSCRIBE_PLACEHOLDER = '{{unsubscribe_url}}';
const PREFERENCES_PLACEHOLDER = '{{preferences_url}}';

export function renderCampaign(
  campaign: RenderableCampaign,
  list: RenderableList,
  options: RenderOptions,
): RenderedCampaign {
  const builder = new MergePlanBuilder();
  const links = new LinkRegistry();

  const subjectTemplate = compileMergeFields(campaign.subject, builder);
  const preheaderHtml = compileMergeFields(campaign.preheader, builder, escapeHtml);

  const bodyMjml = tiptapToMjmlBody(campaign.bodySource, builder, links);
  const bodyText = tiptapToText(campaign.bodySource, builder, links);

  const mjml = buildCampaignMjml({
    bodyMjml,
    preheaderHtml,
    listName: list.name,
    physicalAddress: list.physicalAddress,
    unsubscribeUrl: UNSUBSCRIBE_PLACEHOLDER,
    preferencesUrl: PREFERENCES_PLACEHOLDER,
  });

  const compiled = mjml2html(mjml, {
    validationLevel: 'soft',
    minify: false,
    keepComments: false,
  });

  const allLinks = links.list();
  const trackedLinks = options.trackClicks ? allLinks : [];

  // In an HTML attribute an unescaped `&` in a query string is invalid markup
  // and some clients mangle it; in the text part it must stay verbatim.
  const html = resolveLinkPlaceholders(compiled.html, (index) =>
    options.trackClicks ? `{{${clickVariable(index)}}}` : escapeHtml(allLinks[index] ?? ''),
  );

  const text = resolveLinkPlaceholders(
    `${bodyText}\n${buildFooterText({
      physicalAddress: list.physicalAddress,
      unsubscribeUrl: UNSUBSCRIBE_PLACEHOLDER,
      preferencesUrl: PREFERENCES_PLACEHOLDER,
    })}\n`,
    (index) => (options.trackClicks ? `{{${clickVariable(index)}}}` : (allLinks[index] ?? '')),
  );

  return {
    subjectTemplate,
    html: options.trackOpens ? injectOpenPixel(html) : html,
    text,
    mergePlan: builder.plan(),
    trackedLinks,
    allLinks,
    invalidLinks: links.invalidLinks(),
    mjmlErrors: (compiled.errors ?? []).map((e) => e.formattedMessage ?? String(e)),
  };
}

function injectOpenPixel(html: string): string {
  const pixel = `<img src="{{${OPEN_PIXEL_VARIABLE}}}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px;" />`;
  const closing = html.lastIndexOf('</body>');
  if (closing < 0) return html + pixel;
  return `${html.slice(0, closing)}${pixel}${html.slice(closing)}`;
}

/** Convenience wrapper for a stored campaign document. */
export function renderStoredCampaign(campaign: CampaignDoc, list: ListDoc): RenderedCampaign {
  return renderCampaign(
    { subject: campaign.subject, preheader: campaign.preheader, bodySource: campaign.bodySource },
    { name: list.name, physicalAddress: list.physicalAddress },
    { trackOpens: campaign.trackOpens, trackClicks: campaign.trackClicks },
  );
}
