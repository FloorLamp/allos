"use client";

import { useEffect, useState } from "react";

// Sticky in-page jump-nav for the Profile tab (#928). The Profile tab groups its
// cards into titled <section id> blocks; this renders one anchor link per section so
// a long form is navigable without sub-tabs (decided over sub-tabs in #928). Plain
// `#id` anchors so jumping works without JS; an IntersectionObserver highlights the
// section currently in view. ONE component rendered on every viewport (the
// SidebarContent rule) — sticky on wide screens, a horizontal scroll strip on narrow.
export type AnchorSection = { id: string; label: string };

export default function ProfileAnchorNav({
  sections,
}: {
  sections: readonly AnchorSection[];
}) {
  const [active, setActive] = useState<string>(sections[0]?.id ?? "");

  useEffect(() => {
    const els = sections
      .map((s) => document.getElementById(s.id))
      .filter((e): e is HTMLElement => e != null);
    if (els.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-20% 0px -70% 0px" }
    );
    for (const el of els) observer.observe(el);
    return () => observer.disconnect();
  }, [sections]);

  return (
    <nav
      className="mb-6 flex gap-2 overflow-x-auto sm:mb-0 sm:flex-col sm:gap-1"
      aria-label="Profile sections"
      data-testid="profile-anchor-nav"
    >
      {sections.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          data-testid={`anchor-${s.id}`}
          className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium ${
            active === s.id
              ? "bg-brand-600 text-white"
              : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-ink-750"
          }`}
        >
          {s.label}
        </a>
      ))}
    </nav>
  );
}
