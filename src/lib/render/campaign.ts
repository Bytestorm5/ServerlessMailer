import { config } from '@/lib/config';
import { buildClickToken, buildRecipientToken } from '@/lib/crypto/tokens';
import {
  parseMergeFields,
  renderMergeFields,
  resolveReplacements,
  toSesPlaceholders,
} from '@/lib/merge';
import { mapLinks } from '@/lib/render/doc';
import { docToContentHtml, docToEmailHtml, type EmailChrome } from '@/lib/render/html';
import { mapHtmlLinks, isFullHtmlDocument } from '@/lib/render/sanitize';
import {
  DEFAULT_TEMPLATE_HTML,
  applyTemplate,
  renderEmailDocument,
  stripTemplateOnlyPlaceholders,
} from '@/lib/render/template';
import { docToPlainText, htmlToPlainText } from '@/lib/render/text';
import type {
  BodyMode,
  CampaignDoc,
  EditorDoc,
  EditorNode,
  ListDoc,
  RecipientContext,
  SubscriberDoc,
} from '@/lib/types';

/**
 * Campaign rendering (spec §6.2, §7.1).
 *
 * `renderCampaignForSend` produces the **frozen** body: merge fields are reduced
 * to bare `{{placeholder}}` markers so the HTML doubles as an SES template, and
 * per-recipient values are supplied at send time as replacement data. The result
 * is stored on the campaign and never re-rendered — a template change mid-send
 * must not produce two different emails.
 *
 * `renderCampaignPreview` runs the *same* code path with everything resolved.
 * That is what makes a test send a real test (§6.5): same render, same merge,
 * same headers.
 *
 * There are three ways a campaign can become HTML, and all three end up here:
 *
 *  - **Editor JSON, built-in layout.** MJML, exactly as before.
 *  - **Editor JSON, custom template.** The body is rendered as plain semantic
 *    HTML and dropped into the template's `{{content}}` slot (§6.2a).
 *  - **Pasted HTML.** A fragment goes into the template slot like any other
 *    body; a whole `<html>` document *is* the email and only picks up the
 *    chrome guarantees.
 *
 * The template is passed in rather than fetched, because the two callers need
 * different ones: everything before freeze wants the list's current template,
 * and everything after it wants the copy frozen onto the campaign.
 */

export interface RenderedCampaign {
  subject: string;
  html: string;
  text: string;
}

/** The placeholder every rendered body carries; resolved per recipient. */
const UNSUBSCRIBE_PLACEHOLDER = '{{unsubscribe_url}}';
const RECIPIENT_TOKEN_PLACEHOLDER = '{{recipient_token}}';

/** Applies `fn` to every text node, returning a new document. */
function mapTextNodes(doc: EditorDoc, fn: (text: string) => string): EditorDoc {
  const walk = (node: EditorNode): EditorNode => {
    const next: EditorNode = { ...node };
    if (typeof next.text === 'string') next.text = fn(next.text);
    if (next.content) next.content = next.content.map(walk);
    return next;
  };
  return { ...doc, content: (doc.content ?? []).map(walk) };
}

/** `rich` unless the campaign says otherwise — the field post-dates the schema. */
export function campaignBodyMode(campaign: CampaignDoc): BodyMode {
  return campaign.bodyMode === 'html' ? 'html' : 'rich';
}

/**
 * Every text fragment that may contain a merge field, including the subject.
 *
 * `templateHtml` defaults to the copy frozen onto the campaign, which is what
 * the send pipeline wants: the fallbacks SES substitutes must be the ones that
 * were in force when the body was rendered, not whatever the template says an
 * hour later. Callers running *before* freeze pass the list's current template.
 */
export function campaignTemplateText(
  campaign: CampaignDoc,
  templateHtml?: string | null,
): string {
  return templateText(campaign, templateHtml);
}

function templateText(campaign: CampaignDoc, templateHtml?: string | null): string {
  const parts: string[] = [campaign.subject, campaign.preheader];

  if (campaignBodyMode(campaign) === 'html') {
    // Only the active mode contributes: a body left behind by a mode switch
    // must not block a send with merge fields nobody will ever see.
    parts.push(campaign.bodyHtmlSource ?? '');
  } else {
    const walk = (nodes: EditorNode[] = []) => {
      for (const node of nodes) {
        if (typeof node.text === 'string') parts.push(node.text);
        if (node.content) walk(node.content);
      }
    };
    walk(campaign.bodySource?.content ?? []);
  }

  const shell = templateHtml === undefined ? campaign.templateSource : templateHtml;
  // `{{content}}` and `{{preheader}}` mean something to the template renderer
  // and nothing to SES, so they must not reach the merge-field scanner.
  if (shell) parts.push(stripTemplateOnlyPlaceholders(shell));

  return parts.join('\n');
}

function openPixelUrl(campaign: CampaignDoc): string | undefined {
  if (!campaign.trackOpens) return undefined;
  // The recipient token is a placeholder here; SES substitutes it per
  // destination, which is what makes one frozen body serve every recipient.
  return `${config.appBaseUrl()}/api/t/o/${RECIPIENT_TOKEN_PLACEHOLDER}`;
}

/**
 * Rewrites each link through the signed redirector. The *target* is signed at
 * render time and the *recipient* is identified by a separate per-destination
 * token, so one frozen body serves every recipient without ever becoming an
 * open redirect (§12).
 */
function applyClickTracking(doc: EditorDoc, campaign: CampaignDoc): EditorDoc {
  if (!campaign.trackClicks) return doc;
  return mapLinks(doc, trackedUrl(campaign));
}

/**
 * The same rewrite for a pasted HTML body.
 *
 * Only the *body* is rewritten, never the template around it: routing the
 * footer's `{{unsubscribe_url}}` through the click redirector would break
 * one-click unsubscribe, which is the one link that must not move.
 */
function applyHtmlClickTracking(html: string, campaign: CampaignDoc): string {
  if (!campaign.trackClicks) return html;
  return mapHtmlLinks(html, trackedUrl(campaign));
}

function trackedUrl(campaign: CampaignDoc): (href: string, index: number) => string {
  const base = config.appBaseUrl();
  return (href, index) => {
    const token = buildClickToken({
      campaignId: campaign._id.toHexString(),
      linkIndex: index,
      url: href,
    });
    return `${base}/api/t/c/${token}?r=${RECIPIENT_TOKEN_PLACEHOLDER}`;
  };
}

function chromeFor(campaign: CampaignDoc, list: ListDoc): EmailChrome {
  return {
    preheader: campaign.preheader,
    physicalAddress: list.physicalAddress,
    listName: list.name,
    unsubscribePlaceholder: UNSUBSCRIBE_PLACEHOLDER,
    openPixelUrl: openPixelUrl(campaign),
  };
}

/** The plain-text part always carries the address and unsubscribe link too. */
function textWithChrome(body: string, list: ListDoc, unsubscribe: string): string {
  return [
    body.trimEnd(),
    '',
    '—',
    `Unsubscribe: ${unsubscribe}`,
    list.physicalAddress,
  ].join('\n');
}

/**
 * Turns a tracked body into the finished email HTML, whichever way it was
 * written.
 *
 * A pasted HTML body always renders through *a* template, because a fragment
 * with no `<html>` around it is not an email; when the list has none configured
 * the built-in default is used. Editor JSON keeps the MJML layout unless the
 * list has a template, so switching a list to a template is opt-in and
 * reversible.
 */
async function renderBodyHtml(
  chrome: EmailChrome,
  templateHtml: string | null | undefined,
  body: { doc: EditorDoc } | { html: string },
): Promise<string> {
  if ('html' in body) {
    // A whole document is the email. It still picks up the postal address,
    // the unsubscribe link and the open pixel — those are not negotiable.
    if (isFullHtmlDocument(body.html)) return renderEmailDocument(body.html, chrome);
    return applyTemplate({
      templateHtml: templateHtml || DEFAULT_TEMPLATE_HTML,
      contentHtml: body.html,
      chrome,
    });
  }

  if (templateHtml) {
    return applyTemplate({
      templateHtml,
      contentHtml: docToContentHtml(body.doc),
      chrome,
    });
  }
  return docToEmailHtml(body.doc, chrome);
}

export async function renderCampaignForSend(
  campaign: CampaignDoc,
  list: ListDoc,
  templateHtml?: string | null,
): Promise<RenderedCampaign> {
  const chrome = chromeFor(campaign, list);
  const subject = toSesPlaceholders(campaign.subject);

  if (campaignBodyMode(campaign) === 'html') {
    const withPlaceholders = toSesPlaceholders(campaign.bodyHtmlSource ?? '');
    const tracked = applyHtmlClickTracking(withPlaceholders, campaign);
    return {
      subject,
      html: await renderBodyHtml(chrome, templateHtml, { html: tracked }),
      text: textWithChrome(htmlToPlainText(tracked), list, UNSUBSCRIBE_PLACEHOLDER),
    };
  }

  // Placeholders are reduced *before* rendering. Doing it afterwards would mean
  // the fallback's quotes had already been HTML-escaped, and the parse would
  // silently fail.
  const withPlaceholders = mapTextNodes(campaign.bodySource, toSesPlaceholders);
  const tracked = applyClickTracking(withPlaceholders, campaign);

  return {
    subject,
    html: await renderBodyHtml(chrome, templateHtml, { doc: tracked }),
    text: textWithChrome(docToPlainText(tracked), list, UNSUBSCRIBE_PLACEHOLDER),
  };
}

export async function renderCampaignPreview(
  campaign: CampaignDoc,
  list: ListDoc,
  ctx: RecipientContext,
  templateHtml?: string | null,
): Promise<RenderedCampaign> {
  const data: Record<string, string> = {
    ...ctx.attributes,
    email: ctx.email,
    physical_address: list.physicalAddress,
    list_name: list.name,
    subject: campaign.subject,
    unsubscribe_url: ctx.unsubscribeUrl,
    preferences_url: ctx.unsubscribeUrl,
    recipient_token: ctx.trackingToken ?? '',
  };

  const chrome: EmailChrome = {
    ...chromeFor(campaign, list),
    unsubscribePlaceholder: ctx.unsubscribeUrl,
    openPixelUrl: campaign.trackOpens ? ctx.openPixelUrl : undefined,
  };
  const resolveToken = (value: string) =>
    value.split(RECIPIENT_TOKEN_PLACEHOLDER).join(ctx.trackingToken ?? '');

  if (campaignBodyMode(campaign) === 'html') {
    const resolvedHtml = renderMergeFields(campaign.bodyHtmlSource ?? '', data);
    const trackedHtml = applyHtmlClickTracking(resolvedHtml, campaign);
    const withRecipientHtml = resolveToken(trackedHtml);

    const rendered = await renderBodyHtml(chrome, templateHtml, {
      html: withRecipientHtml,
    });

    return {
      subject: renderMergeFields(campaign.subject, data),
      html: resolveToken(rendered),
      text: textWithChrome(htmlToPlainText(withRecipientHtml), list, ctx.unsubscribeUrl),
    };
  }

  const resolved = mapTextNodes(campaign.bodySource, (text) =>
    renderMergeFields(text, data),
  );

  // Click tracking is applied to the resolved document so the preview exercises
  // the same rewriting the real send does.
  const tracked = applyClickTracking(resolved, campaign);
  const withRecipient = mapTextNodes(tracked, resolveToken);

  const rawHtml = await renderBodyHtml(chrome, templateHtml, { doc: withRecipient });
  // Any link href rewritten before resolution still carries the token marker.
  const html = resolveToken(rawHtml);

  const text = textWithChrome(
    docToPlainText(withRecipient),
    list,
    ctx.unsubscribeUrl,
  );

  return {
    subject: renderMergeFields(campaign.subject, data),
    html,
    text,
  };
}

export function unsubscribeUrlFor(
  campaignId: string,
  subscriberId: string,
): { url: string; token: string } {
  const token = buildRecipientToken(subscriberId, campaignId);
  return {
    token,
    url: `${config.appBaseUrl()}/api/unsubscribe?t=${encodeURIComponent(token)}`,
  };
}

/**
 * Per-recipient replacement data for SES (§7.4 step 3).
 *
 * Fallbacks are applied here rather than in the template, because SES templates
 * have no notion of a default — every value handed to SES is already final.
 */
export function buildReplacements(
  campaign: CampaignDoc,
  list: ListDoc,
  subscriber: SubscriberDoc,
): Record<string, string> {
  const { url, token } = unsubscribeUrlFor(
    campaign._id.toHexString(),
    subscriber._id.toHexString(),
  );

  const data: Record<string, string> = {
    ...subscriber.attributes,
    email: subscriber.email,
    physical_address: list.physicalAddress,
    list_name: list.name,
    subject: campaign.subject,
    unsubscribe_url: url,
    preferences_url: url,
    recipient_token: token,
  };

  const resolved = resolveReplacements(templateText(campaign), data);

  // The system fields are always supplied, whether or not the body mentions
  // them: the rendered chrome references them even when the writer never did.
  return {
    ...resolved,
    email: subscriber.email,
    physical_address: list.physicalAddress,
    list_name: list.name,
    unsubscribe_url: url,
    preferences_url: url,
    recipient_token: token,
  };
}

/**
 * Per-recipient headers (§9.1). Both are mandatory under the Google and Yahoo
 * bulk sender requirements at this volume.
 */
export function buildRecipientHeaders(
  campaign: CampaignDoc,
  list: ListDoc,
  subscriber: SubscriberDoc,
): Record<string, string> {
  const { url } = unsubscribeUrlFor(
    campaign._id.toHexString(),
    subscriber._id.toHexString(),
  );
  const mailto = config.unsubscribeMailto();

  const targets = mailto ? [`<mailto:${mailto}>`, `<${url}>`] : [`<${url}>`];

  return {
    'List-Unsubscribe': targets.join(', '),
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

/** Merge fields referenced by a campaign, for the pre-send gate and the UI. */
export function mergeFieldsUsed(campaign: CampaignDoc) {
  return parseMergeFields(templateText(campaign));
}
