"use client";

import { IconPrinter } from "@tabler/icons-react";

// Small client control so the server-rendered /emergency page can offer a Print
// button (window.print() needs the browser). Hidden from the printout itself.
export default function EmergencyPrintButton() {
  return (
    <button
      type="button"
      className="btn-ghost print:hidden"
      onClick={() => window.print()}
    >
      <IconPrinter className="h-4 w-4" stroke={1.75} />
      Print
    </button>
  );
}
