/**
 * Address normalization and syntax validation (§4.3, §5.1).
 *
 * Normalization is deliberately conservative: trim and lowercase, nothing else.
 * In particular dots and plus-addressing are **preserved**. `a+news@gmail.com`
 * and `a@gmail.com` are two different people to most providers, and folding
 * them together silently loses a subscriber and, worse, sends mail to an
 * address that never consented.
 *
 * Validation is deliberately strict: an address that reaches SES must be one
 * SES can deliver to. A malformed address costs a bounce, and bounces are
 * measured against an account-level threshold (§8.3).
 */

/** RFC 5321 length limits. */
const MAX_ADDRESS_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;
const MAX_DOMAIN_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

/**
 * RFC 5322 `atext`, plus `.` as a separator. Quoted local parts (`"a b"@x.com`)
 * are legal on paper and unsupported everywhere that matters, so they are
 * rejected — as is anything outside this set, which is what keeps a newline or
 * a comma from ever reaching a header (§12).
 */
const LOCAL_ATOM = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN_LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/;
/**
 * The last label must look like a real TLD: letters only, or a punycode label
 * such as `xn--p1ai` (`.рф`). This is what rejects `user@localhost` and
 * `user@192.168.0.1`, neither of which can carry an MX record we would trust.
 */
const TLD = /^(?:[A-Za-z]{2,}|xn--[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)$/;

/** Trim and lowercase. Nothing else — see the module note on plus-addressing. */
export function normalizeEmail(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase();
}

/**
 * True when `domain` is a syntactically usable, ASCII, fully-qualified domain
 * name. Shared with the MX lookup so a hostile string never reaches a resolver.
 */
export function isValidDomain(domain: string): boolean {
  if (typeof domain !== 'string') return false;
  if (domain.length === 0 || domain.length > MAX_DOMAIN_LENGTH) return false;
  // Rejects leading/trailing dots and consecutive dots in one step: a split on
  // '.' yields an empty label for each of those cases.
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH) return false;
    if (!DOMAIN_LABEL.test(label)) return false;
  }
  return TLD.test(labels[labels.length - 1]);
}

/**
 * Syntax only — no DNS. Expects an already-normalized address: a leading space
 * or an uppercase-only difference is not "fixed" here, because the caller that
 * skipped normalization has a bug worth surfacing.
 */
export function isValidEmailSyntax(email: string): boolean {
  if (typeof email !== 'string') return false;
  if (email.length === 0 || email.length > MAX_ADDRESS_LENGTH) return false;

  const at = email.indexOf('@');
  // Exactly one '@', with something on each side.
  if (at <= 0 || at !== email.lastIndexOf('@') || at === email.length - 1) return false;

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  if (local.length > MAX_LOCAL_LENGTH) return false;

  // Leading, trailing and consecutive dots all produce an empty atom.
  for (const atom of local.split('.')) {
    if (atom.length === 0 || !LOCAL_ATOM.test(atom)) return false;
  }

  return isValidDomain(domain);
}

/** The domain part of an address, lowercased, or `''` when it is not valid. */
export function emailDomain(email: string): string {
  const result = normalizeAndValidate(email);
  return result.ok ? result.domain : '';
}

export type EmailCheck =
  | { ok: true; email: string; domain: string }
  | { ok: false; reason: 'empty' | 'syntax' | 'too_long' };

/**
 * The single entry point for accepting an address from the outside world.
 * Length is judged after trimming, and reported separately from syntax so the
 * import reporter (§4.3) can tell an operator *why* a row was rejected.
 */
export function normalizeAndValidate(raw: string): EmailCheck {
  const email = normalizeEmail(raw);
  if (email.length === 0) return { ok: false, reason: 'empty' };
  if (email.length > MAX_ADDRESS_LENGTH) return { ok: false, reason: 'too_long' };

  const at = email.indexOf('@');
  if (at > 0 && at === email.lastIndexOf('@') && at < email.length - 1) {
    if (at > MAX_LOCAL_LENGTH) return { ok: false, reason: 'too_long' };
  }

  if (!isValidEmailSyntax(email)) return { ok: false, reason: 'syntax' };

  return { ok: true, email, domain: email.slice(at + 1) };
}
