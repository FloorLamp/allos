"use client";

import { useEffect, useRef } from "react";
import OfferControls from "@/components/OfferControls";
import {
  acceptOffer,
  declineOffer,
  markOfferSeen,
} from "@/app/(app)/offer-actions";

// The IN-PLACE surface of one offer family (issue #4840, ruling 2): the question and
// its two answers, on the row or card the person just used. Copy and key arrive as
// props from the server page, which read them off the registry — this component
// must not import lib/offers.ts, which reads the database.
//
// IGNORING IS AN ANSWER. The offer renders once and disappears on Yes, on No, or on
// the next visit if it was left alone, so seeing it has to be recorded. The write
// fires from a mount effect rather than during the server render (the shape
// components/MarkWhatsNewSeen.tsx established: a render must not write), and it
// fires only once the offer is actually VISIBLE — the Telegram card is a collapsed
// disclosure on most visits, and marking an offer asked from inside a closed fold
// would be a lie about what the person saw. A fold that opens later fires it then.
// The mark does not revalidate, so the offer stays where it is until navigation.
export default function OfferInPlace({
  dedupeKey,
  familyId,
  question,
  yes,
  no,
}: {
  dedupeKey: string;
  familyId: string;
  question: string;
  yes: string;
  no: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const seen = useRef(false);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const mark = () => {
      if (seen.current) return;
      seen.current = true;
      const fd = new FormData();
      fd.set("dedupe_key", dedupeKey);
      // Fire-and-forget: a failed mark just means the offer is seen once more.
      void markOfferSeen(fd).catch(() => {});
    };
    const fold = el.closest("details");
    if (!fold || fold.open) {
      mark();
      return;
    }
    const onToggle = () => {
      if (fold.open) mark();
    };
    fold.addEventListener("toggle", onToggle);
    return () => fold.removeEventListener("toggle", onToggle);
  }, [dedupeKey]);

  return (
    <div
      ref={root}
      data-testid={`offer-${familyId}`}
      className="flex flex-wrap items-center gap-2 rounded-xl border border-black/10 bg-slate-50/60 p-3 text-sm dark:border-white/10 dark:bg-ink-850/40"
    >
      <span className="font-medium text-slate-800 dark:text-slate-100">
        {question}
      </span>
      <OfferControls
        dedupeKey={dedupeKey}
        accept={{ label: yes, testId: `offer-accept-${familyId}` }}
        decline={{ label: no, testId: `offer-decline-${familyId}` }}
        acceptAction={acceptOffer}
        declineAction={declineOffer}
        outcomeTestId={`offer-outcome-${familyId}`}
      />
    </div>
  );
}
