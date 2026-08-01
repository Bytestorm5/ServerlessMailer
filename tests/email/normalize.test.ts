import { describe, expect, it } from 'vitest';
import {
  emailDomain,
  isValidDomain,
  isValidEmailSyntax,
  normalizeAndValidate,
  normalizeEmail,
} from '@/lib/email/normalize';

/** Builds an address of exactly `total` characters using a valid domain. */
function addressOfLength(total: number): string {
  const domain = 'example.com';
  const local = 'a'.repeat(total - domain.length - 1);
  const address = `${local}@${domain}`;
  if (address.length !== total) throw new Error('bad fixture');
  return address;
}

describe('normalizeEmail', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeEmail('  user@example.com  ')).toBe('user@example.com');
  });

  it('trims tabs, newlines and carriage returns', () => {
    expect(normalizeEmail('\t\r\nuser@example.com\n\t')).toBe('user@example.com');
  });

  it('trims non-breaking space', () => {
    expect(normalizeEmail(' user@example.com ')).toBe('user@example.com');
  });

  it('lowercases the whole address', () => {
    expect(normalizeEmail('User.Name@Example.COM')).toBe('user.name@example.com');
  });

  it('preserves plus-addressing — a plus tag is a different person', () => {
    expect(normalizeEmail('User+Newsletter@Example.com')).toBe(
      'user+newsletter@example.com',
    );
  });

  it('does not merge a plus-tagged address into its base address', () => {
    expect(normalizeEmail('a+tag@example.com')).not.toBe(normalizeEmail('a@example.com'));
  });

  it('preserves dots in the local part — never gmail-style dot stripping', () => {
    expect(normalizeEmail('first.last@gmail.com')).toBe('first.last@gmail.com');
    expect(normalizeEmail('firstlast@gmail.com')).not.toBe(
      normalizeEmail('first.last@gmail.com'),
    );
  });

  it('leaves interior whitespace alone (validation, not normalization, rejects it)', () => {
    expect(normalizeEmail('  user name@example.com ')).toBe('user name@example.com');
  });

  it('is idempotent', () => {
    const once = normalizeEmail('  User@Example.COM ');
    expect(normalizeEmail(once)).toBe(once);
  });

  it('returns an empty string for an empty or blank input', () => {
    expect(normalizeEmail('')).toBe('');
    expect(normalizeEmail('   \t \n ')).toBe('');
  });

  it('tolerates non-string input from untyped callers', () => {
    expect(normalizeEmail(undefined as unknown as string)).toBe('');
    expect(normalizeEmail(null as unknown as string)).toBe('');
    expect(normalizeEmail(42 as unknown as string)).toBe('');
    expect(normalizeEmail({} as unknown as string)).toBe('');
  });
});

describe('isValidEmailSyntax', () => {
  const valid = [
    'user@example.com',
    'user+tag@example.com',
    'first.last@sub.example.co.uk',
    'user_name@example.com',
    'user-name@example.com',
    "o'brien@example.com",
    'a@b.co',
    '1234567890@example.com',
    'user@my-domain.com',
    'user@example.museum',
    "!#$%&'*+/=?^_`{|}~-@example.com",
    'user@example.xn--p1ai',
    'UPPER@EXAMPLE.COM',
  ];

  for (const address of valid) {
    it(`accepts ${JSON.stringify(address)}`, () => {
      expect(isValidEmailSyntax(address)).toBe(true);
    });
  }

  const invalid: [string, string][] = [
    ['', 'empty'],
    ['   ', 'blank'],
    ['nope', 'missing @'],
    ['@example.com', 'missing local part'],
    ['user@', 'missing domain'],
    ['user@@example.com', 'doubled @'],
    ['user@a@example.com', 'multiple @'],
    ['a@b@c@example.com', 'many @'],
    ['user@example', 'missing TLD'],
    ['user@localhost', 'missing TLD'],
    ['user@example.', 'trailing dot'],
    ['user@.example.com', 'leading dot in domain'],
    ['.user@example.com', 'leading dot in local part'],
    ['user.@example.com', 'trailing dot in local part'],
    ['user..name@example.com', 'consecutive dots in local part'],
    ['user@example..com', 'consecutive dots in domain'],
    ['user name@example.com', 'space in local part'],
    ['user@exam ple.com', 'space in domain'],
    [' user@example.com', 'untrimmed leading space'],
    ['user@example.com ', 'untrimmed trailing space'],
    ['user\t@example.com', 'tab'],
    ['user@example.com\n', 'trailing newline'],
    ['user@-example.com', 'leading hyphen in label'],
    ['user@example-.com', 'trailing hyphen in label'],
    ['user@example.c', 'single-character TLD'],
    ['user@example.c0m', 'digit in TLD'],
    ['user@example.co-uk', 'hyphen in TLD'],
    ['user@[192.168.0.1]', 'IP literal'],
    ['user@192.168.0.1', 'bare IPv4, no MX-bearing TLD'],
    ['usér@example.com', 'non-ASCII local part'],
    ['user@exámple.com', 'non-ASCII domain'],
    ['user@例え.com', 'unicode domain'],
    ['"user name"@example.com', 'quoted local part'],
    ['<user@example.com>', 'angle brackets'],
    ['user@example.com,other@example.com', 'comma-separated list'],
    ['user@example.com;other@example.com', 'semicolon-separated list'],
    ['user(comment)@example.com', 'RFC comment'],
    ['user@example.com\u0000', 'NUL byte'],
    ['user\\@example.com', 'backslash'],
  ];

  for (const [address, why] of invalid) {
    it(`rejects ${JSON.stringify(address)} (${why})`, () => {
      expect(isValidEmailSyntax(address)).toBe(false);
    });
  }

  it('rejects header injection attempts', () => {
    expect(isValidEmailSyntax('user@example.com\nBcc: victim@example.com')).toBe(false);
    expect(isValidEmailSyntax('user@example.com\r\nSubject: spam')).toBe(false);
  });

  it('accepts a 64-character local part but rejects 65', () => {
    expect(isValidEmailSyntax(`${'a'.repeat(64)}@example.com`)).toBe(true);
    expect(isValidEmailSyntax(`${'a'.repeat(65)}@example.com`)).toBe(false);
  });

  it('rejects an over-long local part even inside a 254-character address', () => {
    expect(isValidEmailSyntax(addressOfLength(254))).toBe(false); // local part > 64
    const domain = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(60)}.com`;
    const local = 'x'.repeat(254 - 1 - domain.length);
    expect(`${local}@${domain}`).toHaveLength(254);
    expect(isValidEmailSyntax(`${local}@${domain}`)).toBe(true);
    expect(isValidEmailSyntax(`${local}z@${domain}`)).toBe(false);
  });

  it('rejects a domain label longer than 63 characters', () => {
    expect(isValidEmailSyntax(`user@${'a'.repeat(63)}.com`)).toBe(true);
    expect(isValidEmailSyntax(`user@${'a'.repeat(64)}.com`)).toBe(false);
  });

  it('tolerates non-string input from untyped callers', () => {
    expect(isValidEmailSyntax(undefined as unknown as string)).toBe(false);
    expect(isValidEmailSyntax(null as unknown as string)).toBe(false);
    expect(isValidEmailSyntax(12345 as unknown as string)).toBe(false);
  });
});

describe('isValidDomain', () => {
  it('accepts fully-qualified ASCII domains', () => {
    expect(isValidDomain('example.com')).toBe(true);
    expect(isValidDomain('news.domain-a.com')).toBe(true);
    expect(isValidDomain('a.co')).toBe(true);
    expect(isValidDomain('example.xn--p1ai')).toBe(true);
  });

  it('rejects anything that could not carry an MX record', () => {
    expect(isValidDomain('')).toBe(false);
    expect(isValidDomain('localhost')).toBe(false);
    expect(isValidDomain('.example.com')).toBe(false);
    expect(isValidDomain('example.com.')).toBe(false);
    expect(isValidDomain('example..com')).toBe(false);
    expect(isValidDomain('-example.com')).toBe(false);
    expect(isValidDomain('example.com\n')).toBe(false);
    expect(isValidDomain('192.168.0.1')).toBe(false);
    expect(isValidDomain(`${'a'.repeat(64)}.com`)).toBe(false);
    expect(isValidDomain(`${'a.'.repeat(130)}com`)).toBe(false);
  });

  it('tolerates non-string input from untyped callers', () => {
    expect(isValidDomain(undefined as unknown as string)).toBe(false);
    expect(isValidDomain(null as unknown as string)).toBe(false);
    expect(isValidDomain(123 as unknown as string)).toBe(false);
  });
});

describe('emailDomain', () => {
  it('returns the domain part, lowercased', () => {
    expect(emailDomain('User@Example.COM')).toBe('example.com');
  });

  it('normalizes before extracting', () => {
    expect(emailDomain('  User@Example.com  ')).toBe('example.com');
  });

  it('preserves subdomains', () => {
    expect(emailDomain('user@news.domain-a.com')).toBe('news.domain-a.com');
  });

  it('is unaffected by a plus tag', () => {
    expect(emailDomain('user+tag@example.com')).toBe('example.com');
  });

  it('returns an empty string for invalid addresses', () => {
    expect(emailDomain('')).toBe('');
    expect(emailDomain('nope')).toBe('');
    expect(emailDomain('user@')).toBe('');
    expect(emailDomain('@example.com')).toBe('');
    expect(emailDomain('user@example')).toBe('');
    expect(emailDomain('a@b@c.com')).toBe('');
    expect(emailDomain(undefined as unknown as string)).toBe('');
  });
});

describe('normalizeAndValidate', () => {
  it('accepts a valid address and returns the normalized form and domain', () => {
    expect(normalizeAndValidate('  User+Tag@Example.COM ')).toEqual({
      ok: true,
      email: 'user+tag@example.com',
      domain: 'example.com',
    });
  });

  it('keeps plus-tagged addresses distinct', () => {
    const a = normalizeAndValidate('news+a@example.com');
    const b = normalizeAndValidate('news+b@example.com');
    expect(a.ok && b.ok && a.email === b.email).toBe(false);
  });

  it('reports empty for an empty string', () => {
    expect(normalizeAndValidate('')).toEqual({ ok: false, reason: 'empty' });
  });

  it('reports empty for whitespace only', () => {
    expect(normalizeAndValidate('   \t\n  ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('reports empty for non-string input', () => {
    expect(normalizeAndValidate(undefined as unknown as string)).toEqual({
      ok: false,
      reason: 'empty',
    });
    expect(normalizeAndValidate(null as unknown as string)).toEqual({
      ok: false,
      reason: 'empty',
    });
  });

  it('reports too_long above 254 characters', () => {
    expect(normalizeAndValidate(addressOfLength(255))).toEqual({
      ok: false,
      reason: 'too_long',
    });
  });

  it('reports too_long for a local part above 64 characters', () => {
    expect(normalizeAndValidate(`${'a'.repeat(65)}@example.com`)).toEqual({
      ok: false,
      reason: 'too_long',
    });
  });

  it('accepts a local part of exactly 64 characters', () => {
    const result = normalizeAndValidate(`${'a'.repeat(64)}@example.com`);
    expect(result.ok).toBe(true);
  });

  it('accepts an address of exactly 254 characters', () => {
    const domain = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(60)}.com`;
    const local = 'x'.repeat(254 - 1 - domain.length);
    const result = normalizeAndValidate(`${local}@${domain}`);
    expect(result).toEqual({ ok: true, email: `${local}@${domain}`, domain });
  });

  it('prefers too_long over syntax when the input is both', () => {
    expect(normalizeAndValidate('a'.repeat(400))).toEqual({
      ok: false,
      reason: 'too_long',
    });
  });

  it('measures length after trimming', () => {
    const padded = `${' '.repeat(300)}user@example.com${' '.repeat(300)}`;
    expect(normalizeAndValidate(padded)).toEqual({
      ok: true,
      email: 'user@example.com',
      domain: 'example.com',
    });
  });

  it('reports syntax for malformed addresses', () => {
    for (const bad of [
      'nope',
      'user@',
      '@example.com',
      'a@b@c.com',
      'user@example',
      'user..name@example.com',
      'user name@example.com',
      'user@example.com\nBcc: victim@example.com',
    ]) {
      expect(normalizeAndValidate(bad)).toEqual({ ok: false, reason: 'syntax' });
    }
  });

  it('agrees with isValidEmailSyntax on the normalized form', () => {
    const samples = ['User@Example.com', ' a@b.co ', 'bad', 'user@example', ''];
    for (const sample of samples) {
      const result = normalizeAndValidate(sample);
      expect(result.ok).toBe(isValidEmailSyntax(normalizeEmail(sample)));
    }
  });

  it('narrows correctly for TypeScript consumers', () => {
    const result = normalizeAndValidate('user@example.com');
    if (result.ok) {
      expect(result.email).toBe('user@example.com');
      expect(result.domain).toBe('example.com');
    } else {
      throw new Error('expected ok');
    }
  });
});
