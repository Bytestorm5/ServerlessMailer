import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ServerlessMailer',
  description: 'Self-hosted newsletter platform',
  robots: { index: false, follow: false },
};

/**
 * Applies a stored theme choice before first paint so an explicit light/dark
 * preference never flashes the system theme. Kept dependency-free and inline:
 * it must run before hydration. `suppressHydrationWarning` covers the
 * data-theme attribute this script may add to <html>.
 */
const themeInitScript = `(function () {
  try {
    var theme = localStorage.getItem('sm-theme');
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.dataset.theme = theme;
    }
  } catch (e) {}
})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
