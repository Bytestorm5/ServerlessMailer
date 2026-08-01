import { config } from '@/lib/config';
import { logger } from '@/lib/logging';

/**
 * Optional Cloudflare Turnstile verification for the signup form (spec §5.1
 * step 2). Behind a seam so tests never touch the network.
 */

export type TurnstileVerifier = (token: string, ip?: string) => Promise<boolean>;

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

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
        ...(ip ? { remoteip: ip } : {}),
      }).toString(),
    });
    const result = (await response.json()) as { success?: boolean };
    return result.success === true;
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
  if (!token) return false;
  return verifier(token, ip);
}
