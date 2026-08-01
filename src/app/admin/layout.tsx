import Link from 'next/link';
import { requireAdminPage } from '@/lib/auth-server';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdminPage();

  return (
    <div className="sm-shell">
      <nav className="sm-nav">
        <h1>ServerlessMailer</h1>
        <Link href="/admin">Dashboard</Link>
        <Link href="/admin/lists">Lists</Link>
        <Link href="/admin/campaigns">Campaigns</Link>
        <Link href="/admin/subscribers">Subscribers</Link>
        <Link href="/admin/suppressions">Suppressions</Link>
        <Link href="/admin/import">Import &amp; export</Link>
      </nav>
      <main className="sm-main">{children}</main>
    </div>
  );
}
