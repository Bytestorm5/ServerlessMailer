import { ObjectId, type UpdateFilter } from 'mongodb';
import {
  campaignsCollection,
  importAttestationsCollection,
  listsCollection,
  seedAddressesCollection,
  subscribersCollection,
} from '@/lib/db/collections';
import { isValidDomain, normalizeAndValidate, normalizeEmail } from '@/lib/email/normalize';
import { logger } from '@/lib/logging';
import { renderCampaignPreview, unsubscribeUrlFor } from '@/lib/render/campaign';
import { getSesAdapter } from '@/lib/ses/registry';
import { isSuppressed } from '@/lib/suppressions';
import { getTemplateHtml } from '@/lib/templates';
import type { CampaignDoc, EditorDoc, ListDoc, RecipientContext } from '@/lib/types';

/**
 * List configuration (§3.1).
 *
 * A list document is the sending identity for one newsletter: the verified SES
 * domain, the From/Reply-To pair, the physical address that every email is
 * legally required to carry, and the configuration set that routes bounce and
 * complaint events back to the webhook. Nothing else in the system can be
 * created until one exists, and every campaign inherits all of it.
 *
 * Two rules shape this module:
 *
 *  1. **Validate the whole document, never the patch.** An update merges onto
 *     the stored document and re-validates the result, so a field that is
 *     correct only in combination with another — `fromEmail` must sit inside
 *     `sendingDomain` — cannot be broken by editing one side of the pair.
 *  2. **Refuse to delete a list that anything references.** Subscribers carry
 *     consent evidence, campaigns carry send history, and the pipeline fails a
 *     batch outright when its list has vanished mid-send. Deactivation is the
 *     reversible operation and it is what an operator almost always wants;
 *     deletion is only for a list created by mistake.
 */

export class ListValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ListValidationError';
  }
}

export interface ListInput {
  name: string;
  sendingDomain: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  physicalAddress: string;
  sesConfigurationSet: string;
  active?: boolean;
  welcomeUrl?: string;
}

/** The stored shape, minus the fields the database owns. */
type ListFields = Omit<ListDoc, '_id' | 'createdAt'>;

const MAX_NAME_LENGTH = 120;
const MAX_ADDRESS_LENGTH = 500;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Trim, lowercase, and drop a trailing root-zone dot so `News.Example.com.` and
 * `news.example.com` are stored identically — SES identities are compared as
 * strings, and two spellings of one domain would silently fail verification.
 */
function normalizeDomain(value: unknown): string {
  return text(value).toLowerCase().replace(/\.$/, '');
}

/**
 * True when `email`'s domain is covered by the verified identity
 * `sendingDomain`. An SES domain identity covers its subdomains, so
 * `hello@mail.news.example.com` is legitimately sendable from an identity of
 * `news.example.com`.
 */
function coveredBySendingDomain(emailDomainPart: string, sendingDomain: string): boolean {
  return emailDomainPart === sendingDomain || emailDomainPart.endsWith(`.${sendingDomain}`);
}

/**
 * Validates and normalizes a complete list document.
 *
 * Every rule here maps to a failure that would otherwise surface later and
 * cost more: an unverified domain fails the pre-send gate, a From address
 * outside the verified identity is rejected by SES for every recipient at once,
 * and a missing physical address blocks the campaign at the same gate.
 */
export function validateListInput(input: ListInput): ListFields {
  const name = text(input.name);
  if (name === '') throw new ListValidationError('name is required');
  if (name.length > MAX_NAME_LENGTH) {
    throw new ListValidationError(`name must be ${MAX_NAME_LENGTH} characters or fewer`);
  }

  const sendingDomain = normalizeDomain(input.sendingDomain);
  if (sendingDomain === '') throw new ListValidationError('sendingDomain is required');
  if (!isValidDomain(sendingDomain)) {
    throw new ListValidationError(
      'sendingDomain must be a bare hostname such as news.example.com',
    );
  }

  const fromName = text(input.fromName);
  if (fromName === '') throw new ListValidationError('fromName is required');

  const from = normalizeAndValidate(text(input.fromEmail));
  if (!from.ok) throw new ListValidationError('fromEmail must be a valid email address');
  if (!coveredBySendingDomain(from.domain, sendingDomain)) {
    // SES rejects the whole send when the From address sits outside the
    // verified identity, so catching it here is the difference between a
    // config error and a campaign that fails for every recipient.
    throw new ListValidationError(
      `fromEmail must be at ${sendingDomain} or a subdomain of it, because that is the verified SES identity`,
    );
  }

  const replyTo = normalizeAndValidate(text(input.replyTo));
  // Reply-To is never sent *from*, so it needs no relationship to the identity.
  if (!replyTo.ok) throw new ListValidationError('replyTo must be a valid email address');

  const physicalAddress = text(input.physicalAddress);
  if (physicalAddress === '') {
    throw new ListValidationError('physicalAddress is required and appears in every email');
  }
  if (physicalAddress.length > MAX_ADDRESS_LENGTH) {
    throw new ListValidationError(
      `physicalAddress must be ${MAX_ADDRESS_LENGTH} characters or fewer`,
    );
  }

  const sesConfigurationSet = text(input.sesConfigurationSet);
  if (sesConfigurationSet === '') {
    throw new ListValidationError(
      'sesConfigurationSet is required; without it bounce and complaint events never reach the webhook',
    );
  }

  const welcomeUrl = text(input.welcomeUrl);
  if (welcomeUrl !== '' && !isHttpUrl(welcomeUrl)) {
    throw new ListValidationError('welcomeUrl must be an http(s) URL');
  }

  return {
    name,
    sendingDomain,
    fromName,
    fromEmail: from.email,
    replyTo: replyTo.email,
    physicalAddress,
    sesConfigurationSet,
    active: input.active !== false,
    ...(welcomeUrl === '' ? {} : { welcomeUrl }),
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function listLists(): Promise<ListDoc[]> {
  return (await listsCollection()).find({}).sort({ name: 1 }).toArray();
}

export interface ListSummary {
  list: ListDoc;
  confirmed: number;
  pending: number;
  unsubscribed: number;
  campaigns: number;
}

/**
 * Lists plus the counts that decide whether one can be deleted. The admin view
 * shows the same numbers the delete guard enforces, so a refusal is never a
 * surprise.
 */
export async function listSummaries(): Promise<ListSummary[]> {
  const lists = await listLists();
  const [subscribers, campaigns] = await Promise.all([
    subscribersCollection(),
    campaignsCollection(),
  ]);

  return Promise.all(
    lists.map(async (list) => {
      const [confirmed, pending, unsubscribed, campaignCount] = await Promise.all([
        subscribers.countDocuments({ listId: list._id, status: 'confirmed' }),
        subscribers.countDocuments({ listId: list._id, status: 'pending' }),
        subscribers.countDocuments({ listId: list._id, status: 'unsubscribed' }),
        campaigns.countDocuments({ listId: list._id }),
      ]);
      return { list, confirmed, pending, unsubscribed, campaigns: campaignCount };
    }),
  );
}

/** The wire shape used by every admin route and the admin UI. */
export function serializeList(list: ListDoc): Record<string, unknown> {
  return {
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
    createdAt: list.createdAt,
  };
}

export async function getList(id: ObjectId): Promise<ListDoc | null> {
  return (await listsCollection()).findOne({ _id: id });
}

export async function createList(input: ListInput, now: Date = new Date()): Promise<ListDoc> {
  const fields = validateListInput(input);
  const doc: ListDoc = { _id: new ObjectId(), ...fields, createdAt: now };
  await (await listsCollection()).insertOne(doc);
  logger.info('list created', { listId: doc._id.toHexString(), sendingDomain: doc.sendingDomain });
  return doc;
}

/**
 * Applies a partial patch and re-validates the merged document. Returns `null`
 * when the list does not exist; throws `ListValidationError` when the result
 * would not be a valid list.
 */
export async function updateList(
  id: ObjectId,
  patch: Partial<ListInput>,
): Promise<ListDoc | null> {
  const collection = await listsCollection();
  const existing = await collection.findOne({ _id: id });
  if (!existing) return null;

  const merged: ListInput = {
    name: patch.name ?? existing.name,
    sendingDomain: patch.sendingDomain ?? existing.sendingDomain,
    fromName: patch.fromName ?? existing.fromName,
    fromEmail: patch.fromEmail ?? existing.fromEmail,
    replyTo: patch.replyTo ?? existing.replyTo,
    physicalAddress: patch.physicalAddress ?? existing.physicalAddress,
    sesConfigurationSet: patch.sesConfigurationSet ?? existing.sesConfigurationSet,
    active: patch.active ?? existing.active,
    welcomeUrl: patch.welcomeUrl ?? existing.welcomeUrl,
  };

  const fields = validateListInput(merged);
  // `welcomeUrl` is absent from `fields` when it was cleared, so it is unset
  // rather than left behind as a stale redirect target.
  const update: UpdateFilter<ListDoc> = { $set: fields };
  if (!('welcomeUrl' in fields)) update.$unset = { welcomeUrl: '' };

  const updated = await collection.findOneAndUpdate({ _id: id }, update, {
    returnDocument: 'after',
  });

  if (updated) {
    logger.info('list updated', { listId: id.toHexString(), active: updated.active });
  }
  return updated;
}

export type DeleteListResult =
  | { deleted: true }
  | { deleted: false; reason: 'not_found' }
  | {
      deleted: false;
      reason: 'in_use';
      subscribers: number;
      campaigns: number;
      message: string;
    };

/**
 * Deletes a list, but only one nothing references.
 *
 * Subscribers hold the consent evidence that answers a complaint, campaigns
 * hold the send history behind the reputation numbers, and `processBatch` fails
 * a batch outright when its list has disappeared underneath it. None of that is
 * recoverable by re-creating a list with the same name, because every reference
 * is by `_id`. So a populated list is never deleted — it is deactivated, which
 * closes signups and hides it from the campaign picker while leaving the
 * history intact.
 *
 * Seed addresses and import attestations are removed alongside the list. Both
 * are scoped to it by `listId` and neither means anything once it is gone.
 */
export async function deleteList(id: ObjectId): Promise<DeleteListResult> {
  const collection = await listsCollection();
  const existing = await collection.findOne({ _id: id });
  if (!existing) return { deleted: false, reason: 'not_found' };

  const [subscribers, campaigns] = await Promise.all([
    (await subscribersCollection()).countDocuments({ listId: id }),
    (await campaignsCollection()).countDocuments({ listId: id }),
  ]);

  if (subscribers > 0 || campaigns > 0) {
    return {
      deleted: false,
      reason: 'in_use',
      subscribers,
      campaigns,
      message:
        `"${existing.name}" still has ${subscribers.toLocaleString('en-GB')} subscriber(s) and ` +
        `${campaigns.toLocaleString('en-GB')} campaign(s). Deleting it would orphan their consent ` +
        'evidence and send history. Deactivate the list instead — that stops new signups and ' +
        'removes it from the campaign picker.',
    };
  }

  await Promise.all([
    (await seedAddressesCollection()).deleteMany({ listId: id }),
    (await importAttestationsCollection()).deleteMany({ listId: id }),
  ]);
  await collection.deleteOne({ _id: id });

  logger.warn('list deleted', {
    listId: id.toHexString(),
    sendingDomain: existing.sendingDomain,
  });
  return { deleted: true };
}

/* ------------------------------------------------------------ test sends */

/** Matches the campaign test-send cap (§6.5). */
const MAX_TEST_RECIPIENTS = 10;

/**
 * The body of a list test send.
 *
 * It carries a merge field with a fallback, the unsubscribe URL and the postal
 * address, because those are the three parts of the footer machinery an
 * operator most needs to see working before a campaign exists. Rendering it
 * through the normal path means a test that passes here is evidence about the
 * real path, not about a second one written for tests.
 */
function verificationBody(list: ListDoc): EditorDoc {
  return {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: `Sending identity check — ${list.name}` }],
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text:
              'Hello {{ first_name | default: "there" }}. If this arrived, this list can send: ' +
              `the From address is ${list.fromName} <${list.fromEmail}>, replies go to ` +
              `${list.replyTo}, and the message was sent from ${list.sendingDomain} through the ` +
              `"${list.sesConfigurationSet}" configuration set.`,
          },
        ],
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text:
              'Check the message passed DKIM and DMARC in your client, and confirm a delivery ' +
              'event reached the webhook. Arrival alone does not prove the return path works.',
          },
        ],
      },
      { type: 'paragraph', content: [{ type: 'text', text: '{{ unsubscribe_url }}' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '{{ physical_address }}' }] },
    ],
  };
}

/**
 * A campaign-shaped value that is rendered and then thrown away. It is never
 * inserted, so nothing claims it, reconciles it or counts it.
 */
function syntheticCampaign(list: ListDoc, now: Date): CampaignDoc {
  return {
    _id: new ObjectId(),
    listId: list._id,
    subject: `Sending identity check — ${list.name}`,
    preheader: 'Verifying the sending identity for this list.',
    bodySource: verificationBody(list),
    status: 'draft',
    segmentQuery: {},
    trackOpens: false,
    trackClicks: false,
    counts: {
      recipients: 0,
      sent: 0,
      failed: 0,
      bounced: 0,
      complained: 0,
      unsubscribed: 0,
      delivered: 0,
      opened: 0,
      clicked: 0,
    },
    createdAt: now,
    updatedAt: now,
  };
}

export type ListTestSendResult =
  | { ok: true; sent: number }
  | { ok: false; reason: string };

/**
 * Sends a test email from a list to an arbitrary address, with no campaign
 * involved (§6.5).
 *
 * This is the check that belongs *before* the first campaign exists: it proves
 * the whole sending identity — verified domain, From and Reply-To, physical
 * address, configuration set — end to end, which is exactly the set of things a
 * hand-written list document gets wrong. It renders through
 * `renderCampaignPreview`, so it exercises the real merge and footer path.
 *
 * Three things it deliberately does not do: it never writes to `sent_log`,
 * campaign counts or batches; it signs the unsubscribe link with a synthetic
 * subscriber id, so clicking it in a test cannot unsubscribe a real person; and
 * it refuses a suppressed address. The suppression list is checked on every send
 * path with no bypass (§1.2), and a test send to an address that already hard
 * bounced is a real send to SES with real reputation cost.
 *
 * An inactive list can still be tested — staging a list and verifying it before
 * opening signups is the reason `active` exists.
 */
export async function sendListTestEmail(input: {
  listId: ObjectId;
  to: string[];
  now?: Date;
}): Promise<ListTestSendResult> {
  const now = input.now ?? new Date();

  if (input.to.length === 0) return { ok: false, reason: 'no_recipients' };
  if (input.to.length > MAX_TEST_RECIPIENTS) return { ok: false, reason: 'too_many_recipients' };

  const addresses: string[] = [];
  for (const raw of input.to) {
    const check = normalizeAndValidate(raw);
    // Refuse the whole request rather than silently sending to the subset that
    // parsed: a half-sent test is read as a passing test.
    if (!check.ok) return { ok: false, reason: `invalid_address:${check.reason}` };
    addresses.push(check.email);
  }

  const list = await getList(input.listId);
  if (!list) return { ok: false, reason: 'list_not_found' };

  for (const address of addresses) {
    if (await isSuppressed(address)) return { ok: false, reason: 'suppressed_address' };
  }

  const campaign = syntheticCampaign(list, now);
  // A synthetic subscriber id keeps the token well-formed while pointing at
  // nobody, so the unsubscribe link in a test is inert.
  const { url } = unsubscribeUrlFor(campaign._id.toHexString(), new ObjectId().toHexString());

  const ses = await getSesAdapter();
  // Rendered through the list's own template, so what lands in the inbox is
  // what a campaign would look like rather than a generic stand-in.
  const templateHtml = await getTemplateHtml(list._id, 'campaign');
  let sent = 0;

  for (const address of addresses) {
    const ctx: RecipientContext = {
      subscriberId: new ObjectId().toHexString(),
      email: address,
      attributes: {},
      unsubscribeUrl: url,
    };

    try {
      const rendered = await renderCampaignPreview(campaign, list, ctx, templateHtml);
      await ses.sendSimple({
        fromName: list.fromName,
        fromEmail: list.fromEmail,
        replyTo: list.replyTo,
        to: address,
        configurationSet: list.sesConfigurationSet,
        content: { ...rendered, subject: `[TEST] ${rendered.subject}` },
        headers: {
          'X-SM-Test-Send': 'true',
          'List-Unsubscribe': `<${url}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });
      sent += 1;
    } catch (err) {
      // The address is not logged: `logger` redacts it, and the operator sees
      // the count in the response either way.
      logger.error('list test send failed', {
        listId: list._id.toHexString(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (sent === 0) return { ok: false, reason: 'send_failed' };
  return { ok: true, sent };
}
