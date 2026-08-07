'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * A sidebar link that knows when it is the current page, so the nav's
 * `aria-current` styling actually lights up. `exact` is for the dashboard,
 * whose href (/admin) is a prefix of every other admin route.
 */
export function NavLink({
  href,
  exact = false,
  children,
}: {
  href: string;
  exact?: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link href={href} aria-current={active ? 'page' : undefined}>
      {children}
    </Link>
  );
}
