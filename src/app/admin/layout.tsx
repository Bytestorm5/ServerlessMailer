import Link from 'next/link';
import { currentAdmin } from '@/lib/auth';
import { LogoutButton } from './logout-button';

const NAV = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/campaigns', label: 'Campaigns' },
  { href: '/admin/subscribers', label: 'Subscribers' },
  { href: '/admin/suppressions', label: 'Suppressions' },
  { href: '/admin/import', label: 'Import' },
  { href: '/admin/lists', label: 'Lists' },
  { href: '/admin/system', label: 'System' },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await currentAdmin();

  return (
    <div className="min-h-screen">
      <header className="border-b border-ink-200 bg-white">
        <div className="mx-auto flex max-w-[1400px] items-center gap-6 px-6 py-3">
          <Link href="/admin" className="text-sm font-semibold tracking-tight">
            ServerlessMailer
          </Link>
          <nav className="flex flex-wrap items-center gap-1">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded px-2.5 py-1.5 text-sm text-ink-600 transition hover:bg-ink-100 hover:text-ink-900"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm text-ink-500">
            <span className="hidden sm:inline">{admin?.email}</span>
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-6 py-8">{children}</main>
    </div>
  );
}
