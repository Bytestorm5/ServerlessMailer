import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads `.env.local` then `.env` for CLI scripts.
 *
 * Next.js does this for the app; scripts run outside it and would otherwise
 * fail on a missing MONGODB_URI with no useful explanation.
 */
export function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    const path = resolve(process.cwd(), file);
    if (!existsSync(path)) continue;
    try {
      process.loadEnvFile(path);
    } catch {
      // Node < 20.12 has no loadEnvFile; the variables must then come from the
      // shell, which is how CI and Vercel supply them anyway.
    }
  }
}
