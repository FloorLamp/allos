import Link from "next/link";
import { IconHistory, IconChevronRight } from "@tabler/icons-react";
import { doseLedgerHref } from "@/lib/hrefs";
import type { IntakeItemKind } from "@/lib/types";

// The door to the cross-item dose ledger (#2417), rendered by both intake surfaces.
//
// Dose history used to be reachable ONLY through an item's ⋯ menu, which made "what
// did I actually take last week, across items" cost one navigation per item. This is
// the one-click entry the acceptance criterion names; `doseLedgerHref` decides which
// of the two doors this surface's kind opens (the same kind→surface seam as
// `intakeHref`).
//
// Never icon-only: the glyph is `aria-hidden` beside real text.
export default function DoseLedgerLink({
  kind,
  className = "",
}: {
  kind: IntakeItemKind;
  className?: string;
}) {
  return (
    <Link
      href={doseLedgerHref(kind)}
      data-testid="dose-ledger-link"
      title="Dose history"
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-sm font-medium text-brand-600 hover:underline dark:text-brand-400 ${className}`}
    >
      <IconHistory aria-hidden className="h-4 w-4 shrink-0" stroke={1.75} />
      Dose history
      <IconChevronRight
        aria-hidden
        className="h-4 w-4 shrink-0"
        stroke={1.75}
      />
    </Link>
  );
}
