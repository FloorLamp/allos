// MICRO-MOTION: the small moves the app is allowed to make (#2654, #3676).
//
// The app is almost entirely static, and that is the calm identity working. TWO
// classes of motion are allowed out of that stillness, and they answer different
// questions:
//
//   INFORMATION motion answers "did that work?" — a tap-shaped confirm visibly
//   becoming its done state, a quantity visibly CHANGING rather than being
//   replaced. It carries a fact, and is held to the same standard as copy.
//
//   CONTINUITY motion (#3676) answers nothing. Its job is that THE EYE KEEPS ITS
//   PLACE through a change the reader caused: a panel growing under the summary
//   they tapped. It carries no information, which is exactly why rule 3 below is
//   scoped to the information class and why continuity motions declare
//   `preserves` and `causedBy` instead.
//
// Both classes are held to the same four rules, with rule 3 read per class:
//
//   1. 150–300 ms. Long enough to be seen as a transition, short enough that a
//      returning glance never waits on it. `MICRO_MOTION_MIN_MS`/`MAX_MS` are the
//      band, and the completeness test below fails a duration outside it — unless
//      the motion carries an ARGUED EXEMPTION (`MICRO_MOTION_BAND_EXEMPTIONS`),
//      which is a value that cannot be constructed without its reasoning.
//   2. NOTHING LOOPS. A looping animation is an attention claim that never stops
//      making itself, and a health app must not campaign at anyone. Every class in
//      the stylesheet's Micro-motion section runs once; the test fails an
//      `infinite`/`alternate` iteration there.
//   3. Reduced motion is a DESIGNED STATE, not a degradation. Every motion in
//      EITHER class declares `reducedEndState`: for an information motion, the same
//      information arriving instantly; for a continuity motion, the end layout,
//      instantly. The second sentence of this rule is scoped to the INFORMATION
//      class: a motion in THAT table whose meaning is lost when it is switched off
//      was decoration and does not belong in it. A continuity motion is defined by
//      having no meaning to lose, so that sentence cannot judge it — `preserves`
//      and `causedBy` are what stop it becoming garnish instead.
//   4. Motion is never the ONLY carrier. Every INFORMATION motion declares
//      `carriedBy` — the text, attribute or colour that states the same fact for a
//      reader who sees no motion at all, including a screen-reader user and a
//      printed page. A continuity motion carries no fact, so it has none to declare.
//
// WHAT IS REFUSED, in both classes, stated so the continuity class cannot be read
// as an opening: ambient or idle animation; anything looping; motion on a surface
// the reader did not act on; decorative entrances on page load; and motion that
// delays a reader's next action — a control is interactive on the FIRST FRAME of
// any continuity motion, never after it.
//
// This is TOKENS AND A DECLARATION, not a registry engine (#2654's own words): the
// numbers, one ease curve, and the pure fold of the viewer's preference into a
// duration. There is no scheduler and no runtime dispatch. The CSS half lives in
// app/globals.css's "Micro-motion" section, and lib/__tests__/micro-motion.test.ts
// pins the two copies of every number together.
//
// NOT this module: the OVERLAY family (lib/motion.ts) — a panel arriving is
// navigation, runs at 240 ms, and answers a different question. Keep them apart; a
// surface that slides a sheet does not reach in here.
//
// Pure by construction: no DOM, no React, no clock.

// The 150–300 ms band from the issue title, as checkable numbers.
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

// Every micro-motion in the app. A new one is a row here plus a
// `--motion-<name>` custom property in the stylesheet's Micro-motion section;
// the completeness test fails either half on its own.
//
// `slide` and `fold` are TWO motions, not one, and conflating them is the mistake
// the owner ruling below exists to prevent: the dismissed row TRAVELLING is one
// duration (in-band), and the fold line ANSWERING is another (exempt). They are
// authored, tokenized and timed apart because they are separately true — a fold can
// pulse for a dismissal that came from a keyboard with no row travel worth drawing,
// and a row can travel on a surface whose fold is currently empty.
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
  // The fifth tenant, and the first that is not feedback on a WRITE (#2657 item 4). It
  // answers the same question — "did that register?" — for a GESTURE instead of a save:
  // the jump rail's bubble beats once as the finger crosses out of one month and into
  // the next. It belongs in this vocabulary rather than the overlay family because it
  // is a beat IN PLACE rather than a panel arriving, and it is held to all four rules
  // including the band. It is also the rule-4 case at its starkest: the platform half
  // of the same feedback (one 8 ms haptic, `HAPTIC_PATTERNS["scrubber-tick"]`) does not
  // exist on iOS at all, which is exactly why the #2657 ruling makes the VISUAL pulse
  // the universal carrier — and why this row is not optional.
  tick: {
    ms: 180,
    conveys:
      "the finger crossed a month boundary — the period under it just became a different one, which is the difference between scrubbing THROUGH history and sliding around inside one month.",
    carriedBy:
      "the bubble's own text, which names the period on every frame it is shown, and the rail's `aria-valuetext`, which announces the same change to a reader who sees no bubble at all.",
    reducedEndState:
      "the bubble simply reads the new period on the next frame, with no beat — and the haptic is suppressed by the same preference (lib/haptics), so the text is the whole feedback.",
  },
  // The sixth tenant, and the first on the dashboard (#3253 decision 4). A reading
  // whose value changed enough to be promoted LIFTS out of Standing and arrives in Now
  // as a card. It is feedback on a change rather than on a write, like `tick` — and it
  // is held to all four rules, including the band.
  //
  // 300 ms, not the issue's "~320 ms": 320 is 20 ms outside the band, and the honest
  // price of 20 ms is a band exemption — a ruling, with reasoning, that would then be
  // the SECOND entry in a list whose whole value is having one. The tilde is doing the
  // work it was written for. If a future ruling wants 320 it costs an exemption, and
  // that is the right price to make someone pay.
  //
  // WITNESSED ONLY. Whether this class is applied at all is `witnessedNowMotion`
  // (lib/dashboard-motion.ts): a promotion that lands while you are looking gets the
  // lift; the same diff arriving after a resume lands quietly, because "this just
  // moved" is false once you were away.
  promote: {
    ms: 300,
    conveys:
      "a reading you were LOOKING AT just changed enough to matter now — it lifted out of the Standing cluster and arrived in Now as a card, which is why a card is suddenly there.",
    carriedBy:
      "the card itself, fully rendered with its own words on the frame it lands, plus the row's absence from Standing and the candidate id that is identical on both sides of the move.",
    reducedEndState:
      "the card is simply in Now on the frame the page re-renders, and Standing no longer lists the row; no keyframe is ever scheduled.",
  },
  // The seventh tenant (#3675). The quick-log sheet reserves the context slot
  // before this asynchronous gather starts, so the opacity receipt can say
  // "finished gathering" without moving the segment strip under the reader.
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

// ── The CONTINUITY class (#3676) ─────────────────────────────────────────────
//
// A second class, for motion whose job is that THE EYE KEEPS ITS PLACE through a
// change the reader caused. It conveys nothing — switch it off and no fact is
// lost, only the reader's grip on where they were — so it cannot declare
// `conveys` or `carriedBy` and it cannot be judged by rule 3's decoration
// sentence. Two other questions do that work instead, and both are required:
//
//   `preserves` — what stays continuous across the change, in the reader's terms.
//   `causedBy`  — the reader's OWN action that licenses it. This is the guard that
//                 keeps "nothing moves without a gesture" true. A network answer
//                 arriving unprompted is NOT a cause; the tap that requested it is.
//
// Everything else is inherited from the information class UNCHANGED: the
// 150-300 ms band and its mechanical test, the same `bandExemption()` shape if one
// is ever argued (the pinned exempt-key list still names `fold` alone), the
// nothing-loops stylesheet scan, the single MICRO_MOTION_EASE so the two classes
// cannot feel different, and `reducedEndState` — which for this class is simply
// the end layout, instantly. That last one is why the class is safe: a reader who
// turns motion off gets exactly today's app.
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

// A continuity declaration is a VALUE THAT CANNOT BE CONSTRUCTED BLANK — the same
// declare-or-argue shape `bandExemption()` above and `arguedExclusion()` in
// lib/loggable-domains.ts use. The two new fields are the only thing standing
// between this class and garnish, so a row that leaves one empty must not exist
// rather than merely fail a length assertion somewhere later.
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
export const CONTINUITY_MOTIONS = {} as const satisfies Record<
  string,
  ContinuityMotionDecl
>;

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

// ── The band, and the one thing exempt from it ───────────────────────────────
//
// Rule 1 is 150–300 ms and #2705 made it mechanical, which is what turned "nothing
// lingers" from a promise into a build property. An exemption is therefore not a
// number you may quietly widen: it is a VALUE, and `bandExemption()` refuses to
// construct one without its reasoning written down. That is the same declare-or-argue
// shape `arguedExclusion()` uses in lib/loggable-domains.ts, for the same reason — a
// bare numeric exception with no stated why is how a band stops being a rule and
// becomes a default the next motion argues it also deserves.
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

// The exemptions, keyed by the motion they name. `Partial<Record<AnyMotion, …>>`
// so an exemption can only ever name a motion that exists — in EITHER class, since
// the band is inherited unchanged and so is the price of leaving it — and the test fails a
// STALE one — an entry whose motion has since come back inside the band is a
// permission nobody needs, and leaving it there is how the list grows.
//
// One entry today. A second is a deliberate edit of this table AND of the test's
// pinned key list, with its own ruling beside it.
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
