import { config } from '@/lib/config';
import { logger } from '@/lib/logging';

/**
 * Optional Cloudflare Turnstile verification for the signup form (spec §5.1
 * step 2). Behind a seam so tests never touch the network.
 */

export type TurnstileVerifier = (token: string, ip?: string) => Promise<boolean>;

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

/**
 * `remoteip` is optional, so a value we are not sure about is better dropped
 * than sent: callers that could not determine the client address pass a
 * sentinel like `'unknown'`, and Cloudflare is entitled to reject the whole
 * request as malformed rather than ignore the field.
 */
function looksLikeIp(value: string): boolean {
  return IPV4.test(value) || (value.includes(':') && IPV6.test(value));
}

function errorCodesOf(result: unknown): string[] {
  const codes = (result as { 'error-codes'?: unknown } | null)?.['error-codes'];
  return Array.isArray(codes) ? codes.map(String) : [];
}

const defaultVerifier: TurnstileVerifier = async (token, ip) => {
  const secret = config.turnstileSecret();
  if (!secret) return true;

  try {
    const response = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret,
        response: token,
        ...(ip && looksLikeIp(ip) ? { remoteip: ip } : {}),
      }).toString(),
    });
    const result = (await response.json()) as { success?: boolean } | null;
    if (result?.success === true) return true;

    // Cloudflare's error codes are the only thing that distinguishes a
    // misconfigured deployment from a bot, and a rejection is otherwise
    // indistinguishable from ordinary abuse at every layer above:
    //   invalid-input-secret   — TURNSTILE_SECRET_KEY is wrong or has stray
    //                            whitespace
    //   invalid-input-response — the token was minted by a *different* widget,
    //                            i.e. the site key and this secret are not a pair
    //   timeout-or-duplicate   — the token is over 300s old or already spent
    // They name no secret and no address, so they are safe to log verbatim.
    logger.warn('turnstile rejected the token', {
      status: response.status,
      errorCodes: errorCodesOf(result),
    });
    return false;
  } catch (err) {
    // Fail closed: an unreachable Turnstile must not become an open door.
    logger.warn('turnstile verification failed', { error: (err as Error).message });
    return false;
  }
};

let verifier: TurnstileVerifier = defaultVerifier;

export function setTurnstileVerifier(next: TurnstileVerifier): void {
  verifier = next;
}

export function resetTurnstileVerifier(): void {
  verifier = defaultVerifier;
}

/** Returns true when Turnstile is not configured, so it stays strictly opt-in. */
export async function verifyTurnstile(
  token: string | undefined,
  ip?: string,
): Promise<boolean> {
  if (!config.turnstileSecret()) return true;
  // Trimmed for the same reason as the secret: Cloudflare compares the token
  // exactly, and a form-encoded submission can carry padding the browser never
  // put there.
  const trimmed = token?.trim();
  if (!trimmed) return false;
  return verifier(trimmed, ip);
}
