"use client";

import { IconPrinter } from "@tabler/icons-react";

// A standalone Print button for the public episode share view (issue #801). Client-only
// so it can call window.print(); `print:hidden` keeps it off the printed page.
export default function PrintButton({ label = "Print" }: { label?: string }) {
  return (
    <button
      type="button"
      className="btn-ghost print:hidden"
      onClick={() => window.print()}
    >
      <IconPrinter className="h-4 w-4" stroke={1.75} />
      {label}
    </button>
  );
}
