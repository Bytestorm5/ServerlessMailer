import { config } from '@/lib/config';
import { buildClickToken, buildRecipientToken } from '@/lib/crypto/tokens';
import {
  parseMergeFields,
  renderMergeFields,
  resolveReplacements,
  toSesPlaceholders,
} from '@/lib/merge';
import { mapLinks } from '@/lib/render/doc';
import { docToEmailHtml, type EmailChrome } from '@/lib/render/html';
import { docToPlainText } from '@/lib/render/text';
import type {
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

/** Every text fragment that may contain a merge field, including the subject. */
function templateText(campaign: CampaignDoc): string {
  const parts: string[] = [campaign.subject, campaign.preheader];
  const walk = (nodes: EditorNode[] = []) => {
    for (const node of nodes) {
      if (typeof node.text === 'string') parts.push(node.text);
      if (node.content) walk(node.content);
    }
  };
  walk(campaign.bodySource?.content ?? []);
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
  const base = config.appBaseUrl();
  return mapLinks(doc, (href, index) => {
    const token = buildClickToken({
      campaignId: campaign._id.toHexString(),
      linkIndex: index,
      url: href,
    });
    return `${base}/api/t/c/${token}?r=${RECIPIENT_TOKEN_PLACEHOLDER}`;
  });
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

export async function renderCampaignForSend(
  campaign: CampaignDoc,
  list: ListDoc,
): Promise<RenderedCampaign> {
  // Placeholders are reduced *before* rendering. Doing it afterwards would mean
  // the fallback's quotes had already been HTML-escaped, and the parse would
  // silently fail.
  const withPlaceholders = mapTextNodes(campaign.bodySource, toSesPlaceholders);
  const tracked = applyClickTracking(withPlaceholders, campaign);

  const html = await docToEmailHtml(tracked, chromeFor(campaign, list));
  const text = textWithChrome(
    docToPlainText(tracked),
    list,
    UNSUBSCRIBE_PLACEHOLDER,
  );

  return {
    subject: toSesPlaceholders(campaign.subject),
    html,
    text,
  };
}

export async function renderCampaignPreview(
  campaign: CampaignDoc,
  list: ListDoc,
  ctx: RecipientContext,
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

  const resolved = mapTextNodes(campaign.bodySource, (text) =>
    renderMergeFields(text, data),
  );

  // Click tracking is applied to the resolved document so the preview exercises
  // the same rewriting the real send does.
  const tracked = applyClickTracking(resolved, campaign);
  const withRecipient = mapTextNodes(tracked, (text) =>
    text.split(RECIPIENT_TOKEN_PLACEHOLDER).join(ctx.trackingToken ?? ''),
  );

  const chrome: EmailChrome = {
    ...chromeFor(campaign, list),
    unsubscribePlaceholder: ctx.unsubscribeUrl,
    openPixelUrl: campaign.trackOpens ? ctx.openPixelUrl : undefined,
  };

  const rawHtml = await docToEmailHtml(withRecipient, chrome);
  // Any link href rewritten before resolution still carries the token marker.
  const html = rawHtml.split(RECIPIENT_TOKEN_PLACEHOLDER).join(ctx.trackingToken ?? '');

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
