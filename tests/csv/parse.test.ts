import { describe, expect, it } from 'vitest';
import { parseCsv, serializeCsv } from '@/lib/csv/parse';

/**
 * CSV parsing / serialization (§4.3, §4.4, CONTRACTS §24).
 *
 * This is the import/export path for ~33,000 real subscriber records, so the
 * bar is RFC 4180 conformance plus lenient recovery: a malformed row is handed
 * back to the caller to report, never silently dropped or padded.
 */

describe('parseCsv — empty and degenerate input', () => {
  it('returns empty headers and rows for an empty string', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] });
  });

  it('returns empty headers and rows for a lone newline', () => {
    expect(parseCsv('\n')).toEqual({ headers: [], rows: [] });
    expect(parseCsv('\r\n')).toEqual({ headers: [], rows: [] });
    expect(parseCsv('\n\n\n')).toEqual({ headers: [], rows: [] });
  });

  it('returns empty headers and rows for a file containing only a BOM', () => {
    expect(parseCsv('﻿')).toEqual({ headers: [], rows: [] });
    expect(parseCsv('﻿\r\n')).toEqual({ headers: [], rows: [] });
  });

  it('treats a header-only file as zero data rows', () => {
    expect(parseCsv('email,first_name')).toEqual({
      headers: ['email', 'first_name'],
      rows: [],
    });
    expect(parseCsv('email,first_name\r\n')).toEqual({
      headers: ['email', 'first_name'],
      rows: [],
    });
  });

  it('handles a single-column file with no delimiters at all', () => {
    expect(parseCsv('email\na@example.com\nb@example.com')).toEqual({
      headers: ['email'],
      rows: [['a@example.com'], ['b@example.com']],
    });
  });
});

describe('parseCsv — line endings', () => {
  it('parses LF line endings', () => {
    expect(parseCsv('a,b\n1,2\n3,4')).toEqual({
      headers: ['a', 'b'],
      rows: [
        ['1', '2'],
        ['3', '4'],
      ],
    });
  });

  it('parses CRLF line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n3,4')).toEqual({
      headers: ['a', 'b'],
      rows: [
        ['1', '2'],
        ['3', '4'],
      ],
    });
  });

  it('parses a file that mixes CRLF and LF', () => {
    expect(parseCsv('a,b\r\n1,2\n3,4\r\n')).toEqual({
      headers: ['a', 'b'],
      rows: [
        ['1', '2'],
        ['3', '4'],
      ],
    });
  });

  it('accepts lone CR terminators (classic Mac exports)', () => {
    expect(parseCsv('a,b\r1,2\r3,4')).toEqual({
      headers: ['a', 'b'],
      rows: [
        ['1', '2'],
        ['3', '4'],
      ],
    });
  });

  it('does not emit a phantom row for a trailing newline', () => {
    expect(parseCsv('a\n1\n').rows).toEqual([['1']]);
    expect(parseCsv('a\r\n1\r\n').rows).toEqual([['1']]);
    // A trailing *blank* field, however, is real data and is kept.
    expect(parseCsv('a,b\r\n1,\r\n').rows).toEqual([['1', '']]);
  });

  it('skips wholly blank lines in the middle of a file', () => {
    expect(parseCsv('a,b\n\n1,2\n\n\n3,4\n')).toEqual({
      headers: ['a', 'b'],
      rows: [
        ['1', '2'],
        ['3', '4'],
      ],
    });
  });

  it('keeps a line that is an explicitly quoted empty field', () => {
    // `""` is not a blank line: the operator wrote an empty value on purpose.
    expect(parseCsv('a\n""\n').rows).toEqual([['']]);
  });

  it('keeps a line of nothing but delimiters', () => {
    expect(parseCsv('a,b,c\n,,\n').rows).toEqual([['', '', '']]);
  });
});

describe('parseCsv — BOM', () => {
  it('strips a leading UTF-8 BOM from the first header', () => {
    const { headers } = parseCsv('﻿email,status\r\na@example.com,confirmed\r\n');
    expect(headers).toEqual(['email', 'status']);
    expect(headers[0]).not.toContain('﻿');
  });

  it('strips a BOM that precedes a quoted first header', () => {
    expect(parseCsv('﻿"email","status"\r\nx,y').headers).toEqual(['email', 'status']);
  });

  it('leaves a BOM that appears anywhere other than the start alone', () => {
    // Only the byte-order mark at offset 0 is a BOM; elsewhere it is data.
    expect(parseCsv('a,b\n﻿x,y').rows).toEqual([['﻿x', 'y']]);
  });
});

describe('parseCsv — quoting (RFC 4180)', () => {
  it('unwraps quoted fields', () => {
    expect(parseCsv('a,b\n"x","y"').rows).toEqual([['x', 'y']]);
  });

  it('preserves commas embedded in quoted fields', () => {
    expect(parseCsv('name,email\n"Doe, Jane",jane@example.com').rows).toEqual([
      ['Doe, Jane', 'jane@example.com'],
    ]);
  });

  it('preserves LF newlines embedded in quoted fields', () => {
    const { headers, rows } = parseCsv('note,email\n"line one\nline two",a@example.com\n');
    expect(headers).toEqual(['note', 'email']);
    expect(rows).toEqual([['line one\nline two', 'a@example.com']]);
  });

  it('preserves CRLF newlines embedded in quoted fields verbatim', () => {
    expect(parseCsv('note\r\n"one\r\ntwo"\r\n').rows).toEqual([['one\r\ntwo']]);
  });

  it('preserves an embedded newline in a header cell', () => {
    expect(parseCsv('"first\nname",email\nJane,j@example.com').headers).toEqual([
      'first\nname',
      'email',
    ]);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('a\n"she said ""hi"""').rows).toEqual([['she said "hi"']]);
  });

  it('handles a field that is only escaped quotes', () => {
    expect(parseCsv('a\n""""').rows).toEqual([['"']]);
    expect(parseCsv('a\n""""""').rows).toEqual([['""']]);
  });

  it('handles a quoted field containing only a comma', () => {
    expect(parseCsv('a,b\n",",x').rows).toEqual([[',', 'x']]);
  });

  it('treats quotes inside an unquoted field as literal characters', () => {
    expect(parseCsv('a,b\nx"y,z').rows).toEqual([['x"y', 'z']]);
  });

  it('appends stray text that follows a closing quote instead of throwing', () => {
    expect(parseCsv('a\n"x"y').rows).toEqual([['xy']]);
    expect(parseCsv('a,b\n"x"y,z').rows).toEqual([['xy', 'z']]);
  });

  it('recovers from an unterminated quote at end of file', () => {
    expect(() => parseCsv('a,b\n"unterminated,field')).not.toThrow();
    expect(parseCsv('a,b\n"unterminated,field').rows).toEqual([['unterminated,field']]);
    // A bare opening quote yields a single empty field rather than an error.
    expect(parseCsv('a\n"').rows).toEqual([['']]);
  });

  it('does not trim whitespace around fields', () => {
    expect(parseCsv('a,b\n  x  , y ').rows).toEqual([['  x  ', ' y ']]);
    expect(parseCsv('a,b\n"  x  ","\ty"').rows).toEqual([['  x  ', '\ty']]);
  });

  it('leaves other separators (semicolon, tab, pipe) as ordinary characters', () => {
    expect(parseCsv('a\nx;y\tz|w').rows).toEqual([['x;y\tz|w']]);
  });
});

describe('parseCsv — ragged rows are preserved, never padded (§4.3)', () => {
  it('keeps a row with fewer cells than the header', () => {
    const { headers, rows } = parseCsv('email,first_name,last_name\na@example.com,Jane\n');
    expect(headers).toHaveLength(3);
    expect(rows).toEqual([['a@example.com', 'Jane']]);
    expect(rows[0]).toHaveLength(2);
  });

  it('keeps a row with more cells than the header', () => {
    const { rows } = parseCsv('email\na@example.com,extra,more\n');
    expect(rows).toEqual([['a@example.com', 'extra', 'more']]);
  });

  it('keeps ragged rows interleaved with well-formed ones so all are reportable', () => {
    const { rows } = parseCsv('email,name\na@example.com,A\nb@example.com\nc@example.com,C,junk\n');
    expect(rows).toEqual([
      ['a@example.com', 'A'],
      ['b@example.com'],
      ['c@example.com', 'C', 'junk'],
    ]);
  });

  it('preserves duplicate header names rather than de-duplicating them', () => {
    expect(parseCsv('email,email\na@example.com,b@example.com').headers).toEqual([
      'email',
      'email',
    ]);
  });

  it('preserves an empty header cell', () => {
    expect(parseCsv('email,,name\na,b,c').headers).toEqual(['email', '', 'name']);
  });
});

describe('parseCsv — real-world payloads', () => {
  it('parses a Squarespace-shaped export', () => {
    const csv =
      '﻿"Email Address","First Name","Last Name","Sign Up Date"\r\n' +
      '"jane@example.com","Jane","Doe, Jr.","2024-01-02"\r\n' +
      '"bob@example.com","Bob","O""Brien","2024-01-03"\r\n' +
      '"note@example.com","Multi","line\r\nvalue","2024-01-04"\r\n';

    const { headers, rows } = parseCsv(csv);
    expect(headers).toEqual(['Email Address', 'First Name', 'Last Name', 'Sign Up Date']);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual(['bob@example.com', 'Bob', 'O"Brien', '2024-01-03']);
    expect(rows[2]?.[2]).toBe('line\r\nvalue');
  });

  it('preserves unicode, emoji and accented characters', () => {
    const { rows } = parseCsv('name,email\n"Zoë 🌱","zoe@example.com"');
    expect(rows).toEqual([['Zoë 🌱', 'zoe@example.com']]);
  });

  it('parses a list-sized file without quadratic blowup', () => {
    const lines = ['email,first_name'];
    for (let i = 0; i < 33_000; i += 1) {
      lines.push(`user${i}@example.com,"Name, ${i}"`);
    }
    const started = Date.now();
    const { headers, rows } = parseCsv(`${lines.join('\r\n')}\r\n`);
    expect(headers).toEqual(['email', 'first_name']);
    expect(rows).toHaveLength(33_000);
    expect(rows[32_999]).toEqual(['user32999@example.com', 'Name, 32999']);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('serializeCsv — structure', () => {
  it('writes a header row and CRLF-terminated data rows', () => {
    expect(serializeCsv(['a', 'b'], [['1', '2']])).toBe('a,b\r\n1,2\r\n');
  });

  it('returns an empty string when there is nothing at all to write', () => {
    expect(serializeCsv([], [])).toBe('');
  });

  it('writes a header row even with no data rows', () => {
    expect(serializeCsv(['email', 'status'], [])).toBe('email,status\r\n');
  });

  it('renders undefined as an empty field', () => {
    expect(serializeCsv(['a', 'b', 'c'], [['x', undefined, 'z']])).toBe('a,b,c\r\nx,,z\r\n');
    expect(serializeCsv(['a'], [[undefined]])).toBe('a\r\n""\r\n');
  });

  it('does not pad or truncate ragged rows', () => {
    expect(serializeCsv(['a', 'b', 'c'], [['1'], ['1', '2', '3', '4']])).toBe(
      'a,b,c\r\n1\r\n1,2,3,4\r\n',
    );
  });

  it('writes an all-empty row as a quoted empty field so it survives a round trip', () => {
    const csv = serializeCsv(['a'], [['']]);
    expect(csv).toBe('a\r\n""\r\n');
    expect(parseCsv(csv).rows).toEqual([['']]);
  });
});

describe('serializeCsv — quoting', () => {
  it('quotes a field containing a comma', () => {
    expect(serializeCsv(['name'], [['Doe, Jane']])).toBe('name\r\n"Doe, Jane"\r\n');
  });

  it('quotes a field containing a double quote and doubles the quote', () => {
    expect(serializeCsv(['name'], [['O"Brien']])).toBe('name\r\n"O""Brien"\r\n');
  });

  it('quotes fields containing LF, CR or CRLF', () => {
    expect(serializeCsv(['n'], [['a\nb']])).toBe('n\r\n"a\nb"\r\n');
    expect(serializeCsv(['n'], [['a\rb']])).toBe('n\r\n"a\rb"\r\n');
    expect(serializeCsv(['n'], [['a\r\nb']])).toBe('n\r\n"a\r\nb"\r\n');
  });

  it('quotes header cells that need it', () => {
    expect(serializeCsv(['a,b', 'c"d'], [])).toBe('"a,b","c""d"\r\n');
  });

  it('leaves ordinary fields unquoted', () => {
    expect(serializeCsv(['email'], [['a@example.com'], ['x y z'], ['semi;colon']])).toBe(
      'email\r\na@example.com\r\nx y z\r\nsemi;colon\r\n',
    );
  });
});

describe('serializeCsv — spreadsheet formula injection (CONTRACTS §24)', () => {
  it('defuses the canonical command-execution payload', () => {
    const csv = serializeCsv(['name'], [["=cmd|'/c calc'!A0"]]);
    // Prefixed with a single quote, so Excel/Sheets treat it as literal text.
    expect(csv).toBe("name\r\n'=cmd|'/c calc'!A0\r\n");
    const value = parseCsv(csv).rows[0]?.[0];
    expect(value?.startsWith('=')).toBe(false);
    expect(value).toBe("'=cmd|'/c calc'!A0");
  });

  it.each(['=', '+', '-', '@'])('prefixes a field starting with %s', (char) => {
    const csv = serializeCsv(['v'], [[`${char}danger`]]);
    expect(csv).toBe(`v\r\n'${char}danger\r\n`);
  });

  it('defuses dangerous header cells too', () => {
    // Prefixed with `'`, then quoted because the value contains double quotes.
    expect(serializeCsv(['=HYPERLINK("http://evil.test")'], [])).toBe(
      '"\'=HYPERLINK(""http://evil.test"")"\r\n',
    );
  });

  it('quotes as well as prefixes when the payload also contains a comma', () => {
    expect(serializeCsv(['v'], [['=SUM(1,2)']])).toBe('v\r\n"\'=SUM(1,2)"\r\n');
  });

  it('quotes as well as prefixes when the payload contains a quote or newline', () => {
    expect(serializeCsv(['v'], [['@import"x"']])).toBe('v\r\n"\'@import""x"""\r\n');
    expect(serializeCsv(['v'], [['-a\nb']])).toBe('v\r\n"\'-a\nb"\r\n');
  });

  it('leaves a dangerous character that is not in first position alone', () => {
    expect(serializeCsv(['v'], [['a=b'], ['1+1'], ['user@example.com']])).toBe(
      'v\r\na=b\r\n1+1\r\nuser@example.com\r\n',
    );
  });

  it('does not double-prefix a value that already starts with a single quote', () => {
    expect(serializeCsv(['v'], [["'=already"]])).toBe("v\r\n'=already\r\n");
  });

  it('leaves empty and undefined fields unprefixed', () => {
    expect(serializeCsv(['a', 'b'], [['', undefined]])).toBe('a,b\r\n,\r\n');
  });

  it('coerces a non-string cell rather than emitting "undefined" or throwing', () => {
    // Defensive: an export builder that forgets to stringify a count or a null
    // attribute must not corrupt the file.
    const rows = [[0, null, -7, true]] as unknown as (string | undefined)[][];
    expect(serializeCsv(['n', 'z', 'neg', 'flag'], rows)).toBe(
      'n,z,neg,flag\r\n0,,\'-7,true\r\n',
    );
  });
});

describe('round trip', () => {
  it('survives parse(serialize(x)) for awkward values', () => {
    const headers = ['email', 'name', 'note', 'blank'];
    const rows: (string | undefined)[][] = [
      ['a@example.com', 'Doe, Jane', 'said "hi"', ''],
      ['b@example.com', 'line\nbreak', 'crlf\r\nbreak', undefined],
      ['c@example.com', '  padded  ', 'Zoë 🌱', ';|\t'],
    ];

    const parsed = parseCsv(serializeCsv(headers, rows));
    expect(parsed.headers).toEqual(headers);
    expect(parsed.rows).toEqual([
      ['a@example.com', 'Doe, Jane', 'said "hi"', ''],
      ['b@example.com', 'line\nbreak', 'crlf\r\nbreak', ''],
      ['c@example.com', '  padded  ', 'Zoë 🌱', ';|\t'],
    ]);
  });

  it('round trips ragged rows without padding them', () => {
    const parsed = parseCsv(serializeCsv(['a', 'b', 'c'], [['1'], ['1', '2', '3', '4']]));
    expect(parsed.rows).toEqual([['1'], ['1', '2', '3', '4']]);
  });

  it('is stable under a second round trip once formulas are neutralised', () => {
    const once = serializeCsv(['v'], [['=1+1']]);
    const parsedOnce = parseCsv(once);
    const twice = serializeCsv(parsedOnce.headers, parsedOnce.rows);
    expect(parseCsv(twice).rows).toEqual([["'=1+1"]]);
  });
});
