"use client";

import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { DashboardPlacement } from "@/lib/dashboard-relevance";
import { witnessedNowMotion } from "@/lib/dashboard-motion";
import { microMotionPlan } from "@/lib/micro-motion";
import { usePrefersReducedMotion } from "@/components/usePrefersReducedMotion";
import Avatar, { type AvatarProfile } from "@/components/Avatar";
import {
  DashboardFactRow,
  type DashboardStandingPresentation,
} from "./DashboardStandingCluster";

/**
 * THE SUBJECT A CLUSTER OF NOW ROWS IS ABOUT (#4752 item 6). Present on every row
 * only when Now holds more than one subject; absent throughout otherwise, which is
 * how a single-subject Now renders no labels at all rather than one redundant one.
 */
export interface NowSubjectLabel {
  key: string;
  profile: AvatarProfile;
  /** "You" for the viewer, the disambiguated display name for anyone else. */
  name: string;
}

export interface NowStripRow {
  id: string;
  subject?: NowSubjectLabel;
  candidate?: DashboardPlacement["candidate"];
  presentation?: DashboardStandingPresentation;
  /**
   * THE ONE ENTRY THAT IS NOT A FACT: the illness cockpit group, a running SITUATION
   * with its own accordion and controls, standing where its first episode placed. It
   * is listed here rather than hoisted above the band so the strip keeps the RANKER's
   * order — an episode safety fact that outranks it must still print first.
   */
  node?: ReactNode;
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
  const idsKey = rows.map((row) => row.id).join("\n");
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
      {rows.map((row, index) => {
        const animating = motion.animate.has(row.id);
        // THE LABEL IS THE CLUSTER'S FIRST ROW'S (#4752 item 6). The ranker already
        // gathered each subject's rows together, so a change of subject between two
        // adjacent rows IS the group boundary — nothing here re-groups, and a row
        // carrying no subject prints no label however its neighbours are ordered.
        const opensGroup =
          row.subject != null &&
          row.subject.key !== rows[index - 1]?.subject?.key;
        const header = opensGroup ? (
          <li
            key={`${row.id}:subject`}
            data-testid="now-subject-label"
            data-subject={row.subject!.key}
            // The deliberate gap: a cluster after the first stands off from the one
            // above it, so the viewer's own rows read as their own group rather than
            // as more of a child's illness.
            className={`flex items-center gap-2 border-t border-(--divider) px-4 pt-4 pb-1 first:border-t-0 ${
              index === 0 ? "" : "mt-2"
            }`}
          >
            <Avatar profile={row.subject!.profile} size="sm" />
            <span className="section-label">{row.subject!.name}</span>
          </li>
        ) : null;
        const rowClass = `relative border-t border-(--divider) px-4 py-3 first:border-t-0 ${
          animating ? plan.className : ""
        }`;
        if (!row.candidate || !row.presentation)
          // NO ROW GUTTER for the cockpit: it is not a fact with a label and a facts
          // column, it is a whole interactive surface, and it spends its own gutter.
          // Giving it the row's as well would step its text 16px off the rag every
          // other entry on the page sits on.
          return (
            <Fragment key={row.id}>
              {header}
              <li
                data-testid="dashboard-illness-group"
                data-motion={animating ? "promote" : undefined}
                className={`relative border-t border-(--divider) first:border-t-0 ${
                  animating ? plan.className : ""
                }`}
              >
                {row.node}
              </li>
            </Fragment>
          );
        return (
          <Fragment key={row.id}>
            {header}
            <DashboardFactRow
            candidate={row.candidate}
            presentation={row.presentation}
            lane="now"
            // The attribute, not the class, is what a spec reads — it mirrors the
            // class exactly, so a reduced-motion viewer (who gets no class) also gets
            // no attribute, and "nothing animated" is one assertion rather than a
            // guess about computed styles. The row's own box is also the door's rail
            // (`relative`), as it is in the tail.
              data-motion={animating ? "promote" : undefined}
              className={rowClass}
            />
          </Fragment>
        );
      })}
    </ul>
  );
}
