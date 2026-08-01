import type { SesAdapter } from '@/lib/ses/types';

/**
 * Indirection so every send path resolves its SES adapter at call time.
 * Tests swap in a fake; production lazily constructs the AWS-backed adapter.
 */
let override: SesAdapter | undefined;
let cachedReal: Promise<SesAdapter> | undefined;

export function setSesAdapter(adapter: SesAdapter | undefined): void {
  override = adapter;
}

export async function getSesAdapter(): Promise<SesAdapter> {
  if (override) return override;
  // The *promise* is memoised, not its result. Caching the resolved adapter
  // would let concurrent cold calls all get past the check before any of them
  // awaited the import, each building its own SESv2Client.
  if (!cachedReal) {
    cachedReal = import('@/lib/ses/aws').then((module) => module.createAwsSesAdapter());
  }
  return cachedReal;
}

/** Test hook: forget the memoised production adapter. */
export function resetSesAdapter(): void {
  override = undefined;
  cachedReal = undefined;
}
