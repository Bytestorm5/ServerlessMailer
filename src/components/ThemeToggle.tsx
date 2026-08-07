'use client';

import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';

/**
 * Light / system / dark switcher. The choice is stored in localStorage and
 * applied as `data-theme` on <html>; "system" removes the attribute so the
 * `prefers-color-scheme` rules in globals.css take over. The root layout's
 * inline script applies the stored choice before first paint.
 */

export type ThemePreference = 'light' | 'system' | 'dark';

export const THEME_STORAGE_KEY = 'sm-theme';

const OPTIONS: Array<{ value: ThemePreference; label: string; icon: React.ReactNode }> = [
  { value: 'light', label: 'Light theme', icon: <Sun aria-hidden /> },
  { value: 'system', label: 'Follow system theme', icon: <Monitor aria-hidden /> },
  { value: 'dark', label: 'Dark theme', icon: <Moon aria-hidden /> },
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
