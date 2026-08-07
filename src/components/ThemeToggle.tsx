'use client';

import { useEffect, useState } from 'react';

/**
 * Light / system / dark switcher. The choice is stored in localStorage and
 * applied as `data-theme` on <html>; "system" removes the attribute so the
 * `prefers-color-scheme` rules in globals.css take over. The root layout's
 * inline script applies the stored choice before first paint.
 */

export type ThemePreference = 'light' | 'system' | 'dark';

export const THEME_STORAGE_KEY = 'sm-theme';

const OPTIONS: Array<{ value: ThemePreference; label: string; icon: React.ReactNode }> = [
  {
    value: 'light',
    label: 'Light theme',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <circle cx="12" cy="12" r="4.5" />
        <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
      </svg>
    ),
  },
  {
    value: 'system',
    label: 'Follow system theme',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <rect x="3" y="4.5" width="18" height="12.5" rx="2" />
        <path d="M9 21h6M12 17.5V21" />
      </svg>
    ),
  },
  {
    value: 'dark',
    label: 'Dark theme',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
      </svg>
    ),
  },
];

function readStoredPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function ThemeToggle() {
  // Render "system" on the server and first client paint, then sync from
  // storage; the visual theme itself is already correct via the init script.
  const [preference, setPreference] = useState<ThemePreference>('system');

  useEffect(() => {
    setPreference(readStoredPreference());
  }, []);

  const choose = (next: ThemePreference) => {
    setPreference(next);
    const root = document.documentElement;
    if (next === 'system') {
      delete root.dataset.theme;
    } else {
      root.dataset.theme = next;
    }
    try {
      if (next === 'system') {
        window.localStorage.removeItem(THEME_STORAGE_KEY);
      } else {
        window.localStorage.setItem(THEME_STORAGE_KEY, next);
      }
    } catch {
      // Storage unavailable (private mode); the choice still applies this visit.
    }
  };

  return (
    <div className="sm-theme-toggle" role="group" aria-label="Theme">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={preference === option.value}
          aria-label={option.label}
          title={option.label}
          onClick={() => choose(option.value)}
        >
          {option.icon}
        </button>
      ))}
    </div>
  );
}
