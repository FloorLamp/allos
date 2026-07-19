"use client";

import { IconPrinter } from "@tabler/icons-react";
import { printRegion } from "@/components/print-scope";

// Small client control so the server-rendered emergency-card section of the
// Passport page (/profile#emergency) can offer a Print button (window.print()
// needs the browser). Scoped to the emergency region (#1042 phase 3): the
// passport summary above it on the same page is dropped from the printout.
// Hidden from the printout itself.
export default function EmergencyPrintButton() {
  return (
    <button
      type="button"
      className="btn-ghost print:hidden"
      onClick={() => printRegion("emergency")}
    >
      <IconPrinter className="h-4 w-4" stroke={1.75} />
      Print
    </button>
  );
}
