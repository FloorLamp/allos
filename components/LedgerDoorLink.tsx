import { IconHistory } from "@tabler/icons-react";
import DestinationLink from "@/components/DestinationLink";
import type { AppRoute } from "@/lib/hrefs";

// THE DOOR TO AN EVENT LEDGER (#2417, generalized by #3671).
//
// Every logged-event surface owes the reader a way to "what did I actually record,
// across days" — and the app had two species of that door. The dose one was an icon,
// a word and a chevron; Food's was a bare right-aligned text link with none of those,
// floating in a row of its own above the fasting card. Same job, two shapes, so a
// reader who learned one did not recognise the other.
//
// This is that one shape. It is parameterized by the DESTINATION rather than by a
// domain enum: a switch inside a shared door is how the shell that #3484 unpicked
// came to know about doses, and the ledgers' hrefs already have their own helpers
// (`doseLedgerHref`, `foodLedgerHref`) that own the routing question.
//
// Never icon-only: the glyph is `aria-hidden` beside real text.
export default function LedgerDoorLink({
  href,
  label,
  testId,
  className = "",
}: {
  href: AppRoute;
  label: string;
  testId: string;
  className?: string;
}) {
  return (
    <DestinationLink
      href={href}
      data-testid={testId}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-sm text-link ${className}`}
    >
      <IconHistory aria-hidden className="h-4 w-4 shrink-0" stroke={1.75} />
      {label}
    </DestinationLink>
  );
}
