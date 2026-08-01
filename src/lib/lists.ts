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
import type { ListDoc } from '@/lib/types';

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
