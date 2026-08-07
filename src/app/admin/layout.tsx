import {
  ArrowDownUp,
  Ban,
  LayoutDashboard,
  LayoutTemplate,
  Mails,
  Send,
  Users,
} from 'lucide-react';
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
          <LayoutDashboard aria-hidden />
          Dashboard
        </NavLink>
        <NavLink href="/admin/lists">
          <Mails aria-hidden />
          Lists
        </NavLink>
        <NavLink href="/admin/campaigns">
          <Send aria-hidden />
          Campaigns
        </NavLink>
        <NavLink href="/admin/templates">
          <LayoutTemplate aria-hidden />
          Templates
        </NavLink>
        <NavLink href="/admin/subscribers">
          <Users aria-hidden />
          Subscribers
        </NavLink>
        <NavLink href="/admin/suppressions">
          <Ban aria-hidden />
          Suppressions
        </NavLink>
        <NavLink href="/admin/import">
          <ArrowDownUp aria-hidden />
          Import &amp; export
        </NavLink>
        <div className="sm-nav-foot">
          <ThemeToggle />
        </div>
      </nav>
      <main className="sm-main">{children}</main>
    </div>
  );
}
