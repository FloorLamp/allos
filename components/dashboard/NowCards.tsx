"use client";

import { useEffect, useRef, useState } from "react";
import type { DashboardPlacement } from "@/lib/dashboard-relevance";
import { witnessedNowMotion } from "@/lib/dashboard-motion";
import { microMotionPlan } from "@/lib/micro-motion";
import { usePrefersReducedMotion } from "@/components/usePrefersReducedMotion";
import {
  DashboardFactRow,
  type DashboardStandingPresentation,
} from "./DashboardStandingCluster";

export interface NowStripRow {
  candidate: DashboardPlacement["candidate"];
  presentation: DashboardStandingPresentation;
}

// THE NOW STRIP'S ROWS — the one client component on the dashboard's placement
// canvas, and it exists for exactly one reason: only the client knows whether a
// change was WITNESSED (#3253 decision 4).
//
// SINCE #4076 NOW IS ROWS LIKE EVERY OTHER ZONE. It renders through the shared
// `DashboardFactRow` rather than placing heterogeneous cards, so what it owns is the
// band's stacking and the single question the server cannot answer — did this row
// arrive in front of the viewer, or did it simply turn up in a page they came back
// to? The kind glyph that used to ride in its gutter is gone with the cards: the
// label column carries identity, and a row's kind stays legible from its shape (a
// control means action, a bare value means reading).
//
// A row's `control` is built on the SERVER and passed through as a node, exactly as
// the card `node` was: this boundary carries the write, it does not re-implement it.
//
// The decision is `witnessedNowMotion` (lib/dashboard-motion.ts), kept pure and unit
// tested; this component only supplies the three observations it needs. Two of them
// are wired here and one is currently DORMANT: nothing refreshes this page in place
// yet, so `hiddenSinceLast` cannot be true at the moment a diff lands. #3075's silent
// refresh is what makes it reachable, and the listener is here now so that refresh
// arrives quiet by construction rather than needing this argued again.
export default function NowCards({
  rows,
  bootstrapClaim = false,
}: {
  rows: readonly NowStripRow[];
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
  // The ids as ONE string, so the effect below can depend on the row set itself
  // rather than on an array literal that is new on every render. Candidate ids never
  // contain a newline (they are `domain.fact:key` shapes), so the join round-trips.
  const idsKey = rows.map((row) => row.candidate.candidateId).join("\n");
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

  if (rows.length === 0)
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
    <ul className="band flex min-w-0 flex-col overflow-hidden rounded-xl border border-(--border) bg-surface">
      {rows.map((row) => {
        const animating = motion.animate.has(row.candidate.candidateId);
        return (
          <DashboardFactRow
            key={row.candidate.candidateId}
            candidate={row.candidate}
            presentation={row.presentation}
            lane="now"
            // The attribute, not the class, is what a spec reads — it mirrors the
            // class exactly, so a reduced-motion viewer (who gets no class) also gets
            // no attribute, and "nothing animated" is one assertion rather than a
            // guess about computed styles. The row's own box is also the door's rail
            // (`relative`), as it is in the tail.
            data-motion={animating ? "promote" : undefined}
            className={`relative border-t border-(--divider) px-4 py-3 first:border-t-0 ${
              animating ? plan.className : ""
            }`}
          />
        );
      })}
    </ul>
  );
}
