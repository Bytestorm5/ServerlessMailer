import type { SubscriberDoc } from '@/lib/types';

/**
 * First-party subscriber names (spec §3.2).
 *
 * `firstName`/`lastName` live as top-level fields on the subscriber document.
 * They still surface to campaigns through the same `first_name` / `last_name`
 * merge fields as before, so nothing about authoring changes — only where the
 * values are stored.
 *
 * Two invariants keep the old and new worlds consistent:
 *
 *  - **Write paths route, read paths layer.** Anything arriving under the
 *    `first_name`/`last_name` attribute keys is routed into the first-party
 *    fields before it is stored, so no new document ever grows a name inside
 *    `attributes`. Reading layers the first-party fields *over* `attributes`,
 *    so documents written before these fields existed keep rendering.
 *  - **First-party wins.** When both a first-party field and a legacy
 *    attribute are present, the first-party field is the value that renders,
 *    that segments match on, and that export emits.
 */

/** Merge-field key -> first-party document field. */
export const NAME_ATTRIBUTE_KEYS = {
  first_name: 'firstName',
  last_name: 'lastName',
} as const;

const MAX_NAME_LENGTH = 256;

/** Trimmed and bounded, or `undefined` when there is nothing usable. */
export function cleanName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return trimmed.slice(0, MAX_NAME_LENGTH);
}

export interface SplitNameAttributes {
  firstName?: string;
  lastName?: string;
  /** The input attributes minus the two name keys. */
  attributes: Record<string, string>;
}

/**
 * Pulls `first_name`/`last_name` out of an incoming attribute map so write
 * paths store them first-party. Explicit `firstName`/`lastName` inputs, when
 * given, win over values smuggled in through the attribute keys.
 */
export function splitNameAttributes(
  raw: Record<string, string> | undefined,
  explicit?: { firstName?: unknown; lastName?: unknown },
): SplitNameAttributes {
  const attributes: Record<string, string> = {};
  let firstName = cleanName(explicit?.firstName);
  let lastName = cleanName(explicit?.lastName);

  for (const [key, value] of Object.entries(raw ?? {})) {
    if (key === 'first_name') {
      firstName = firstName ?? cleanName(value);
      continue;
    }
    if (key === 'last_name') {
      lastName = lastName ?? cleanName(value);
      continue;
    }
    attributes[key] = value;
  }

  return {
    ...(firstName !== undefined ? { firstName } : {}),
    ...(lastName !== undefined ? { lastName } : {}),
    attributes,
  };
}

/** Blank and the JSON-boundary leak strings are as good as absent (cf. merge.ts). */
function usable(value: string | undefined): value is string {
  if (value === undefined) return false;
  const trimmed = value.trim();
  return trimmed !== '' && trimmed !== 'undefined' && trimmed !== 'null';
}

/**
 * The merge data a subscriber contributes to rendering: `attributes` with the
 * first-party name fields layered on top, plus a derived `full_name` when the
 * subscriber has not set one explicitly.
 */
export function subscriberMergeData(
  subscriber: Pick<SubscriberDoc, 'attributes'> &
    Partial<Pick<SubscriberDoc, 'firstName' | 'lastName'>>,
): Record<string, string> {
  const data: Record<string, string> = { ...(subscriber.attributes ?? {}) };
  if (usable(subscriber.firstName)) data.first_name = subscriber.firstName.trim();
  if (usable(subscriber.lastName)) data.last_name = subscriber.lastName.trim();

  if (!usable(data.full_name)) {
    const parts = [data.first_name, data.last_name].filter(usable);
    if (parts.length > 0) data.full_name = parts.map((part) => part.trim()).join(' ');
  }

  return data;
}

/** "First Last" for admin display, or `undefined` when neither is set. */
export function displayName(
  subscriber: Partial<Pick<SubscriberDoc, 'firstName' | 'lastName'>>,
): string | undefined {
  const parts = [subscriber.firstName, subscriber.lastName].filter(usable);
  return parts.length > 0 ? parts.map((part) => part.trim()).join(' ') : undefined;
}
