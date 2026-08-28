"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DashboardCandidateKind } from "@/lib/dashboard-relevance";
import { witnessedNowMotion } from "@/lib/dashboard-motion";
import { microMotionPlan } from "@/lib/micro-motion";
import { usePrefersReducedMotion } from "@/components/usePrefersReducedMotion";
import CandidateKindGlyph from "./CandidateKindGlyph";

export interface NowStripCard {
  id: string;
  // The candidate's kind, for its glyph. The strip is still a PLACER: this is the
  // same value the wrapper already publishes as `data-kind`, not a second opinion
  // about what the card says.
  kind: DashboardCandidateKind;
  node: ReactNode;
}

// The Now strip's CARDS — the one client component on the dashboard's placement
// canvas, and it exists for exactly one reason: only the client knows whether a
// change was WITNESSED (#3253 decision 4).
//
// The cards themselves are still server-rendered and passed through untouched. What
// this owns is the band's layout, the kind glyph's gutter, and the single question
// the server cannot answer — did this card arrive in front of the viewer, or did it
// simply turn up in a page they came back to?
//
// The decision is `witnessedNowMotion` (lib/dashboard-motion.ts), kept pure and unit
// tested; this component only supplies the three observations it needs. Two of them
// are wired here and one is currently DORMANT: nothing refreshes this page in place
// yet, so `hiddenSinceLast` cannot be true at the moment a diff lands. #3075's silent
// refresh is what makes it reachable, and the listener is here now so that refresh
// arrives quiet by construction rather than needing this argued again.
//
// The glyph gutter is deliberately BESIDE the card rather than inside it: the cards
// are heterogeneous server components with their own headers and controls, and a
// badge dropped into a corner would land on top of one of them.
//
// AND THAT GUTTER IS DESKTOP-ONLY (#3459 item 3). On a 390px line it reads as a
// stray icon floating in the left margin and costs every card ~24px of width, so
// below `sm` it is not shown and the card's own leading icon carries the eye —
// every Now-capable card already opens with one INSIDE its frame (DOMAIN_ICON in
// DashboardAttentionAtom, the cockpit's IconVirus). A fold-in was considered and
// rejected: a corner overlay collides with exactly those leading icons, and a
// card-header slot would reverse #3253's no-prop decision for a decorative mark.
// Ahead is untouched at every width — its glyph already rides inline in the member
// row, which IS the folded-in form.
export default function NowCards({
  cards,
  bootstrapClaim = false,
}: {
  cards: readonly NowStripCard[];
  /**
   * Standing's attention tier is holding a cold-start claim — a family that has
   * never recorded, asking to be connected or logged for the first time (#3548).
   * Then an empty Now is not a settled day, and "Nothing needs you." would be
   * false: the getting-started list on the same page is what needs them.
   */
  bootstrapClaim?: boolean;
}) {
  const reduceMotion = usePrefersReducedMotion();
  const plan = microMotionPlan("promote", reduceMotion);
  // The ids as ONE string, so the effect below can depend on the card set itself
  // rather than on an array literal that is new on every render. Candidate ids never
  // contain a newline (they are `domain.fact:key` shapes), so the join round-trips.
  const idsKey = cards.map((card) => card.id).join("\n");
  const [motion, setMotion] = useState<{
    animate: ReadonlySet<string>;
    emptyArrived: boolean;
  }>({ animate: new Set(), emptyArrived: false });

  // Whether the document went away between two renders. Read at the moment a change
  // lands and then cleared — a resume must not silence the NEXT promotion too.
  const hiddenSince = useRef(false);
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") hiddenSince.current = true;
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  // `previous` starts null and STAYS null through the first effect run, which is what
  // makes the first paint quiet: a page that just loaded has no "before" the viewer
  // saw, so a reload and a resume-by-navigation both land with nothing animating.
  const previous = useRef<string[] | null>(null);
  useEffect(() => {
    const next = idsKey === "" ? [] : idsKey.split("\n");
    const verdict = witnessedNowMotion({
      previous: previous.current,
      next,
      hiddenSinceLast: hiddenSince.current,
      pageVisible: document.visibilityState === "visible",
      reduceMotion,
    });
    previous.current = next;
    hiddenSince.current = false;
    setMotion({
      animate: new Set(verdict.animate),
      emptyArrived: verdict.emptyArrived,
    });
  }, [idsKey, reduceMotion]);

  if (cards.length === 0)
    return bootstrapClaim ? null : (
      <p
        data-testid="now-strip-empty"
        data-motion={motion.emptyArrived ? "promote" : undefined}
        className={`text-sm text-slate-600 dark:text-slate-300 ${
          motion.emptyArrived ? plan.className : ""
        }`}
      >
        Nothing needs you.
      </p>
    );

  return (
    <div className="grid min-w-0 grid-cols-1 items-start gap-2 sm:gap-3">
      {cards.map((card) => {
        const animating = motion.animate.has(card.id);
        return (
          <div
            key={card.id}
            data-testid={`now-strip-card-${card.id}`}
            // The attribute, not the class, is what a spec reads — it mirrors the
            // class exactly, so a reduced-motion viewer (who gets no class) also gets
            // no attribute, and "nothing animated" is one assertion rather than a
            // guess about computed styles.
            data-motion={animating ? "promote" : undefined}
            className={`flex min-w-0 items-start gap-2 ${
              animating ? plan.className : ""
            }`}
          >
            <CandidateKindGlyph
              kind={card.kind}
              className="mt-1 hidden h-4 w-4 shrink-0 text-slate-500 sm:block dark:text-slate-400"
            />
            <div className="min-w-0 flex-1">{card.node}</div>
          </div>
        );
      })}
    </div>
  );
}
