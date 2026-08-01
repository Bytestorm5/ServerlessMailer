import { Suspense } from 'react';
import { PreferencesForm } from '../preferences/preferences-form';

/**
 * The human-facing unsubscribe page (§9.3).
 *
 * Distinct from the one-click `POST` endpoint, which unsubscribes immediately
 * with no page at all. This one confirms the action, offers preferences, and
 * allows resubscribing for anyone who clicked by accident.
 */
export default function UnsubscribePage() {
  return (
    <Suspense fallback={<p className="text-center text-ink-500">Loading…</p>}>
      <PreferencesForm mode="unsubscribe" />
    </Suspense>
  );
}
