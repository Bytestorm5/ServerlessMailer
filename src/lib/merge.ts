/**
 * Merge fields — `{{ first_name | default: "there" }}` (spec §6.4).
 *
 * Three separate consumers, one parser:
 *
 *  - the writing UI, which previews a body against real subscriber data (§6.3);
 *  - the pre-send gate, which hard-blocks a campaign whose body uses a
 *    subscriber attribute without a fallback (§6.6) — the check that stops
 *    "Hi ," from reaching 19,000 people;
 *  - the freeze step, which rewrites the body to bare SES placeholders and
 *    resolves per-recipient values for `SendBulkEmail` (§7.1, §7.4).
 *
 * The parser is deliberately hand-written rather than a single regular
 * expression. A fallback may legitimately contain `}}`, `{{`, or an escaped
 * quote, and the lazy `/\{\{(.*?)\}\}/` that everyone reaches for truncates all
 * three — silently, into an immutable frozen body.
 *
 * Two principles run through the whole module:
 *
 *  - **Parse liberally, flag strictly.** Anything mustache-shaped is recognised
 *    as a field even when its filter clause is garbled, so the §6.6 gate gets a
 *    chance to reject it. Text that is not recognised is left byte-for-byte
 *    intact rather than being guessed at.
 *  - **Never invent output.** A missing value falls back to the declared
 *    fallback; with no fallback the placeholder is left untouched. The strings
 *    `"undefined"` and `"null"` are never emitted — including when they arrive
 *    *as data*, which is what a botched CSV import produces.
 */

export interface MergeFieldDefinition {
  key: string;
  label: string;
  description: string;
  system: boolean;
}

export interface MergeFieldRef {
  /** The exact source slice, braces included: `text.slice(index, index + raw.length) === raw`. */
  raw: string;
  field: string;
  /** `null` when no `default:` clause was declared. `''` when one was, but empty. */
  fallback: string | null;
  index: number;
}

/**
 * System fields are resolved by the renderer for every recipient, so they never
 * need a fallback. Everything else is a subscriber attribute and does.
 */
const SYSTEM_FIELD_KEYS = [
  'unsubscribe_url',
  'preferences_url',
  'email',
  'physical_address',
  'list_name',
  'subject',
] as const;

const SYSTEM_FIELDS: ReadonlySet<string> = new Set<string>(SYSTEM_FIELD_KEYS);

export const AVAILABLE_MERGE_FIELDS: readonly MergeFieldDefinition[] = Object.freeze(
  (
    [
      {
        key: 'unsubscribe_url',
        label: 'Unsubscribe link',
        description: 'One-click unsubscribe URL, signed for this recipient and campaign.',
        system: true,
      },
      {
        key: 'preferences_url',
        label: 'Preferences link',
        description: 'Link to the preference centre for this recipient.',
        system: true,
      },
      {
        key: 'email',
        label: 'Email address',
        description: "The recipient's email address.",
        system: true,
      },
      {
        key: 'physical_address',
        label: 'Postal address',
        description: 'The sender postal address required in every campaign.',
        system: true,
      },
      {
        key: 'list_name',
        label: 'Newsletter name',
        description: 'The name of the newsletter this campaign is sent from.',
        system: true,
      },
      {
        key: 'subject',
        label: 'Subject line',
        description: "This campaign's subject line.",
        system: true,
      },
      {
        key: 'first_name',
        label: 'First name',
        description: 'Subscriber attribute. Needs a fallback, e.g. "there".',
        system: false,
      },
      {
        key: 'last_name',
        label: 'Last name',
        description: 'Subscriber attribute. Needs a fallback.',
        system: false,
      },
      {
        key: 'full_name',
        label: 'Full name',
        description: 'Subscriber attribute. Needs a fallback.',
        system: false,
      },
      {
        key: 'company',
        label: 'Company',
        description: 'Subscriber attribute. Needs a fallback.',
        system: false,
      },
      {
        key: 'city',
        label: 'City',
        description: 'Subscriber attribute. Needs a fallback.',
        system: false,
      },
      {
        key: 'country',
        label: 'Country',
        description: 'Subscriber attribute. Needs a fallback.',
        system: false,
      },
    ] as MergeFieldDefinition[]
  ).map((definition) => Object.freeze(definition)),
);

const KNOWN_FIELD_KEYS: ReadonlySet<string> = new Set(AVAILABLE_MERGE_FIELDS.map((f) => f.key));

/* ------------------------------------------------------------------ */
/* scanner                                                             */
/* ------------------------------------------------------------------ */

const OPEN = '{{';

/**
 * A merge expression longer than this is not a merge expression. The bound is
 * what keeps an unterminated quote in a 200KB body from turning the scan
 * quadratic — a body is operator-supplied, but an attacker-supplied import can
 * reach the same code path.
 */
const MAX_EXPRESSION_LENGTH = 2000;

/**
 * Field names are matched liberally: anything that is not whitespace, a brace,
 * a quote, a pipe or an angle bracket. `{{ first-name }}` is therefore parsed
 * and then reported by `findUnknownMergeFields`, rather than being skipped by
 * the parser and shipped verbatim to the list.
 */
const NAME_CHAR = /[^\s|{}"'<>]/;
const WHITESPACE = /\s/;

/** `&quot;` / `&apos;` / `&#34;` / `&#039;` — the form HTML escaping leaves behind. */
const DOUBLE_QUOTE_ENTITY = /^&(?:quot|#0*34);/;
const SINGLE_QUOTE_ENTITY = /^&(?:apos|#0*39);/;

function skipWhitespace(text: string, from: number, limit: number): number {
  let p = from;
  while (p < limit && WHITESPACE.test(text[p])) p += 1;
  return p;
}

function isCloseAt(text: string, p: number): boolean {
  return text[p] === '}' && text[p + 1] === '}';
}

function isOpenAt(text: string, p: number): boolean {
  return text[p] === '{' && text[p + 1] === '{';
}

interface Delimiter {
  /** Length of the opening delimiter in source characters. */
  openLength: number;
  /** Matches the closing delimiter at a given position; returns its length or 0. */
  closeLength: (text: string, p: number) => number;
}

/**
 * Recognises the opening delimiter of a fallback literal. Both raw quotes and
 * their HTML entities are accepted so that `toSesPlaceholders` still works on a
 * body that has already been through HTML escaping — otherwise
 * `default: &quot;there&quot;` would survive into the frozen template and be
 * mailed out as literal text.
 */
function openDelimiter(text: string, p: number): Delimiter | null {
  const char = text[p];
  if (char === '"' || char === "'") {
    return { openLength: 1, closeLength: (t, q) => (t[q] === char ? 1 : 0) };
  }
  if (char !== '&') return null;
  const rest = text.slice(p, p + 8);
  const doubleMatch = DOUBLE_QUOTE_ENTITY.exec(rest);
  if (doubleMatch) {
    return {
      openLength: doubleMatch[0].length,
      closeLength: (t, q) => {
        const m = DOUBLE_QUOTE_ENTITY.exec(t.slice(q, q + 8));
        return m ? m[0].length : 0;
      },
    };
  }
  const singleMatch = SINGLE_QUOTE_ENTITY.exec(rest);
  if (singleMatch) {
    return {
      openLength: singleMatch[0].length,
      closeLength: (t, q) => {
        const m = SINGLE_QUOTE_ENTITY.exec(t.slice(q, q + 8));
        return m ? m[0].length : 0;
      },
    };
  }
  return null;
}

function unescape(char: string): string {
  if (char === 'n') return '\n';
  if (char === 't') return '\t';
  if (char === 'r') return '\r';
  return char;
}

/**
 * Reads a quoted literal starting at `p`. Returns `null` when `p` is not a
 * quote or the literal is never closed — an unterminated quote must not eat the
 * rest of the document.
 */
function readQuoted(
  text: string,
  p: number,
  limit: number,
): { value: string; next: number } | null {
  const delimiter = openDelimiter(text, p);
  if (!delimiter) return null;

  let cursor = p + delimiter.openLength;
  let value = '';
  while (cursor < limit) {
    if (text[cursor] === '\\') {
      // A trailing backslash at the very end is not an escape of anything.
      if (cursor + 1 >= limit) return null;
      value += unescape(text[cursor + 1]);
      cursor += 2;
      continue;
    }
    const closing = delimiter.closeLength(text, cursor);
    if (closing > 0) return { value, next: cursor + closing };
    value += text[cursor];
    cursor += 1;
  }
  return null;
}

/**
 * Parses a well-formed `| default: "…"` clause. `from` points just after the
 * pipe. Returns `null` for anything malformed, which the caller downgrades to
 * "recognised field, no fallback" rather than to "not a field at all".
 */
function readDefaultClause(
  text: string,
  from: number,
  limit: number,
): { fallback: string; end: number } | null {
  let p = skipWhitespace(text, from, limit);

  const keywordStart = p;
  while (p < limit && /[A-Za-z_]/.test(text[p])) p += 1;
  if (text.slice(keywordStart, p).toLowerCase() !== 'default') return null;

  p = skipWhitespace(text, p, limit);
  if (text[p] !== ':') return null;
  p = skipWhitespace(text, p + 1, limit);

  const quoted = readQuoted(text, p, limit);
  if (!quoted) return null;

  p = skipWhitespace(text, quoted.next, limit);
  if (!isCloseAt(text, p)) return null;
  return { fallback: quoted.value, end: p + 2 };
}

/**
 * Finds the `}}` that closes a filter clause we could not understand, skipping
 * over quoted literals so a `}}` inside a fallback does not end it early.
 * Bails out on a nested `{{` so a malformed expression can never swallow the
 * field that follows it.
 */
function consumeToClose(text: string, from: number, limit: number): number | null {
  let p = from;
  while (p < limit) {
    if (isCloseAt(text, p)) return p + 2;
    if (isOpenAt(text, p)) return null;
    const quoted = readQuoted(text, p, limit);
    if (quoted) {
      p = quoted.next;
      continue;
    }
    if (text[p] === '"' || text[p] === "'") return null; // unterminated literal
    p += 1;
  }
  return null;
}

/** Attempts to read one merge expression whose `{{` sits at `start`. */
function parseAt(text: string, start: number): MergeFieldRef | null {
  const limit = Math.min(text.length, start + MAX_EXPRESSION_LENGTH);

  let p = skipWhitespace(text, start + 2, limit);

  const nameStart = p;
  while (p < limit && NAME_CHAR.test(text[p])) p += 1;
  if (p === nameStart) return null; // empty field name, or a nested `{{`
  const field = text.slice(nameStart, p);

  p = skipWhitespace(text, p, limit);

  if (isCloseAt(text, p)) {
    return { raw: text.slice(start, p + 2), field, fallback: null, index: start };
  }

  // Anything other than a filter clause here is prose that merely happens to
  // sit between braces: `{{ to open and }} to close`. Leave it alone.
  if (text[p] !== '|') return null;

  const clause = readDefaultClause(text, p + 1, limit);
  if (clause) {
    return {
      raw: text.slice(start, clause.end),
      field,
      fallback: clause.fallback,
      index: start,
    };
  }

  // Malformed filter (`| default there`, `| uppercase`, a stray second clause).
  // Fail closed: report it as a field with no fallback so the §6.6 gate blocks
  // the send, instead of mailing `| default there` to the list.
  const end = consumeToClose(text, p + 1, limit);
  if (end === null) return null;
  return { raw: text.slice(start, end), field, fallback: null, index: start };
}

export function parseMergeFields(text: string): MergeFieldRef[] {
  const refs: MergeFieldRef[] = [];
  if (typeof text !== 'string' || text.length === 0) return refs;

  let i = text.indexOf(OPEN);
  while (i !== -1) {
    const ref = parseAt(text, i);
    if (ref) {
      refs.push(ref);
      i = text.indexOf(OPEN, ref.index + ref.raw.length);
    } else {
      // Advance one character, not two: `{{{first_name}}}` hides a valid
      // expression starting at the second brace.
      i = text.indexOf(OPEN, i + 1);
    }
  }
  return refs;
}

/* ------------------------------------------------------------------ */
/* value resolution                                                    */
/* ------------------------------------------------------------------ */

/**
 * Own-property lookup only. `{{ toString }}` must never render
 * "function toString() { [native code] }", and `{{ __proto__ }}` must never
 * reach an object at all.
 */
function lookup(data: Record<string, string>, field: string): string | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  if (!Object.prototype.hasOwnProperty.call(data, field)) return undefined;
  const value = (data as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

/**
 * A value is unusable when it is absent, blank, or one of the two strings that
 * mean a `null`/`undefined` leaked through a JSON boundary somewhere upstream.
 * Rendering those is worse than rendering the fallback.
 */
function isUnusable(value: string | undefined): boolean {
  if (value === undefined) return true;
  const trimmed = value.trim();
  return trimmed === '' || trimmed === 'undefined' || trimmed === 'null';
}

/** The value for one occurrence, or `null` when there is neither value nor fallback. */
function valueFor(ref: MergeFieldRef, data: Record<string, string>): string | null {
  const value = lookup(data, ref.field);
  return isUnusable(value) ? ref.fallback : (value as string);
}

/** Rebuilds `text` with each ref replaced by `replacement(ref)`. */
function splice(
  text: string,
  refs: MergeFieldRef[],
  replacement: (ref: MergeFieldRef) => string,
): string {
  if (refs.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const ref of refs) {
    out += text.slice(cursor, ref.index);
    out += replacement(ref);
    cursor = ref.index + ref.raw.length;
  }
  return out + text.slice(cursor);
}

/**
 * Substitutes values into `text`. Nothing is HTML-escaped — the caller owns the
 * context — and substituted values are never re-scanned, so a subscriber
 * attribute containing `{{ email }}` stays literal instead of becoming a
 * template that reads other people's data.
 */
export function renderMergeFields(text: string, data: Record<string, string>): string {
  const refs = parseMergeFields(text);
  return splice(text, refs, (ref) => valueFor(ref, data) ?? ref.raw);
}

/**
 * Fields that need a fallback but do not have a usable one. Drives the §6.6
 * gate, which is a hard block with no override.
 *
 * A declared-but-blank fallback (`default: ""`) counts as missing: it renders
 * exactly the "Hi ," this check exists to prevent.
 */
export function findMergeFieldsWithoutFallback(text: string): MergeFieldRef[] {
  return parseMergeFields(text).filter(
    (ref) =>
      !SYSTEM_FIELDS.has(ref.field) && (ref.fallback === null),
  );
}

/** Fields that are neither system fields nor listed in `AVAILABLE_MERGE_FIELDS`. */
export function findUnknownMergeFields(text: string): MergeFieldRef[] {
  return parseMergeFields(text).filter((ref) => !KNOWN_FIELD_KEYS.has(ref.field));
}

/**
 * Converts `{{ x | default: "y" }}` to the bare `{{x}}` SES placeholder, so the
 * frozen body can be used as an inline SES template with per-recipient values
 * supplied by `resolveReplacements`. Text that is not a merge expression is
 * returned untouched.
 */
export function toSesPlaceholders(text: string): string {
  const refs = parseMergeFields(text);
  return splice(text, refs, (ref) => `{{${ref.field}}}`);
}

/**
 * One recipient's final values for every field in `templateText`, fallbacks
 * already applied — the `TemplateData` for `SendBulkEmail` (§7.4).
 *
 * When a field is used inconsistently (`{{ x }}` in one place and
 * `{{ x | default: "y" }}` in another) the first *declared* fallback wins:
 * SES resolves one value per field, and choosing the declared fallback keeps a
 * careless second reference from blanking the copy.
 *
 * System values present in `data` are carried through even when they do not
 * appear in `templateText`, because the unsubscribe link and postal address
 * live in the chrome the renderer adds around the body.
 */
export function resolveReplacements(
  templateText: string,
  data: Record<string, string>,
): Record<string, string> {
  const fallbacks = new Map<string, string | null>();

  for (const ref of parseMergeFields(templateText)) {
    const existing = fallbacks.get(ref.field);
    if (existing === undefined || (existing === null && ref.fallback !== null)) {
      fallbacks.set(ref.field, ref.fallback);
    }
  }

  for (const key of SYSTEM_FIELD_KEYS) {
    if (!fallbacks.has(key) && !isUnusable(lookup(data, key))) fallbacks.set(key, null);
  }

  const entries: [string, string][] = [];
  for (const [field, fallback] of fallbacks) {
    const value = lookup(data, field);
    // `?? ''` rather than the raw placeholder: a per-recipient replacement is
    // not a template, and `{{first_name}}` in a delivered email is worse than
    // a gap. The §6.6 gate is what stops this case from ever reaching a send.
    entries.push([field, isUnusable(value) ? (fallback ?? '') : (value as string)]);
  }

  // fromEntries defines own properties, so a field literally named `__proto__`
  // becomes data rather than a prototype assignment.
  return Object.fromEntries(entries);
}
