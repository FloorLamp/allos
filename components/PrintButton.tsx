"use client";

import { IconPrinter } from "@tabler/icons-react";
import { printRegion, type PrintRegion } from "@/components/print-scope";

// THE APP'S ONE PRINT ACTION (#3752). There were three copies of this markup —
// the public episode share view's (issue #801), the Passport's emergency card,
// and the Passport summary's own — differing only in what they asked the browser
// to print. That difference is now the single typed prop below, so a new print
// surface picks a scope rather than a paint.
//
// Client-only so it can call the print API; `print:hidden` keeps the control off
// the page it just printed.
export default function PrintButton({
  label = "Print",
  // Omitted prints the PAGE, which is what a route built solely to be printed
  // wants. Naming a region prints only that region and leaves the other print
  // artifacts on the same route out (components/print-scope.ts); the type is the
  // closed set of regions the print stylesheet actually knows about, so a scope
  // that would silently print everything cannot be spelled.
  region,
}: {
  label?: string;
  region?: PrintRegion;
}) {
  return (
    <button
      type="button"
      className="btn-ghost print:hidden"
      onClick={() => (region ? printRegion(region) : window.print())}
    >
      <IconPrinter className="h-4 w-4" stroke={1.75} />
      {label}
    </button>
  );
}
