import type { ObjectId } from 'mongodb';
import { getMailer } from './mailer';
import { BUILTIN_SUBSCRIBER_FIELDS, isSystemField, parseMergeFields } from './merge';
import { renderCampaign } from './render/render-campaign';
import { documentHasImage, documentTextContent } from './render/tiptap-to-mjml';
import { countSegment } from './segments';
import type { CampaignDoc, ListDoc, TiptapDoc, TiptapNode } from './types';

/**
 * The pre-send validation gate (§6.6).
 *
 * A campaign cannot transition to `sending` unless every check passes. Hard
 * block, no override flag — the whole point is that there is no way to argue
 * with it at 11pm.
 */

export interface GateCheck {
  id: string;
  label: string;
  passed: boolean;
  detail?: string;
  /** Advisory findings that inform but do not block. */
  warning?: boolean;
}

export interface GateResult {
  passed: boolean;
  checks: GateCheck[];
  recipientCount: number;
}

/** Every merge field occurrence anywhere in a campaign. */
export function collectMergeFields(campaign: {
  subject: string;
  preheader: string;
  bodySource: TiptapDoc;
}): { field: string; fallback: string | null; where: string }[] {
  const found: { field: string; fallback: string | null; where: string }[] = [];

  for (const parsed of parseMergeFields(campaign.subject)) {
    found.push({ field: parsed.field, fallback: parsed.fallback, where: 'subject' });
  }
  for (const parsed of parseMergeFields(campaign.preheader)) {
    found.push({ field: parsed.field, fallback: parsed.fallback, where: 'preheader' });
  }

  const walk = (node: TiptapNode) => {
    if (node.type === 'text' && node.text) {
      for (const parsed of parseMergeFields(node.text)) {
        found.push({ field: parsed.field, fallback: parsed.fallback, where: 'body' });
      }
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(campaign.bodySource);

  return found;
}

export function availableMergeFields(list: Pick<ListDoc, 'mergeFields'>): string[] {
  return [...BUILTIN_SUBSCRIBER_FIELDS, ...(list.mergeFields ?? [])];
}

/**
 * Best-effort reachability probe.
 *
 * A definitive "this page does not exist" blocks the send; anything ambiguous
 * — a timeout, a bot-blocking 403, a server that rejects HEAD — is reported as
 * a warning. Treating an ambiguous answer as failure would make the gate a
 * coin toss on any site behind a WAF.
 */
async function probeLink(url: string): Promise<{ url: string; status: number | null; fatal: boolean; note: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    let response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    if (response.status === 405 || response.status === 501) {
      response = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
    }
    const fatal = response.status === 404 || response.status === 410;
    return { url, status: response.status, fatal, note: `HTTP ${response.status}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // DNS failure is definitive; a timeout or TLS quirk is not.
    const fatal = /ENOTFOUND|getaddrinfo|EAI_AGAIN/i.test(message);
    return { url, status: null, fatal, note: message.slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

async function probeLinks(urls: string[]): Promise<{ url: string; fatal: boolean; note: string }[]> {
  const unique = [...new Set(urls)].slice(0, 40);
  const results: { url: string; fatal: boolean; note: string }[] = [];
  const CONCURRENCY = 6;
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const chunk = unique.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(chunk.map((url) => probeLink(url)));
    results.push(...settled);
  }
  return results;
}

export interface GateOptions {
  /** Skips the network probe. Used by the live editor panel, never by the send path. */
  skipLinkProbe?: boolean;
  /** Pre-computed recipient count, to avoid counting the segment twice. */
  recipientCount?: number;
}

export async function runPreSendGate(
  campaign: Pick<CampaignDoc, 'subject' | 'preheader' | 'bodySource' | 'trackOpens' | 'trackClicks' | 'segmentQuery'> & {
    _id?: ObjectId;
    listId: ObjectId;
  },
  list: ListDoc,
  options: GateOptions = {},
): Promise<GateResult> {
  const checks: GateCheck[] = [];

  // --- Subject line ---------------------------------------------------------
  checks.push({
    id: 'subject',
    label: 'Subject line is present',
    passed: campaign.subject.trim().length > 0,
    detail: campaign.subject.trim().length === 0 ? 'The subject line is empty.' : undefined,
  });

  // --- Body -----------------------------------------------------------------
  const bodyText = documentTextContent(campaign.bodySource);
  const hasImage = documentHasImage(campaign.bodySource);
  const bodyEmpty = bodyText.length === 0 && !hasImage;
  const imageOnly = bodyText.length === 0 && hasImage;
  checks.push({
    id: 'body',
    label: 'Body has text content and is not image-only',
    passed: !bodyEmpty && !imageOnly,
    detail: bodyEmpty
      ? 'The body is empty.'
      : imageOnly
        ? 'The body contains images but no text. Image-only bodies are a spam signal.'
        : undefined,
  });

  // --- Physical address -----------------------------------------------------
  checks.push({
    id: 'physical_address',
    label: 'Physical postal address is configured',
    passed: list.physicalAddress.trim().length > 0,
    detail: list.physicalAddress.trim().length === 0 ? `Set a physical address on the list "${list.name}".` : undefined,
  });

  // --- Merge fields ---------------------------------------------------------
  const allowed = new Set(availableMergeFields(list));
  const mergeFields = collectMergeFields(campaign);
  const missingFallback = mergeFields.filter((f) => !isSystemField(f.field) && f.fallback === null);
  const unknownFields = mergeFields.filter((f) => !isSystemField(f.field) && !allowed.has(f.field));

  checks.push({
    id: 'merge_fallbacks',
    label: 'Every merge field has a fallback',
    passed: missingFallback.length === 0,
    detail:
      missingFallback.length > 0
        ? `Missing a default: ${[...new Set(missingFallback.map((f) => `{{ ${f.field} }}`))].join(', ')}. Write {{ ${missingFallback[0]?.field} | default: "there" }}.`
        : undefined,
  });

  checks.push({
    id: 'merge_known',
    label: 'Every merge field exists on this list',
    passed: unknownFields.length === 0,
    detail:
      unknownFields.length > 0
        ? `Unknown field(s): ${[...new Set(unknownFields.map((f) => f.field))].join(', ')}. Available: ${[...allowed].join(', ')}.`
        : undefined,
  });

  // --- Render, then inspect the rendered output ------------------------------
  const rendered = renderCampaign(campaign, list, {
    trackOpens: campaign.trackOpens,
    trackClicks: campaign.trackClicks,
  });

  checks.push({
    id: 'unsubscribe_placeholder',
    label: 'Unsubscribe link is present in the rendered email',
    passed: rendered.html.includes('{{unsubscribe_url}}') && rendered.text.includes('{{unsubscribe_url}}'),
    detail: rendered.html.includes('{{unsubscribe_url}}')
      ? undefined
      : 'The rendered email has no unsubscribe link. This is legally required.',
  });

  checks.push({
    id: 'address_in_body',
    label: 'Physical address appears in the rendered email',
    passed:
      list.physicalAddress.trim().length > 0 &&
      rendered.text.includes(list.physicalAddress.trim().split('\n')[0] as string),
  });

  checks.push({
    id: 'links_absolute',
    label: 'All links are absolute',
    passed: rendered.invalidLinks.length === 0,
    detail:
      rendered.invalidLinks.length > 0
        ? `Relative or unsupported link target(s): ${rendered.invalidLinks.slice(0, 5).join(', ')}.`
        : undefined,
  });

  if (rendered.mjmlErrors.length > 0) {
    checks.push({
      id: 'render',
      label: 'Email renders cleanly',
      passed: false,
      detail: rendered.mjmlErrors.slice(0, 3).join(' | '),
    });
  }

  // --- Link reachability ----------------------------------------------------
  if (!options.skipLinkProbe && rendered.allLinks.length > 0) {
    const probes = await probeLinks(rendered.allLinks);
    const dead = probes.filter((p) => p.fatal);
    const suspect = probes.filter((p) => !p.fatal && !/HTTP 2\d\d|HTTP 3\d\d/.test(p.note));
    checks.push({
      id: 'links_resolve',
      label: 'All links resolve',
      passed: dead.length === 0,
      detail: dead.length > 0 ? dead.map((p) => `${p.url} → ${p.note}`).join(' | ') : undefined,
    });
    if (suspect.length > 0) {
      checks.push({
        id: 'links_suspect',
        label: 'Some links could not be verified',
        passed: true,
        warning: true,
        detail: suspect.map((p) => `${p.url} → ${p.note}`).join(' | '),
      });
    }
  }

  // --- SES identity ---------------------------------------------------------
  let identityVerified = false;
  try {
    identityVerified = await getMailer().isIdentityVerified(list.fromEmail);
  } catch {
    identityVerified = false;
  }
  checks.push({
    id: 'ses_identity',
    label: 'From-domain is verified in SES',
    passed: identityVerified,
    detail: identityVerified ? undefined : `SES does not report ${list.fromEmail} as verified for sending.`,
  });

  // --- Recipients -----------------------------------------------------------
  const recipientCount =
    options.recipientCount ?? (await countSegment(campaign.listId, campaign.segmentQuery));
  checks.push({
    id: 'recipients',
    label: 'Recipient count is greater than zero',
    passed: recipientCount > 0,
    detail: recipientCount > 0 ? `${recipientCount.toLocaleString()} recipients.` : 'This segment matches nobody.',
  });

  return {
    passed: checks.every((check) => check.passed || check.warning === true),
    checks,
    recipientCount,
  };
}
