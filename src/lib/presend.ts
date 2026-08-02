import type { ObjectId } from 'mongodb';
import { campaignsCollection, listsCollection } from '@/lib/db/collections';
import { findMergeFieldsWithoutFallback, findUnknownMergeFields } from '@/lib/merge';
import { collectLinks, isEmptyDoc, isImageOnly, validateEditorDoc } from '@/lib/render/doc';
import {
  campaignBodyMode,
  campaignTemplateText,
  renderCampaignForSend,
} from '@/lib/render/campaign';
import {
  collectHtmlLinks,
  isEmptyHtml,
  isImageOnlyHtml,
  sanitizeEmailHtml,
} from '@/lib/render/sanitize';
import { countSegment } from '@/lib/segments';
import { getTemplateHtml } from '@/lib/templates';
import { getSesAdapter } from '@/lib/ses/registry';
import type { PresendCheck, PresendResult } from '@/lib/types';

export type { PresendCheck, PresendResult } from '@/lib/types';

/**
 * The pre-send validation gate (spec §6.6).
 *
 * A campaign cannot transition to `sending` unless every check passes. Hard
 * block, no override — there is no bypass parameter here, and callers cannot
 * construct a passing result without actually passing.
 *
 * Several checks are deliberately made against the *rendered* output rather
 * than the source: that way a regression in the email template that dropped the
 * unsubscribe link or the postal address is caught here, before the send, and
 * not by a regulator afterwards.
 *
 * Every check reads whichever body the campaign's mode selects (§6.1). A
 * campaign that was switched to HTML still carries the editor document it used
 * to have, and judging the send against that would be judging something nobody
 * is going to receive.
 */

/**
 * Whether a link will still work once the email has left the building.
 *
 * A relative URL resolves against the mailbox provider's domain, and `href="#"`
 * — the placeholder every half-finished template contains — goes nowhere at
 * all. A merge placeholder is fine: it becomes a real URL per recipient.
 *
 * `mailto:` and `tel:` pass because they work in an inbox. They cannot occur in
 * an editor document, where `render/doc.ts` already restricts a link mark to
 * absolute http(s); this is about the markup an operator pastes.
 */
function isSendableLink(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed.startsWith('{{')) return true;
  try {
    const url = new URL(trimmed);
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol);
  } catch {
    return false;
  }
}

export async function validateCampaignForSend(
  campaignId: ObjectId,
  now: Date = new Date(),
): Promise<PresendResult> {
  const checks: PresendCheck[] = [];
  const add = (id: string, label: string, passed: boolean, detail?: string) => {
    checks.push({ id, label, passed, ...(detail ? { detail } : {}) });
  };

  const campaign = await (await campaignsCollection()).findOne({ _id: campaignId });
  if (!campaign) {
    add('campaign_exists', 'Campaign exists', false, 'No such campaign');
    return { passed: false, checks, recipientCount: 0 };
  }

  const list = await (await listsCollection()).findOne({ _id: campaign.listId });
  if (!list) {
    add('list_exists', 'Sending list exists', false, 'No such list');
    return { passed: false, checks, recipientCount: 0 };
  }

  add('subject', 'Subject line is present', campaign.subject.trim().length > 0);

  // The list's *current* template, not the frozen copy: this runs before
  // freeze, and it is the template the send is about to use.
  const templateHtml = await getTemplateHtml(campaign.listId);
  const htmlMode = campaignBodyMode(campaign) === 'html';
  const bodyHtmlSource = campaign.bodyHtmlSource ?? '';

  if (htmlMode) {
    // Pasted HTML is not held to the closed node set — that is the point of it.
    // What it *is* held to is the sanitizer, and anything the sanitizer would
    // strip is reported here so the operator learns about it before the send
    // rather than from an email that arrived missing a piece.
    const { removed } = sanitizeEmailHtml(bodyHtmlSource);
    add(
      'body_valid',
      'Body HTML is safe to send',
      true,
      removed.length > 0 ? `Will be removed before sending: ${removed.join(', ')}` : undefined,
    );
  } else {
    const validation = validateEditorDoc(campaign.bodySource);
    add(
      'body_valid',
      'Body uses only supported formatting',
      validation.ok,
      validation.ok ? undefined : validation.errors.slice(0, 3).join('; '),
    );
  }

  const empty = htmlMode ? isEmptyHtml(bodyHtmlSource) : isEmptyDoc(campaign.bodySource);
  const imageOnly =
    !empty && (htmlMode ? isImageOnlyHtml(bodyHtmlSource) : isImageOnly(campaign.bodySource));
  add(
    'body_non_empty',
    'Body has content and is not image-only',
    !empty && !imageOnly,
    empty ? 'The body is empty' : imageOnly ? 'Image-only bodies are a spam signal' : undefined,
  );

  add(
    'physical_address',
    'Physical postal address is configured',
    list.physicalAddress.trim().length > 0,
    list.physicalAddress.trim() ? undefined : 'Legally required in every email',
  );

  // Merge fields: every non-system field must carry a fallback, or a recipient
  // with a missing attribute receives "Hi ,". The template counts — a
  // `{{first_name}}` in the greeting line of a custom shell is no different
  // from one in the body.
  const template = campaignTemplateText(campaign, templateHtml);
  const withoutFallback = findMergeFieldsWithoutFallback(template);
  add(
    'merge_fallbacks',
    'All merge fields have fallbacks',
    withoutFallback.length === 0,
    withoutFallback.length
      ? `${withoutFallback.map((f) => f.field).join(', ')} has no fallback`
      : undefined,
  );

  const unknown = findUnknownMergeFields(template);
  add(
    'merge_fields_known',
    'All merge fields are recognised',
    unknown.length === 0,
    unknown.length ? `Unknown field: ${unknown.map((f) => f.field).join(', ')}` : undefined,
  );

  // Links must be absolute: a relative URL resolves against the mailbox
  // provider's domain and is simply broken.
  const links = htmlMode
    ? collectHtmlLinks(bodyHtmlSource)
    : collectLinks(campaign.bodySource).map(({ href }) => href);
  const badLinks = links.filter((href) => !isSendableLink(href));
  add(
    'links_absolute',
    'All links are absolute and resolvable',
    badLinks.length === 0,
    badLinks.length ? `Not absolute: ${badLinks.join(', ')}` : undefined,
  );

  // Rendering here doubles as a check that the template itself still works.
  let renderedOk = false;
  let hasUnsubscribe = false;
  let hasAddress = false;
  let renderError: string | undefined;
  try {
    const rendered = await renderCampaignForSend(campaign, list, templateHtml);
    renderedOk = true;
    hasUnsubscribe =
      rendered.html.includes('{{unsubscribe_url}}') &&
      rendered.text.includes('{{unsubscribe_url}}');
    hasAddress =
      list.physicalAddress.trim().length > 0 &&
      rendered.html.includes(list.physicalAddress.trim().slice(0, 24));
  } catch (err) {
    renderError = err instanceof Error ? err.message : String(err);
  }

  add('renders', 'Email renders successfully', renderedOk, renderError);
  add(
    'unsubscribe_placeholder',
    'Unsubscribe link is present in the email',
    hasUnsubscribe,
    hasUnsubscribe ? undefined : 'Legally required',
  );
  add(
    'physical_address_rendered',
    'Postal address appears in the email',
    hasAddress,
    hasAddress ? undefined : 'Legally required',
  );

  // A wasted send is cheap to prevent and expensive to discover.
  let verified = false;
  let verifyError: string | undefined;
  try {
    const ses = await getSesAdapter();
    verified = await ses.isIdentityVerified(list.sendingDomain);
  } catch (err) {
    verifyError = err instanceof Error ? err.message : String(err);
  }
  add(
    'from_domain_verified',
    'From-domain is verified in SES',
    verified,
    verified ? undefined : verifyError ?? `${list.sendingDomain} is not a verified identity`,
  );

  const recipientCount = await countSegment(campaign.listId, campaign.segmentQuery);
  add(
    'recipient_count',
    'Segment matches at least one recipient',
    recipientCount > 0,
    recipientCount > 0 ? `${recipientCount} recipients` : 'This segment matches nobody',
  );

  void now;

  return {
    passed: checks.every((check) => check.passed),
    checks,
    recipientCount,
  };
}
