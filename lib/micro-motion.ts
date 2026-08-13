// MICRO-MOTION: the small moves that answer "did that work?" (#2654).
//
// The app is almost entirely static, and that is the calm identity working. The
// exception this module governs is motion that carries INFORMATION — a tap-shaped
// confirm visibly becoming its done state, a quantity visibly CHANGING rather than
// being replaced. Held to the same standard as copy, and to four hard rules:
//
//   1. 150–300 ms. Long enough to be seen as a transition, short enough that a
//      returning glance never waits on it. `MICRO_MOTION_MIN_MS`/`MAX_MS` are the
//      band, and the completeness test below fails a duration outside it.
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
// `slide` — a dismissed finding travelling toward the fold that catches it — is
// deliberately ABSENT: #2654 describes it, this pass does not ship it, and a token
// with no tenant is dead vocabulary that the next reader has to disprove. It joins
// this table with the surface that animates it.
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
} as const satisfies Record<string, MicroMotionDecl>;

export type MicroMotion = keyof typeof MICRO_MOTIONS;

export function microMotion(kind: MicroMotion): MicroMotionDecl {
  return MICRO_MOTIONS[kind];
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
