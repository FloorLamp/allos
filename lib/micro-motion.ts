// Shared feedback and continuity tokens. The current contract and caller rules
// live in docs/internals/micro-motion.md; app/globals.css owns the CSS half.
// Pure: no DOM, React, clock, scheduler, or runtime dispatch.

export const MICRO_MOTION_MIN_MS = 150;
export const MICRO_MOTION_MAX_MS = 300;

// ONE ease curve for the whole vocabulary, so a future surface cannot invent a
// fourth feel. Decelerating: the move arrives and settles, it never bounces back.
export const MICRO_MOTION_EASE = "cubic-bezier(0.2, 0, 0, 1)";

export interface MicroMotionDecl {
  // Milliseconds. Mirrored by a CSS custom property of the same name.
  readonly ms: number;
  // The information this motion carries — one sentence, in the user's terms.
  readonly conveys: string;
  // What states the SAME fact when the motion never plays. This is the rule-4
  // answer and it is required: a motion with no independent carrier is decoration.
  readonly carriedBy: string;
  // The reduced-motion design. Not "nothing happens" — the end state, instantly.
  readonly reducedEndState: string;
}

// Each declaration has matching CSS timing and a class. Information motions
// name the fact they convey, its independent carrier, and its reduced end state.
export const MICRO_MOTIONS = {
  settle: {
    ms: 300,
    conveys:
      "the control you tapped BECAME its done state — the row is the receipt, so the happy path needs no toast.",
    carriedBy:
      "the resolved control's own `aria-pressed`, accessible name, title and colour, all of which are already correct on the first paint after the tap.",
    reducedEndState:
      "the resolved styling lands on the same frame the state changes; no keyframe is ever scheduled.",
  },
  count: {
    ms: 250,
    conveys:
      "a QUANTITY changed, which reads differently from a value being replaced — the authoritative new digits pulse once in place.",
    carriedBy:
      "the number itself, which is the final value in the DOM before the first pulse frame can paint.",
    reducedEndState:
      "the new number is simply there, with no tween and no scale pulse.",
  },
  slide: {
    ms: 300,
    conveys:
      "the finding you dismissed WENT SOMEWHERE — it travelled toward the fold below that catches it, so dismissed reads as filed rather than deleted.",
    carriedBy:
      "the 'Dismissed' toast, the row leaving the list, and the row's reappearance inside the 'Snoozed & dismissed' disclosure with its own Restore control.",
    reducedEndState:
      "the row is simply gone from the list on the frame the page re-renders, and the fold below already holds it.",
  },
  tick: {
    ms: 180,
    conveys:
      "the finger crossed a month boundary — the period under it just became a different one, which is the difference between scrubbing THROUGH history and sliding around inside one month.",
    carriedBy:
      "the bubble's own text, which names the period on every frame it is shown, and the rail's `aria-valuetext`, which announces the same change to a reader who sees no bubble at all.",
    reducedEndState:
      "the bubble simply reads the new period on the next frame, with no beat — and the haptic is suppressed by the same preference (lib/haptics), so the text is the whole feedback.",
  },
  // WHOSE ARRIVAL COUNTS IS THE HOST'S DECISION, and the host that made it is gone:
  // lib/dashboard-motion.ts gated this on a WITNESSED arrival for the Now band, and
  // #5435 §4 deleted both. The remaining tenant (ControlTooltip) arrives from an
  // interaction, so there is nothing to witness; a surface that promotes on its own
  // owes a quiet-resume rule of its own before taking this plan.
  promote: {
    ms: 300,
    conveys:
      "a reading you were LOOKING AT just changed enough to matter now — it lifted out of the Standing cluster and arrived in Now as a card, which is why a card is suddenly there.",
    carriedBy:
      "the card itself, fully rendered with its own words on the frame it lands, plus the row's absence from Standing and the candidate id that is identical on both sides of the move.",
    reducedEndState:
      "the card is simply in Now on the frame the page re-renders, and Standing no longer lists the row; no keyframe is ever scheduled.",
  },
  // QuickLogMenu reserves panel height before gathering; the fade marks completion.
  arrive: {
    ms: 200,
    conveys:
      "the sheet just finished finding out what is due and usual for you: these offers were gathered after it opened, they were not waiting here.",
    carriedBy:
      "the section's own heading and rendered controls, plus its persistent aria-live status announcing that due and usual options are ready.",
    reducedEndState:
      "the gathered controls are simply present at full opacity on the frame the answer resolves; no keyframe is ever scheduled.",
  },
  fold: {
    ms: 500,
    conveys:
      "the fold CAUGHT it: the count on the 'Snoozed & dismissed' line just went up, and that line is where a dismissal is found again.",
    carriedBy:
      "the count in the summary's own text, which is the authoritative number on every paint, plus the restorable row now listed inside the disclosure.",
    reducedEndState:
      "the incremented count is simply there, with no ring and no pulse on the line.",
  },
} as const satisfies Record<string, MicroMotionDecl>;

export type MicroMotion = keyof typeof MICRO_MOTIONS;

export function microMotion(kind: MicroMotion): MicroMotionDecl {
  return MICRO_MOTIONS[kind];
}

// Continuity preserves the reader's place through their own action. It carries
// no separate fact, so its declaration names what stays continuous and why it moves.
export interface ContinuityMotionDecl {
  // Milliseconds. Mirrored by a CSS custom property of the same name.
  readonly ms: number;
  // What stays continuous across the change, in the reader's terms.
  readonly preserves: string;
  // The reader's own action that licenses this motion. No gesture, no motion.
  readonly causedBy: string;
  // The reduced-motion design: the end layout, instantly.
  readonly reducedEndState: string;
}

export function continuityMotion(
  ms: number,
  preserves: string,
  causedBy: string,
  reducedEndState: string
): ContinuityMotionDecl {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error("A continuity motion names its duration.");
  }
  if (!preserves.trim() || !causedBy.trim() || !reducedEndState.trim()) {
    throw new Error(
      "A continuity motion states what it preserves, what caused it, and its reduced end state."
    );
  }
  return { ms, preserves, causedBy, reducedEndState };
}

// The continuity motions. A new one is a row here plus a `--motion-<name>` custom
// property and a `.motion-<name>` rule in the stylesheet's Micro-motion section;
// the completeness test fails either half on its own, exactly as it does for the
// information table.
export const CONTINUITY_MOTIONS = {
  // Restored-open disclosures have no prior closed paint to animate from.
  disclose: continuityMotion(
    200,
    "the summary you tapped stays exactly where it is while the panel grows below it, so the line you were reading never moves out from under you.",
    "the reader's own tap, click or Enter on the summary. Nothing else opens a disclosure: a fold restored from memory on page load is already open and does not animate.",
    "the panel is simply at its full height on the frame the disclosure opens, and simply gone on the frame it closes; no transition is scheduled."
  ),
  // History fold state stays in the URL. Its gesture uses a browser View
  // Transition around the committed feed, with ordinary link navigation as fallback.
  historyfold: continuityMotion(
    250,
    "every row that was not the one you tapped stays exactly where it was and exactly how it looked — the fold or rollup you opened or closed is the only thing that visibly changes.",
    "the reader's own tap on a fold or rollup toggle (TimelineFilterLink, via useHistoryFoldNavigate). A `?open=`/`?expand=` link loaded directly, or a navigation this browser has no View Transition API for, renders with no transition scheduled — the ordinary `<Link>` navigation runs instead.",
    "the new feed is simply on screen on the frame the navigation completes, exactly as a browser with no View Transition support already renders it; no transition is scheduled."
  ),
} as const satisfies Record<string, ContinuityMotionDecl>;

export type ContinuityMotion = keyof typeof CONTINUITY_MOTIONS;

// Either class. Everything below this line — the band, the ease, the plan — reads
// this union, because the two classes differ in what they DECLARE and in nothing
// else about how they are timed or suppressed.
export type AnyMotion = MicroMotion | ContinuityMotion;

export function continuityMotionDecl(
  kind: ContinuityMotion
): ContinuityMotionDecl {
  return CONTINUITY_MOTIONS[kind];
}

export function motionMsOf(kind: AnyMotion): number {
  const decl: MicroMotionDecl | ContinuityMotionDecl =
    kind in MICRO_MOTIONS
      ? MICRO_MOTIONS[kind as MicroMotion]
      : (CONTINUITY_MOTIONS as Record<string, ContinuityMotionDecl>)[kind];
  return decl.ms;
}

// A duration outside the shared band must name its ruling and reasoning.
declare const BandExemptionBrand: unique symbol;

export interface BandExemption {
  // The duration this exemption authorizes, EXACTLY. Not a ceiling and not a
  // licence: the test pins it to the motion's declared `ms`, so re-timing an exempt
  // motion means re-arguing it here rather than sliding under an old permission.
  readonly exemptMs: number;
  // Who decided, and when. An exemption is a ruling, so it names one.
  readonly ruling: string;
  // The reasoning, in the ruling's own terms. Structurally required.
  readonly because: string;
  readonly [BandExemptionBrand]: "micro-motion-band-exemption";
}

export function bandExemption(
  exemptMs: number,
  ruling: string,
  because: string
): BandExemption {
  if (!Number.isFinite(exemptMs) || exemptMs <= 0) {
    throw new Error("A band exemption names the duration it authorizes.");
  }
  if (!ruling.trim() || !because.trim()) {
    throw new Error("A band exemption states its ruling and its reasoning.");
  }
  return { exemptMs, ruling, because } as BandExemption;
}

// Exemptions name existing motions and their exact durations. Tests reject
// stale exemptions and changes to the approved set of keys.
export const MICRO_MOTION_BAND_EXEMPTIONS = {
  fold: bandExemption(
    500,
    "owner ruling, 2026-08-13, recorded on #2654",
    "A dismissal travelling to its fold is a materially different motion from a tick " +
      "settling in place. The larger travel honestly wants more time, and compressing " +
      "the fold's answer to 300 ms would make it read as hurried where it should read " +
      "as deliberate. The ruling exempts the FOLD PULSE only: the dismissed row's own " +
      "`slide` stays inside the band, every other motion stays inside the band, and " +
      "`nothing loops` is untouched — one pulse, never a repeat."
  ),
} as const satisfies Partial<Record<AnyMotion, BandExemption>>;

// The exemption naming this motion, or null. A caller that wants to know whether a
// duration is legal asks this rather than re-deriving the band.
export function bandExemptionFor(kind: AnyMotion): BandExemption | null {
  return (
    (MICRO_MOTION_BAND_EXEMPTIONS as Partial<Record<AnyMotion, BandExemption>>)[
      kind
    ] ?? null
  );
}

export function withinMicroMotionBand(ms: number): boolean {
  return ms >= MICRO_MOTION_MIN_MS && ms <= MICRO_MOTION_MAX_MS;
}

// What a surface should actually do, once the viewer's preference is known.
export interface MicroMotionPlan {
  // The duration to time anything JS-driven with. 0 under reduced motion, which is
  // what makes "instantly" a real number rather than a branch every caller writes.
  readonly ms: number;
  // Whether to play at all. False under reduced motion.
  readonly animate: boolean;
  // The class to hang on the element, or "" — so a caller never string-builds a
  // `motion-*` name and never has to remember the preference check itself.
  readonly className: string;
}

export function microMotionPlan(
  kind: AnyMotion,
  reduceMotion: boolean
): MicroMotionPlan {
  if (reduceMotion) return { ms: 0, animate: false, className: "" };
  return {
    ms: motionMsOf(kind),
    animate: true,
    className: `motion-${kind}`,
  };
}
