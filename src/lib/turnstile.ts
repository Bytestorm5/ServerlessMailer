import { env } from './env';
import { log } from './logger';

/** Optional Cloudflare Turnstile verification for the signup form (§5.1). */
export async function verifyTurnstile(token: string | undefined, ip: string): Promise<boolean> {
  const secret = env.turnstileSecretKey;
  if (!secret) return true; // Not configured — the honeypot and rate limits stand alone.
  if (!token) return false;

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
    });
    const result = (await response.json()) as { success?: boolean };
    return result.success === true;
  } catch (error) {
    log.warn('turnstile verification failed', { error: String(error) });
    return false;
  }
}
