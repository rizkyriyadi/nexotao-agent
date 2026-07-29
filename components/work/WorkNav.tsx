"use client";

/* The row of destinations inside the work surface. The icon rail has one entry
   for /work as a whole; these are the rooms behind that door, and every one of
   them draws the same issues from a different angle. */

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/work", label: "Items" },
  { href: "/work/cycles", label: "Cycles" },
  { href: "/work/modules", label: "Modules" },
  { href: "/work/pages", label: "Pages" },
  { href: "/work/intake", label: "Intake" },
  { href: "/work/analytics", label: "Analytics" },
];

export function WorkNav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-wrap items-center gap-1">
      {TABS.map((tab) => {
        // `/work` is a prefix of every other tab, so it matches exactly while the
        // rest match their subtree — that keeps a cycle detail page lit under
        // Cycles rather than under Items.
        const on = tab.href === "/work" ? pathname === "/work" : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={on ? "page" : undefined}
            className={`rounded-lg px-2.5 py-1 text-[12px] transition-colors ${
              on ? "bg-electric-indigo text-on-indigo" : "text-pebble hover:bg-veil hover:text-charcoal"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** The page frame every work sub-page shares: title, sub-nav, and a scrolling
 *  body. Kept here so six pages cannot drift into six different headers. */
export function WorkPage({ title, subtitle, actions, children }: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="shrink-0 px-6 pt-6">
        <p className="label text-electric-indigo">Work</p>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="font-serif text-3xl text-charcoal">{title}</h1>
          {subtitle && <span className="text-xs text-pebble">{subtitle}</span>}
          {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
        </div>
        <div className="mt-4">
          <WorkNav />
        </div>
      </header>
      <div className="scroll-thin mt-4 min-h-0 flex-1 overflow-y-auto px-6 pb-6">{children}</div>
    </main>
  );
}
