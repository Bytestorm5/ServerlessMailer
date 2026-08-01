import { describe, expect, it } from 'vitest';

import {
  AVAILABLE_MERGE_FIELDS,
  findMergeFieldsWithoutFallback,
  findUnknownMergeFields,
  parseMergeFields,
  renderMergeFields,
  resolveReplacements,
  toSesPlaceholders,
  type MergeFieldRef,
} from '@/lib/merge';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** The six always-resolvable system fields (spec §6.4, CONTRACTS §5). */
const SYSTEM_FIELDS = [
  'unsubscribe_url',
  'preferences_url',
  'email',
  'physical_address',
  'list_name',
  'subject',
] as const;

const fields = (text: string): string[] => parseMergeFields(text).map((r) => r.field);
const fallbacks = (text: string): (string | null)[] =>
  parseMergeFields(text).map((r) => r.fallback);

/** Every ref must point at itself: `raw` is the exact slice at `index`. */
function expectRefsAnchored(text: string, refs: MergeFieldRef[]): void {
  for (const ref of refs) {
    expect(text.slice(ref.index, ref.index + ref.raw.length)).toBe(ref.raw);
  }
}

/* ------------------------------------------------------------------ */
/* AVAILABLE_MERGE_FIELDS                                              */
/* ------------------------------------------------------------------ */

describe('AVAILABLE_MERGE_FIELDS', () => {
  it('declares every system field as system: true', () => {
    for (const key of SYSTEM_FIELDS) {
      const def = AVAILABLE_MERGE_FIELDS.find((f) => f.key === key);
      expect(def, `missing system field ${key}`).toBeDefined();
      expect(def!.system).toBe(true);
    }
  });

  it('declares at least one subscriber attribute field, and marks it non-system', () => {
    const attributes = AVAILABLE_MERGE_FIELDS.filter((f) => !f.system);
    expect(attributes.length).toBeGreaterThan(0);
    expect(attributes.map((f) => f.key)).toContain('first_name');
  });

  it('has unique keys and human-readable metadata for the editor UI', () => {
    // §6.4: available fields are listed in the editor UI; no free-typing.
    const keys = AVAILABLE_MERGE_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const def of AVAILABLE_MERGE_FIELDS) {
      expect(def.key).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
    }
  });

  it('is frozen so a caller cannot mutate the catalogue at runtime', () => {
    expect(Object.isFrozen(AVAILABLE_MERGE_FIELDS)).toBe(true);
    for (const def of AVAILABLE_MERGE_FIELDS) expect(Object.isFrozen(def)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* parseMergeFields — the happy paths                                  */
/* ------------------------------------------------------------------ */

describe('parseMergeFields', () => {
  it('parses the canonical form from the spec', () => {
    const text = 'Hi {{ first_name | default: "there" }}, welcome.';
    const refs = parseMergeFields(text);

    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({
      raw: '{{ first_name | default: "there" }}',
      field: 'first_name',
      fallback: 'there',
      index: 3,
    });
    expectRefsAnchored(text, refs);
  });

  it('parses a field with no fallback as fallback: null', () => {
    const refs = parseMergeFields('Hello {{email}}');
    expect(refs).toHaveLength(1);
    expect(refs[0].field).toBe('email');
    expect(refs[0].fallback).toBeNull();
    expect(refs[0].raw).toBe('{{email}}');
    expect(refs[0].index).toBe(6);
  });

  it('tolerates arbitrary whitespace, including newlines and tabs', () => {
    const variants = [
      '{{first_name|default:"there"}}',
      '{{  first_name  |  default:  "there"  }}',
      '{{\tfirst_name\t|\tdefault:\t"there"\t}}',
      '{{\n  first_name\n  |\n  default:\n    "there"\n}}',
      '{{ first_name|default: "there" }}',
    ];
    for (const text of variants) {
      const refs = parseMergeFields(text);
      expect(refs, text).toHaveLength(1);
      expect(refs[0].field, text).toBe('first_name');
      expect(refs[0].fallback, text).toBe('there');
      expect(refs[0].raw, text).toBe(text);
    }
  });

  it('accepts both single and double quoted fallbacks', () => {
    expect(fallbacks(`{{ first_name | default: 'there' }}`)).toEqual(['there']);
    expect(fallbacks(`{{ first_name | default: "there" }}`)).toEqual(['there']);
  });

  it('lets a single-quoted fallback contain an unescaped double quote and vice versa', () => {
    expect(fallbacks(`{{ first_name | default: 'say "hi"' }}`)).toEqual(['say "hi"']);
    expect(fallbacks(`{{ first_name | default: "it's here" }}`)).toEqual([`it's here`]);
  });

  it('unescapes escaped quotes inside a fallback', () => {
    expect(fallbacks('{{ first_name | default: "she said \\"hi\\"" }}')).toEqual([
      'she said "hi"',
    ]);
    expect(fallbacks(`{{ first_name | default: 'it\\'s fine' }}`)).toEqual([`it's fine`]);
  });

  it('unescapes an escaped backslash without swallowing the closing quote', () => {
    const refs = parseMergeFields('{{ first_name | default: "back\\\\slash" }}');
    expect(refs).toHaveLength(1);
    expect(refs[0].fallback).toBe('back\\slash');
  });

  it('treats a lone backslash before an ordinary character literally', () => {
    expect(fallbacks('{{ first_name | default: "a\\nb" }}')).toEqual(['a\nb']);
    expect(fallbacks('{{ first_name | default: "a\\qb" }}')).toEqual(['aqb']);
  });

  it('unescapes the remaining whitespace escapes', () => {
    expect(fallbacks('{{ first_name | default: "a\\tb" }}')).toEqual(['a\tb']);
    expect(fallbacks('{{ first_name | default: "a\\rb" }}')).toEqual(['a\rb']);
  });

  it('allows braces inside a quoted fallback without ending the expression early', () => {
    // A naive /\{\{(.*?)\}\}/ regex gets this wrong and truncates the fallback.
    const refs = parseMergeFields('{{ first_name | default: "closes }} here" }} tail');
    expect(refs).toHaveLength(1);
    expect(refs[0].fallback).toBe('closes }} here');
    expect(refs[0].raw).toBe('{{ first_name | default: "closes }} here" }}');
    expect(refs[0].field).toBe('first_name');
  });

  it('allows an opening mustache inside a quoted fallback', () => {
    const refs = parseMergeFields('{{ first_name | default: "literally {{ x }}" }}');
    expect(refs).toHaveLength(1);
    expect(refs[0].fallback).toBe('literally {{ x }}');
  });

  it('keeps an explicitly empty fallback distinct from a missing one', () => {
    expect(parseMergeFields('{{ first_name | default: "" }}')[0].fallback).toBe('');
    expect(parseMergeFields('{{ first_name }}')[0].fallback).toBeNull();
  });

  it('accepts the default keyword in any case', () => {
    expect(fallbacks('{{ first_name | DEFAULT: "there" }}')).toEqual(['there']);
    expect(fallbacks('{{ first_name | Default: "there" }}')).toEqual(['there']);
  });

  it('treats field names as case sensitive, matching the attribute keys', () => {
    expect(fields('{{ First_Name | default: "a" }}')).toEqual(['First_Name']);
  });

  it('reports every occurrence in source order with correct indexes', () => {
    const text = 'A {{ first_name | default: "x" }} B {{ email }} C {{ first_name }}';
    const refs = parseMergeFields(text);

    expect(refs.map((r) => r.field)).toEqual(['first_name', 'email', 'first_name']);
    expect(refs.map((r) => r.index)).toEqual([
      text.indexOf('{{ first_name | default'),
      text.indexOf('{{ email }}'),
      text.lastIndexOf('{{ first_name }}'),
    ]);
    expect(refs.map((r) => r.index)).toEqual([...refs.map((r) => r.index)].sort((a, b) => a - b));
    expectRefsAnchored(text, refs);
  });

  it('parses adjacent fields with no separator between them', () => {
    const text = '{{first_name|default:"a"}}{{last_name|default:"b"}}{{email}}';
    const refs = parseMergeFields(text);

    expect(refs.map((r) => r.field)).toEqual(['first_name', 'last_name', 'email']);
    expect(refs.map((r) => r.fallback)).toEqual(['a', 'b', null]);
    expectRefsAnchored(text, refs);
  });

  it('returns an empty array for text with no merge fields', () => {
    expect(parseMergeFields('')).toEqual([]);
    expect(parseMergeFields('Plain prose with no fields at all.')).toEqual([]);
  });

  it('parses fields embedded in rendered HTML', () => {
    const html = '<p>Hi {{ first_name | default: "there" }}</p><a href="{{unsubscribe_url}}">x</a>';
    expect(fields(html)).toEqual(['first_name', 'unsubscribe_url']);
  });

  it('parses HTML-escaped quotes, so an escaped body still yields its fallback', () => {
    // MJML/HTML escaping turns `"there"` into `&quot;there&quot;`. If the parser
    // missed that, `default: &quot;...` would ship inside the email body.
    const refs = parseMergeFields('{{ first_name | default: &quot;there&quot; }}');
    expect(refs).toHaveLength(1);
    expect(refs[0].fallback).toBe('there');

    expect(fallbacks('{{ first_name | default: &#39;there&#39; }}')).toEqual(['there']);
    expect(fallbacks('{{ first_name | default: &#039;there&#039; }}')).toEqual(['there']);
    expect(fallbacks('{{ first_name | default: &apos;there&apos; }}')).toEqual(['there']);
  });
});

/* ------------------------------------------------------------------ */
/* parseMergeFields — malformed and adversarial input                  */
/* ------------------------------------------------------------------ */

describe('parseMergeFields (malformed input)', () => {
  it('ignores unclosed braces', () => {
    expect(parseMergeFields('Hi {{ first_name')).toEqual([]);
    expect(parseMergeFields('Hi {{ first_name | default: "there"')).toEqual([]);
    expect(parseMergeFields('Hi {{ first_name }')).toEqual([]);
    expect(parseMergeFields('Hi {{ first_name | default: "there" }')).toEqual([]);
  });

  it('ignores a stray closing mustache', () => {
    expect(parseMergeFields('first_name }} trailing')).toEqual([]);
  });

  it('ignores an unterminated quoted fallback rather than swallowing the rest of the body', () => {
    expect(parseMergeFields('{{ first_name | default: "there }} and the rest')).toEqual([]);
    expect(parseMergeFields(`{{ first_name | default: 'there }}`)).toEqual([]);
  });

  it('ignores a fallback that ends on a dangling backslash', () => {
    // The backslash escapes the end of the input, so the literal never closes.
    // It must not be read as an escape of a character that does not exist.
    expect(parseMergeFields('{{ first_name | default: "abc\\')).toEqual([]);
    expect(parseMergeFields(`{{ first_name | default: 'abc\\`)).toEqual([]);
  });

  it('does not mistake a non-quote HTML entity for the start of a fallback', () => {
    // `&amp;` is not `&quot;`/`&apos;`. The clause is therefore malformed, so the
    // field is still reported — with no fallback — for the §6.6 gate to reject.
    const text = '{{ first_name | default: &amp;there }}';
    const refs = parseMergeFields(text);

    expect(refs).toHaveLength(1);
    expect(refs[0].field).toBe('first_name');
    expect(refs[0].fallback).toBeNull();
    expect(refs[0].raw).toBe(text);
    expect(findMergeFieldsWithoutFallback(text)).toHaveLength(1);
    expect(toSesPlaceholders(text)).toBe('{{first_name}}');
  });

  it('ignores a literal "{{" used in prose', () => {
    expect(parseMergeFields('Type {{ to open a merge field.')).toEqual([]);
    expect(parseMergeFields('Type {{ to open and }} to close.')).toEqual([]);
    expect(parseMergeFields('The {{ }} syntax is how merge fields work.')).toEqual([]);
  });

  it('ignores an empty field name', () => {
    expect(parseMergeFields('{{}}')).toEqual([]);
    expect(parseMergeFields('{{ }}')).toEqual([]);
    expect(parseMergeFields('{{   \n  }}')).toEqual([]);
    expect(parseMergeFields('{{ | default: "there" }}')).toEqual([]);
    expect(parseMergeFields('{{|default:"there"}}')).toEqual([]);
  });

  it('parses the inner field of a nested mustache and leaves the outer braces alone', () => {
    const text = '{{ {{ first_name | default: "a" }} }}';
    const refs = parseMergeFields(text);

    expect(refs).toHaveLength(1);
    expect(refs[0].field).toBe('first_name');
    expect(refs[0].raw).toBe('{{ first_name | default: "a" }}');
    expect(refs[0].index).toBe(3);
    expectRefsAnchored(text, refs);
  });

  it('handles triple braces by matching the inner pair', () => {
    const refs = parseMergeFields('{{{first_name}}}');
    expect(refs).toHaveLength(1);
    expect(refs[0].field).toBe('first_name');
  });

  it('does not treat multi-word prose inside braces as a field', () => {
    expect(parseMergeFields('{{ first name }}')).toEqual([]);
    expect(parseMergeFields('{{ first_name is here }}')).toEqual([]);
  });

  it('still recognises a field when the pipe clause is malformed, with no fallback', () => {
    // Fail closed: a garbled filter must not hide the field from the §6.6 gate,
    // and must not leak `| default there` into 19,000 inboxes.
    for (const text of [
      '{{ first_name | default there }}',
      '{{ first_name | default "there" }}',
      '{{ first_name | default: there }}',
      '{{ first_name | uppercase }}',
      '{{ first_name | }}',
      '{{ first_name | default: "a" | default: "b" }}',
      '{{ first_name | default: "a" extra }}',
    ]) {
      const refs = parseMergeFields(text);
      expect(refs, text).toHaveLength(1);
      expect(refs[0].field, text).toBe('first_name');
      expect(refs[0].fallback, text).toBeNull();
      expect(refs[0].raw, text).toBe(text);
    }
  });

  it('does not let a malformed clause swallow the field that follows it', () => {
    const text = '{{ first_name | oops {{ last_name | default: "b" }}';
    const refs = parseMergeFields(text);

    expect(refs).toHaveLength(1);
    expect(refs[0].field).toBe('last_name');
    expect(refs[0].fallback).toBe('b');
  });

  it('accepts unusual field-name characters so they can be flagged, not shipped', () => {
    expect(fields('{{ first-name | default: "a" }}')).toEqual(['first-name']);
    expect(fields('{{ user.first_name | default: "a" }}')).toEqual(['user.first_name']);
    expect(fields('{{ prénom | default: "a" }}')).toEqual(['prénom']);
    expect(fields('{{ 123 | default: "a" }}')).toEqual(['123']);
  });

  it('refuses an absurdly long expression instead of scanning the whole document', () => {
    const huge = `{{ first_name | default: "${'a'.repeat(5000)}" }}`;
    expect(parseMergeFields(huge)).toEqual([]);
  });

  it('stays linear on pathological input', () => {
    const started = Date.now();
    expect(parseMergeFields('{{'.repeat(50_000))).toEqual([]);
    expect(parseMergeFields('{{x|default:"'.repeat(20_000))).toEqual([]);
    expect(parseMergeFields(`${'{{ a | '.repeat(20_000)}}}`).length).toBeLessThanOrEqual(20_000);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('never returns a ref whose raw slice disagrees with its index', () => {
    const text = [
      'Hi {{ first_name | default: "there" }},',
      '{{ }} {{ nope',
      '{{ {{ email }} }}',
      '{{a|default:"1"}}{{b|default:"2"}}',
      '{{ x | default: "brace }} inside" }}',
    ].join('\n');
    expectRefsAnchored(text, parseMergeFields(text));
  });
});

/* ------------------------------------------------------------------ */
/* renderMergeFields                                                   */
/* ------------------------------------------------------------------ */

describe('renderMergeFields', () => {
  it('substitutes a present value', () => {
    expect(
      renderMergeFields('Hi {{ first_name | default: "there" }}!', { first_name: 'Ada' }),
    ).toBe('Hi Ada!');
  });

  it('applies the fallback when the value is missing, empty or whitespace only', () => {
    const text = 'Hi {{ first_name | default: "there" }}!';
    expect(renderMergeFields(text, {})).toBe('Hi there!');
    expect(renderMergeFields(text, { first_name: '' })).toBe('Hi there!');
    expect(renderMergeFields(text, { first_name: '   ' })).toBe('Hi there!');
    expect(renderMergeFields(text, { first_name: '\n\t ' })).toBe('Hi there!');
  });

  it('never renders "Hi ," for a field that declares a fallback', () => {
    // The whole point of §6.4 / §6.6.
    expect(renderMergeFields('Hi {{ first_name | default: "there" }},', {})).not.toContain('Hi ,');
  });

  it('never emits the strings "undefined" or "null"', () => {
    const text = 'Hi {{ first_name | default: "there" }}!';
    expect(renderMergeFields(text, { first_name: 'undefined' })).toBe('Hi there!');
    expect(renderMergeFields(text, { first_name: 'null' })).toBe('Hi there!');
    expect(renderMergeFields(text, { first_name: ' null ' })).toBe('Hi there!');
    // A value that merely *contains* those words is a real value.
    expect(renderMergeFields(text, { first_name: 'Nullah' })).toBe('Hi Nullah!');
  });

  it('survives a data map whose values are not strings at runtime', () => {
    // Data crosses a JSON boundary; strict types do not survive the wire.
    const dirty = { first_name: undefined, last_name: null, email: 42 } as unknown as Record<
      string,
      string
    >;
    const out = renderMergeFields(
      '{{ first_name | default: "there" }}/{{ last_name | default: "friend" }}/{{ email }}',
      dirty,
    );
    expect(out).toBe('there/friend/{{ email }}');
    expect(out).not.toContain('undefined');
    expect(out).not.toContain('null');
    expect(out).not.toContain('42');
  });

  it('leaves an unknown field with no fallback untouched rather than blanking it', () => {
    expect(renderMergeFields('Hi {{ first_name }}!', {})).toBe('Hi {{ first_name }}!');
    expect(renderMergeFields('Hi {{ mystery }}!', { first_name: 'Ada' })).toBe('Hi {{ mystery }}!');
  });

  it('honours an explicitly empty fallback', () => {
    expect(renderMergeFields('Hi{{ suffix | default: "" }}!', {})).toBe('Hi!');
  });

  it('renders every occurrence, including adjacent ones', () => {
    expect(
      renderMergeFields('{{first_name|default:"a"}}{{last_name|default:"b"}}', {
        first_name: 'X',
      }),
    ).toBe('Xb');
    expect(
      renderMergeFields('{{ first_name | default: "a" }} {{ first_name | default: "a" }}', {
        first_name: 'Ada',
      }),
    ).toBe('Ada Ada');
  });

  it('preserves surrounding text, malformed braces and prose mustaches', () => {
    const text = 'A {{ x | default: "1" }} B {{ broken C }} D {{ unclosed';
    expect(renderMergeFields(text, { x: 'v' })).toBe('A v B {{ broken C }} D {{ unclosed');
  });

  it('does not HTML-escape anything — callers decide', () => {
    expect(renderMergeFields('{{ first_name | default: "x" }}', { first_name: '<b>&</b>' })).toBe(
      '<b>&</b>',
    );
    expect(renderMergeFields('<p>{{ first_name | default: "a&b" }}</p>', {})).toBe('<p>a&b</p>');
  });

  it('does not re-expand merge syntax that arrives inside a value', () => {
    // A subscriber-controlled attribute must never become a template.
    const out = renderMergeFields('Hi {{ first_name | default: "there" }}', {
      first_name: '{{ email }}',
      email: 'victim@example.com',
    });
    expect(out).toBe('Hi {{ email }}');
    expect(out).not.toContain('victim@example.com');
  });

  it('treats replacement values literally, not as regex replacement patterns', () => {
    expect(renderMergeFields('[{{ first_name | default: "x" }}]', { first_name: "$& $' $` $1" })).toBe(
      "[$& $' $` $1]",
    );
  });

  it('never reaches through the prototype chain for a value', () => {
    // `{{ toString }}` must not render "function toString() { [native code] }".
    expect(renderMergeFields('{{ toString | default: "safe" }}', {})).toBe('safe');
    expect(renderMergeFields('{{ constructor | default: "safe" }}', {})).toBe('safe');
    expect(renderMergeFields('{{ hasOwnProperty | default: "safe" }}', {})).toBe('safe');
    expect(renderMergeFields('{{ __proto__ | default: "safe" }}', {})).toBe('safe');
  });

  it('handles an empty template and a template with no fields', () => {
    expect(renderMergeFields('', { first_name: 'Ada' })).toBe('');
    expect(renderMergeFields('No fields here.', {})).toBe('No fields here.');
  });

  it('resolves system fields from the supplied data', () => {
    const out = renderMergeFields(
      '<a href="{{unsubscribe_url}}">Unsubscribe</a> {{ physical_address }} {{list_name}}',
      {
        unsubscribe_url: 'https://mail.example.com/api/unsubscribe?t=tok',
        physical_address: '1 Example Street',
        list_name: 'Domain A Weekly',
      },
    );
    expect(out).toBe(
      '<a href="https://mail.example.com/api/unsubscribe?t=tok">Unsubscribe</a> 1 Example Street Domain A Weekly',
    );
  });
});

/* ------------------------------------------------------------------ */
/* findMergeFieldsWithoutFallback — the §6.6 gate                      */
/* ------------------------------------------------------------------ */

describe('findMergeFieldsWithoutFallback', () => {
  it('flags a subscriber attribute used without a fallback', () => {
    const found = findMergeFieldsWithoutFallback('Hi {{ first_name }},');
    expect(found).toHaveLength(1);
    expect(found[0].field).toBe('first_name');
    expect(found[0].fallback).toBeNull();
  });

  it('passes a subscriber attribute that declares a fallback', () => {
    expect(findMergeFieldsWithoutFallback('Hi {{ first_name | default: "there" }},')).toEqual([]);
  });

  it('never requires a fallback for a system field', () => {
    // System fields are always resolvable, so demanding a fallback would be noise.
    for (const key of SYSTEM_FIELDS) {
      expect(findMergeFieldsWithoutFallback(`x {{ ${key} }} y`), key).toEqual([]);
    }
  });

  it('flags an unknown field that has no fallback', () => {
    expect(findMergeFieldsWithoutFallback('{{ mystery }}').map((r) => r.field)).toEqual(['mystery']);
  });

  it('flags a blank fallback, which renders exactly the "Hi ," this gate exists to stop', () => {
    expect(findMergeFieldsWithoutFallback('Hi {{ first_name | default: "" }},')).toHaveLength(1);
    expect(findMergeFieldsWithoutFallback('Hi {{ first_name | default: "   " }},')).toHaveLength(1);
  });

  it('flags a field whose filter clause is malformed', () => {
    expect(findMergeFieldsWithoutFallback('{{ first_name | default there }}')).toHaveLength(1);
    expect(findMergeFieldsWithoutFallback('{{ first_name | uppercase }}')).toHaveLength(1);
  });

  it('flags every offending occurrence separately, in source order', () => {
    const text = '{{ first_name }} ok {{ email }} {{ last_name }} {{ city | default: "London" }}';
    const found = findMergeFieldsWithoutFallback(text);

    expect(found.map((r) => r.field)).toEqual(['first_name', 'last_name']);
    expect(found[0].index).toBeLessThan(found[1].index);
    expectRefsAnchored(text, found);
  });

  it('flags one occurrence even when the same field is fine elsewhere', () => {
    const found = findMergeFieldsWithoutFallback(
      '{{ first_name | default: "there" }} … {{ first_name }}',
    );
    expect(found).toHaveLength(1);
    expect(found[0].field).toBe('first_name');
  });

  it('returns nothing for a body with no merge fields', () => {
    expect(findMergeFieldsWithoutFallback('Just prose. {{ not a field')).toEqual([]);
    expect(findMergeFieldsWithoutFallback('')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* findUnknownMergeFields                                              */
/* ------------------------------------------------------------------ */

describe('findUnknownMergeFields', () => {
  it('accepts every declared field', () => {
    for (const def of AVAILABLE_MERGE_FIELDS) {
      expect(findUnknownMergeFields(`{{ ${def.key} | default: "x" }}`), def.key).toEqual([]);
    }
  });

  it('accepts every system field', () => {
    for (const key of SYSTEM_FIELDS) {
      expect(findUnknownMergeFields(`{{ ${key} }}`), key).toEqual([]);
    }
  });

  it('flags a field that is neither a system field nor a declared one', () => {
    const found = findUnknownMergeFields('Hi {{ nickname | default: "friend" }}');
    expect(found).toHaveLength(1);
    expect(found[0].field).toBe('nickname');
  });

  it('flags a typo even though it has a fallback', () => {
    expect(findUnknownMergeFields('{{ frist_name | default: "there" }}').map((r) => r.field)).toEqual(
      ['frist_name'],
    );
  });

  it('is case sensitive, because attribute keys are', () => {
    expect(findUnknownMergeFields('{{ First_Name | default: "a" }}')).toHaveLength(1);
    expect(findUnknownMergeFields('{{ EMAIL }}')).toHaveLength(1);
  });

  it('flags names that could reach into Object.prototype', () => {
    const found = findUnknownMergeFields('{{ __proto__ }}{{ constructor }}{{ toString }}');
    expect(found.map((r) => r.field)).toEqual(['__proto__', 'constructor', 'toString']);
  });

  it('flags dotted and hyphenated names rather than silently ignoring them', () => {
    expect(findUnknownMergeFields('{{ user.first_name | default: "a" }}')).toHaveLength(1);
    expect(findUnknownMergeFields('{{ first-name | default: "a" }}')).toHaveLength(1);
  });

  it('flags each occurrence and preserves order', () => {
    const text = '{{ a | default: "1" }} {{ first_name | default: "x" }} {{ a }}';
    const found = findUnknownMergeFields(text);
    expect(found.map((r) => r.field)).toEqual(['a', 'a']);
    expect(found[0].index).toBeLessThan(found[1].index);
  });

  it('returns nothing for prose or malformed braces', () => {
    expect(findUnknownMergeFields('Type {{ to open a field.')).toEqual([]);
    expect(findUnknownMergeFields('')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* toSesPlaceholders                                                   */
/* ------------------------------------------------------------------ */

describe('toSesPlaceholders', () => {
  it('rewrites a field with a fallback to a bare SES placeholder', () => {
    expect(toSesPlaceholders('Hi {{ first_name | default: "there" }}!')).toBe('Hi {{first_name}}!');
  });

  it('normalises a field that already has no fallback', () => {
    expect(toSesPlaceholders('Hi {{ first_name }}!')).toBe('Hi {{first_name}}!');
    expect(toSesPlaceholders('Hi {{first_name}}!')).toBe('Hi {{first_name}}!');
  });

  it('leaves no trace of the fallback syntax in the frozen body', () => {
    const out = toSesPlaceholders(
      'Hi {{ first_name | default: "there" }} — {{ city | default: "your area" }}',
    );
    expect(out).toBe('Hi {{first_name}} — {{city}}');
    expect(out).not.toContain('default:');
    expect(out).not.toContain('|');
  });

  it('rewrites adjacent fields', () => {
    expect(toSesPlaceholders('{{a|default:"1"}}{{b|default:"2"}}')).toBe('{{a}}{{b}}');
  });

  it('rewrites unknown and malformed-filter fields too, so nothing leaks', () => {
    expect(toSesPlaceholders('{{ mystery | default: "x" }}')).toBe('{{mystery}}');
    expect(toSesPlaceholders('{{ first_name | uppercase }}')).toBe('{{first_name}}');
  });

  it('handles a fallback containing braces or quotes', () => {
    expect(toSesPlaceholders('{{ x | default: "a }} b" }} tail')).toBe('{{x}} tail');
    expect(toSesPlaceholders('{{ x | default: "she said \\"hi\\"" }}')).toBe('{{x}}');
  });

  it('handles the HTML-escaped form produced by the renderer', () => {
    expect(toSesPlaceholders('<p>{{ first_name | default: &quot;there&quot; }}</p>')).toBe(
      '<p>{{first_name}}</p>',
    );
  });

  it('leaves prose, malformed braces and surrounding markup untouched', () => {
    expect(toSesPlaceholders('Type {{ to open.')).toBe('Type {{ to open.');
    expect(toSesPlaceholders('{{ }}')).toBe('{{ }}');
    expect(toSesPlaceholders('{{ first name }}')).toBe('{{ first name }}');
    expect(toSesPlaceholders('<a href="https://x/?a=1&b=2">{{email}}</a>')).toBe(
      '<a href="https://x/?a=1&b=2">{{email}}</a>',
    );
  });

  it('is idempotent', () => {
    const once = toSesPlaceholders('Hi {{ first_name | default: "there" }} {{ email }}');
    expect(toSesPlaceholders(once)).toBe(once);
  });

  it('returns an empty string unchanged', () => {
    expect(toSesPlaceholders('')).toBe('');
  });

  it('keeps the rewritten template renderable by the same merge engine', () => {
    const frozen = toSesPlaceholders('Hi {{ first_name | default: "there" }}');
    expect(renderMergeFields(frozen, { first_name: 'Ada' })).toBe('Hi Ada');
  });
});

/* ------------------------------------------------------------------ */
/* resolveReplacements                                                 */
/* ------------------------------------------------------------------ */

describe('resolveReplacements', () => {
  const template = 'Hi {{ first_name | default: "there" }}, from {{ list_name }}. {{ email }}';

  it('returns a value for every field appearing in the template', () => {
    const out = resolveReplacements(template, {
      first_name: 'Ada',
      list_name: 'Domain A Weekly',
      email: 'reader@example.com',
    });
    expect(out).toEqual({
      first_name: 'Ada',
      list_name: 'Domain A Weekly',
      email: 'reader@example.com',
    });
  });

  it('applies the declared fallback when the value is missing, empty or whitespace only', () => {
    expect(resolveReplacements('{{ first_name | default: "there" }}', {}).first_name).toBe('there');
    expect(
      resolveReplacements('{{ first_name | default: "there" }}', { first_name: '' }).first_name,
    ).toBe('there');
    expect(
      resolveReplacements('{{ first_name | default: "there" }}', { first_name: '  ' }).first_name,
    ).toBe('there');
  });

  it('never returns "undefined" or "null" as a value', () => {
    const out = resolveReplacements(
      '{{ first_name | default: "there" }}{{ last_name | default: "friend" }}{{ city }}',
      { first_name: 'undefined', last_name: 'null' } as Record<string, string>,
    );
    for (const value of Object.values(out)) {
      expect(typeof value).toBe('string');
      expect(value).not.toBe('undefined');
      expect(value).not.toBe('null');
    }
    expect(out.first_name).toBe('there');
    expect(out.last_name).toBe('friend');
  });

  it('returns an empty string, never a placeholder, when there is no value and no fallback', () => {
    const out = resolveReplacements('{{ first_name }}', {});
    expect(out).toEqual({ first_name: '' });
    expect(out.first_name).not.toContain('{{');
  });

  it('emits one entry per distinct field, however many times it appears', () => {
    const out = resolveReplacements(
      '{{ first_name | default: "there" }} {{ first_name | default: "there" }}',
      {},
    );
    expect(Object.keys(out)).toEqual(['first_name']);
  });

  it('prefers the first declared fallback when a field is used inconsistently', () => {
    expect(
      resolveReplacements('{{ first_name | default: "A" }} {{ first_name | default: "B" }}', {})
        .first_name,
    ).toBe('A');
    // A bare use must not erase a fallback declared elsewhere in the body.
    expect(
      resolveReplacements('{{ first_name }} {{ first_name | default: "B" }}', {}).first_name,
    ).toBe('B');
  });

  it('omits data keys that the template never mentions', () => {
    const out = resolveReplacements('{{ first_name | default: "there" }}', {
      first_name: 'Ada',
      unused_attribute: 'noise',
    });
    expect(Object.keys(out)).not.toContain('unused_attribute');
  });

  it('carries system values through even when the body text omits them', () => {
    // The chrome (footer, unsubscribe link) lives outside the body text but is
    // part of the same SES template.
    const out = resolveReplacements('{{ first_name | default: "there" }}', {
      first_name: 'Ada',
      unsubscribe_url: 'https://mail.example.com/api/unsubscribe?t=tok',
      physical_address: '1 Example Street',
    });
    expect(out.unsubscribe_url).toBe('https://mail.example.com/api/unsubscribe?t=tok');
    expect(out.physical_address).toBe('1 Example Street');
  });

  it('works on a body already converted to SES placeholders', () => {
    const frozen = toSesPlaceholders('Hi {{ first_name | default: "there" }}');
    // The frozen body no longer carries the fallback, so the caller passes the
    // source text; both must agree on the field set.
    expect(Object.keys(resolveReplacements(frozen, {}))).toEqual(['first_name']);
  });

  it('never reaches through the prototype chain', () => {
    const out = resolveReplacements('{{ toString | default: "safe" }}{{ constructor }}', {});
    expect(out.toString as unknown as string).toBe('safe');
    expect(out.constructor as unknown as string).toBe('');
  });

  it('returns a plain object even for a __proto__ field, without polluting it', () => {
    const out = resolveReplacements('{{ __proto__ | default: "safe" }}', {});
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('returns an empty map for a template with no fields', () => {
    expect(resolveReplacements('no fields', {})).toEqual({});
    expect(resolveReplacements('', { first_name: 'Ada' })).toEqual({});
  });

  it('produces values that render the same body as renderMergeFields would', () => {
    // Preview (§6.3) and the real send must never disagree.
    const body = 'Hi {{ first_name | default: "there" }} of {{ list_name }}!';
    const data = { list_name: 'Domain A Weekly' };

    const direct = renderMergeFields(body, data);
    const viaSes = renderMergeFields(toSesPlaceholders(body), resolveReplacements(body, data));

    expect(viaSes).toBe(direct);
    expect(viaSes).toBe('Hi there of Domain A Weekly!');
  });
});

/* ------------------------------------------------------------------ */
/* hostile and malformed data maps                                     */
/* ------------------------------------------------------------------ */

describe('merge data is read as own properties only', () => {
  const body = 'Hi {{ first_name | default: "there" }}!';

  it('ignores a string value inherited from the data object prototype', () => {
    // Attribute maps are rehydrated from JSON/CSV upstream. A value reachable
    // only through the prototype chain is not this subscriber's data, and
    // rendering it puts one recipient's attribute in another's email.
    const inherited = Object.create({
      first_name: 'SomeoneElse',
      email: 'ghost@example.com',
    }) as Record<string, string>;

    expect(renderMergeFields(body, inherited)).toBe('Hi there!');
    expect(renderMergeFields('{{ email }}', inherited)).toBe('{{ email }}');
    expect(resolveReplacements('{{ first_name | default: "there" }}{{ email }}', inherited)).toEqual(
      { first_name: 'there', email: '' },
    );
  });

  it('is immune to a polluted Object.prototype', () => {
    // A `__proto__` key in an imported CSV can pollute the global prototype.
    // Every merge field in every campaign would then resolve to the attacker's
    // value for every recipient at once.
    Object.defineProperty(Object.prototype, 'first_name', {
      value: 'POLLUTED',
      configurable: true,
      enumerable: false,
      writable: true,
    });
    try {
      expect(renderMergeFields(body, {})).toBe('Hi there!');
      expect(resolveReplacements(body, {}).first_name).toBe('there');
      expect(renderMergeFields('Hi {{ first_name }}!', {})).toBe('Hi {{ first_name }}!');
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>).first_name;
    }
  });

  it('treats a missing or non-object data map as "no data" rather than throwing', () => {
    // The data map crosses a JSON boundary; a null landing here must degrade to
    // the fallback, not throw inside an in-flight batch of 50 recipients.
    for (const data of [null, undefined, 'not-an-object', 42] as unknown as Record<
      string,
      string
    >[]) {
      expect(renderMergeFields(body, data)).toBe('Hi there!');
      expect(resolveReplacements(body, data)).toEqual({ first_name: 'there' });
    }
  });
});
