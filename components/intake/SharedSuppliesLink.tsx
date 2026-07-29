import Link from "next/link";
import { IconArchive } from "@tabler/icons-react";
import { sharedSuppliesLinkLabel } from "@/lib/refill";
import { SUPPLIES_HREF } from "@/lib/hrefs";

// The door to the household medicine cabinet (#1522).
//
// The cabinet is a physical-object REGISTRY — bottles that intake items link to —
// and #1522 moved it off the sidebar onto its consumers, the way /equipment has
// always been reached (Training's header, the activity form's picker). This is that
// door, rendered by every consumer surface: the Medications header, the Nutrition →
// Supplements header, and the Household header.
//
// STABLE, not conditional. The row it replaced was `requiresMultiProfile`, so it
// appeared unannounced the moment a second profile was added and there was no
// reliable place to learn the cabinet existed. A door that is always in the same
// spot is the point; `sharedSuppliesLinkLabel` (lib/refill.ts, pure and shared)
// decides whether it reads as a count ("3 shared bottles") or as the surface's name.
//
// Count semantics: pools the CALLER can see, per the one `isPoolVisibleTo` rule the
// /supplies page lists with — never a promise the cabinet won't keep. Resolve it at
// the page's auth boundary (countVisiblePools(scope.ids)) and pass it down; this
// component is presentational and takes no session.
//
// One component across viewports, and never icon-only: the glyph is `aria-hidden`
// beside real text, and the accessible name always carries the destination's NAME
// even when the visible label is a bare count.
export default function SharedSuppliesLink({
  count,
  className = "",
}: {
  count: number;
  className?: string;
}) {
  const label = sharedSuppliesLinkLabel(count);
  const accessibleName =
    count > 0 ? `Medicine cabinet: ${label}` : "Medicine cabinet";
  return (
    <Link
      href={SUPPLIES_HREF}
      data-testid="shared-supplies-link"
      title="Medicine cabinet"
      aria-label={accessibleName}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-sm font-medium text-brand-600 hover:underline dark:text-brand-400 ${className}`}
    >
      <IconArchive aria-hidden className="h-4 w-4 shrink-0" stroke={1.75} />
      {label} →
    </Link>
  );
}
