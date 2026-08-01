/**
 * CSV parsing and serialization (spec §4.3, §4.4; CONTRACTS §24).
 *
 * This module is the entire import/export surface for ~33,000 real subscriber
 * records, so it follows RFC 4180 and then adds two deliberate behaviours that
 * the spec asks for by name:
 *
 *  1. **Nothing is repaired silently.** A ragged row — fewer or more cells than
 *     the header — is handed back exactly as written. Padding it would invent
 *     data, and dropping it would hide a row the operator must be told about
 *     (§4.3: "malformed rows are reported back, not silently dropped"). The
 *     caller decides what a short row means; the parser only reports what is
 *     there.
 *  2. **Nothing is thrown.** Real exports contain unterminated quotes and stray
 *     characters. A parse error on row 20,000 of a migration is far worse than a
 *     best-effort recovery plus a row the importer can reject by name.
 *
 * On the way out, `serializeCsv` additionally defuses spreadsheet formula
 * injection. An exported subscriber name is attacker-controlled text — anyone
 * can type `=cmd|'/c calc'!A0` into a signup form — and the operator opens the
 * export in Excel or Sheets. Prefixing the leading `=`, `+`, `-` or `@` with a
 * single quote makes the cell inert text.
 */

const BOM = '﻿';
const QUOTE = '"';
const DELIMITER = ',';
const ROW_TERMINATOR = '\r\n';

/** A field is quoted on export when it contains one of these. */
const MUST_QUOTE = /["\r\n,]/;

/** Leading characters a spreadsheet treats as the start of a formula. */
const FORMULA_LEAD = /^[=+\-@]/;

/**
 * Parses RFC 4180 CSV.
 *
 * Handles quoted fields, embedded commas, embedded newlines, escaped quotes
 * (`""`), CRLF/LF/CR terminators and a leading UTF-8 BOM. The first record is
 * the header; every later record is returned untouched, including ragged ones.
 *
 * A wholly blank line contributes no record — it is layout, not a row with an
 * empty value. A line written as `""` *is* a record containing one empty field,
 * because the quotes make the intent explicit.
 */
export function parseCsv(input: string): { headers: string[]; rows: string[][] } {
  if (typeof input !== 'string' || input === '') return { headers: [], rows: [] };

  // Only a BOM at offset 0 is a byte-order mark; the same code point later in
  // the file is ordinary (if odd) data.
  const text = input.startsWith(BOM) ? input.slice(BOM.length) : input;
  const length = text.length;

  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  /** Whether any character at all has been consumed for the current record. */
  let touched = false;
  /** Whether the current *field* has consumed anything yet (quoting may open). */
  let fieldTouched = false;
  let index = 0;

  const endField = (): void => {
    record.push(field);
    field = '';
    fieldTouched = false;
  };

  const endRecord = (): void => {
    record.push(field);
    field = '';
    fieldTouched = false;
    // Distinguish a blank line (no characters at all) from a line whose single
    // field is a deliberate empty value.
    const blank = record.length === 1 && record[0] === '' && !touched;
    if (!blank) records.push(record);
    record = [];
    touched = false;
  };

  while (index < length) {
    const char = text[index] as string;

    if (inQuotes) {
      if (char === QUOTE) {
        if (text[index + 1] === QUOTE) {
          // `""` inside a quoted field is a literal quote.
          field += QUOTE;
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      // Newlines inside quotes are data, and are preserved byte for byte so a
      // CRLF written by Excel survives the round trip.
      field += char;
      index += 1;
      continue;
    }

    if (char === QUOTE && !fieldTouched) {
      // Only a quote in first position opens a quoted field. A quote later in
      // an unquoted field (`x"y`) is not legal RFC 4180, and the useful reading
      // is the literal one — that is a name with a quote in it, not a parse
      // error that would sink the whole import.
      inQuotes = true;
      touched = true;
      fieldTouched = true;
      index += 1;
      continue;
    }

    if (char === DELIMITER) {
      endField();
      touched = true;
      index += 1;
      continue;
    }

    if (char === '\n') {
      endRecord();
      index += 1;
      continue;
    }

    if (char === '\r') {
      endRecord();
      // CRLF is one terminator; a lone CR is a classic Mac terminator.
      index += text[index + 1] === '\n' ? 2 : 1;
      continue;
    }

    field += char;
    touched = true;
    fieldTouched = true;
    index += 1;
  }

  // Flush whatever the last line left behind, including an unterminated quote.
  if (touched || field !== '' || record.length > 0) endRecord();

  const [headers = [], ...rows] = records;
  return { headers, rows };
}

/**
 * Escapes one field for export: formula injection is defused first, then the
 * result is quoted if it needs to be. The order matters — prefixing can
 * introduce a value that still needs quoting, but quoting never introduces a
 * leading formula character.
 */
function encodeField(value: string | undefined): string {
  let out: string;
  if (value === undefined || value === null) out = '';
  else if (typeof value === 'string') out = value;
  else out = String(value);

  if (FORMULA_LEAD.test(out)) out = `'${out}`;
  if (MUST_QUOTE.test(out)) out = `${QUOTE}${out.split(QUOTE).join('""')}${QUOTE}`;
  return out;
}

function encodeRow(cells: readonly (string | undefined)[]): string {
  const line = cells.map(encodeField).join(DELIMITER);
  // A row whose entire rendering is empty would come back as a blank line and
  // be read as layout. Write it as an explicit empty field so it round trips.
  return line === '' ? '""' : line;
}

/**
 * Serializes to RFC 4180 CSV with CRLF terminators and a trailing newline.
 *
 * `undefined` renders as an empty field. Rows are written exactly as given:
 * a short row stays short, because the export mirrors the data rather than
 * asserting a shape it does not have.
 */
export function serializeCsv(headers: string[], rows: (string | undefined)[][]): string {
  const lines: string[] = [];
  if (headers.length > 0) lines.push(encodeRow(headers));
  for (const row of rows) lines.push(encodeRow(row));
  if (lines.length === 0) return '';
  return `${lines.join(ROW_TERMINATOR)}${ROW_TERMINATOR}`;
}
