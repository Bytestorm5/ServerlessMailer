import type { ObjectId } from 'mongodb';
import { campaignsCollection, listsCollection } from '@/lib/db/collections';
import { findMergeFieldsWithoutFallback, findUnknownMergeFields } from '@/lib/merge';
import { collectLinks, isEmptyDoc, isImageOnly, validateEditorDoc } from '@/lib/render/doc';
import { campaignTemplateText, renderCampaignForSend } from '@/lib/render/campaign';
import { countSegment } from '@/lib/segments';
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
 */
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

  const validation = validateEditorDoc(campaign.bodySource);
  add(
    'body_valid',
    'Body uses only supported formatting',
    validation.ok,
    validation.ok ? undefined : validation.errors.slice(0, 3).join('; '),
  );

  const empty = isEmptyDoc(campaign.bodySource);
  const imageOnly = !empty && isImageOnly(campaign.bodySource);
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
  // with a missing attribute receives "Hi ,".
  const template = campaignTemplateText(campaign);
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
  const links = collectLinks(campaign.bodySource);
  const badLinks = links.filter(({ href }) => {
    try {
      const url = new URL(href);
      return url.protocol !== 'http:' && url.protocol !== 'https:';
    } catch {
      return true;
    }
  });
  add(
    'links_absolute',
    'All links are absolute and resolvable',
    badLinks.length === 0,
    badLinks.length ? `Not absolute: ${badLinks.map((l) => l.href).join(', ')}` : undefined,
  );

  // Rendering here doubles as a check that the template itself still works.
  let renderedOk = false;
  let hasUnsubscribe = false;
  let hasAddress = false;
  let renderError: string | undefined;
  try {
    const rendered = await renderCampaignForSend(campaign, list);
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
