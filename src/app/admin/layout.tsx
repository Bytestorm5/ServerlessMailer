import { requireAdminPage } from '@/lib/auth-server';
import { NavLink } from '@/components/admin/NavLink';
import { ThemeToggle } from '@/components/ThemeToggle';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdminPage();

  return (
    <div className="sm-shell">
      <nav className="sm-nav">
        <h1>
          <span className="sm-brand-dot" aria-hidden />
          ServerlessMailer
        </h1>
        <NavLink href="/admin" exact>
          Dashboard
        </NavLink>
        <NavLink href="/admin/lists">Lists</NavLink>
        <NavLink href="/admin/campaigns">Campaigns</NavLink>
        <NavLink href="/admin/templates">Templates</NavLink>
        <NavLink href="/admin/subscribers">Subscribers</NavLink>
        <NavLink href="/admin/suppressions">Suppressions</NavLink>
        <NavLink href="/admin/import">Import &amp; export</NavLink>
        <div className="sm-nav-foot">
          <ThemeToggle />
        </div>
      </nav>
      <main className="sm-main">{children}</main>
    </div>
  );
}
