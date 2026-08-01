import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ServerlessMailer',
  description: 'Self-hosted newsletter platform',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-full font-sans">{children}</body>
    </html>
  );
}
