"use client";

import { useState, type ReactNode } from "react";

// The "show all N" disclosure for TrendingDigest's movers (#1455 B).
//
// The digest ranks its movers already, so the card leads with the top three and
// keeps the rest one tap away instead of spending ~550px of phone screen on seven
// tall chips above the charts the page exists to show.
//
// It renders a FRAGMENT, not a wrapper: the hidden chips and the toggle are
// siblings of the visible chips inside the card's `flex flex-wrap` row, so the
// revealed chips flow into that same row rather than into a nested block.
// `children` are the already-server-rendered overflow chips (each carrying its own
// dismiss Server Action form), passed through untouched.
export default function DigestOverflow({
  total,
  children,
}: {
  total: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {open && children}
      <button
        type="button"
        data-testid="digest-show-all"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="rounded-full border border-dashed border-slate-300 px-3 py-1 text-sm font-medium text-slate-500 transition hover:border-brand-400 hover:text-brand-700 dark:border-white/15 dark:text-slate-400 dark:hover:text-brand-300"
      >
        {open ? "Show fewer" : `Show all ${total}`}
      </button>
    </>
  );
}
