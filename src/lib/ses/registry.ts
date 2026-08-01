import type { SesAdapter } from '@/lib/ses/types';

/**
 * Indirection so every send path resolves its SES adapter at call time.
 * Tests swap in a fake; production lazily constructs the AWS-backed adapter.
 */
let override: SesAdapter | undefined;
let cachedReal: SesAdapter | undefined;

export function setSesAdapter(adapter: SesAdapter | undefined): void {
  override = adapter;
}

export async function getSesAdapter(): Promise<SesAdapter> {
  if (override) return override;
  if (cachedReal) return cachedReal;
  const { createAwsSesAdapter } = await import('@/lib/ses/aws');
  cachedReal = createAwsSesAdapter();
  return cachedReal;
}

/** Test hook: forget the memoised production adapter. */
export function resetSesAdapter(): void {
  override = undefined;
  cachedReal = undefined;
}
