import DestinationLink from "@/components/DestinationLink";
import { EPISODES_HREF } from "@/lib/hrefs";

// Calm access to merged household illness history. The dashboard places this typed
// login-scoped context in Show everything; it is not a finding, send, or write.
export default function HouseholdHistoryPromoLink() {
  return (
    <DestinationLink
      href={EPISODES_HREF}
      data-testid="household-history-promo"
      className="inline-flex items-center gap-2 text-sm font-medium text-sky-700 hover:underline dark:text-sky-300"
    >
      Episodes &amp; visits
    </DestinationLink>
  );
}
