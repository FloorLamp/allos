// MICRO-MOTION: the small moves that answer "did that work?" (#2654).
//
// The app is almost entirely static, and that is the calm identity working. The
// exception this module governs is motion that carries INFORMATION — a tap-shaped
// confirm visibly becoming its done state, a quantity visibly CHANGING rather than
// being replaced. Held to the same standard as copy, and to four hard rules:
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
//   3. Reduced motion is a DESIGNED STATE, not a degradation. Every motion here
//      declares `reducedEndState`: the same information, arriving instantly. If a
//      motion's meaning is lost when it is switched off, it was decoration and does
//      not belong in this table.
//   4. Motion is never the ONLY carrier. Every motion declares `carriedBy` — the
//      text, attribute or colour that states the same fact for a reader who sees no
//      motion at all, including a screen-reader user and a printed page.
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
      "a QUANTITY changed, which reads differently from a value being replaced — the digits travel from the old number to the new one.",
    carriedBy:
      "the number itself, which is already the final value in the DOM's text on the frame the tap settles.",
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

// The exemptions, keyed by the motion they name. `Partial<Record<MicroMotion, …>>`
// so an exemption can only ever name a motion that exists, and the test fails a
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
      "`nothing loops` is untouched — one pulse, never a repeat.",
  ),
} as const satisfies Partial<Record<MicroMotion, BandExemption>>;

// The exemption naming this motion, or null. A caller that wants to know whether a
// duration is legal asks this rather than re-deriving the band.
export function bandExemptionFor(kind: MicroMotion): BandExemption | null {
  return (
    (MICRO_MOTION_BAND_EXEMPTIONS as Partial<Record<MicroMotion, BandExemption>>)[
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
  kind: MicroMotion,
  reduceMotion: boolean
): MicroMotionPlan {
  if (reduceMotion) return { ms: 0, animate: false, className: "" };
  return {
    ms: MICRO_MOTIONS[kind].ms,
    animate: true,
    className: `motion-${kind}`,
  };
}

// ── The counter roll ─────────────────────────────────────────────────────────
//
// The one requestAnimationFrame case in the vocabulary: digits travelling between
// two quantities. Pure so the curve is unit-tested rather than eyeballed, and so
// the reduced-motion answer is the SAME function rather than a second code path
// the caller writes around it.
//
// Ease-out cubic, matching MICRO_MOTION_EASE's shape: fast off the mark, settling
// onto the real number. `elapsedMs >= ms` — and `ms <= 0`, the reduced-motion
// duration — both answer `to` exactly, so a frame that arrives late, a frame that
// arrives at 0, and a viewer who asked for no motion all land on the true value.
export function countRollValue(
  from: number,
  to: number,
  elapsedMs: number,
  ms: number
): number {
  if (ms <= 0 || elapsedMs >= ms) return to;
  if (elapsedMs <= 0) return from;
  const t = elapsedMs / ms;
  const eased = 1 - (1 - t) ** 3;
  const raw = from + (to - from) * eased;
  // Rounded TOWARD the destination so the last visible frame before the settle is
  // never the value we just left — a roll that shows `30` twice and then `31` reads
  // as a stutter rather than a travel.
  return to >= from ? Math.floor(raw) : Math.ceil(raw);
}
