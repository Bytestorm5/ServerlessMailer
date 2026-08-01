import { Suspense } from 'react';
import { PreferencesForm } from './preferences-form';

export default function PreferencesPage() {
  return (
    <Suspense fallback={<p className="text-center text-ink-500">Loading…</p>}>
      <PreferencesForm mode="preferences" />
    </Suspense>
  );
}
