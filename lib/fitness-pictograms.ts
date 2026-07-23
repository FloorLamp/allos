// Fitness-check pictogram path data (#1253) — the pure half of the pictogram asset
// class. Hand-authored original artwork: one little stroke figure PERFORMING each
// battery test (adult + senior variants, lib/fitness-battery.ts) plus one abstract
// glyph per FitnessDomain, drawn to the house icon contract so they sit beside the
// Tabler set everywhere else:
//
//   • 24×24 viewBox, stroke-based (`stroke="currentColor"`, width 1.75, round
//     caps/joins), NO fills — the figure inherits the heat tile's tone text color in
//     light AND dark, and the stale treatment (opacity/grayscale) applies for free.
//   • Decorative only: the rendering component marks the SVG `aria-hidden` — the
//     tile's text label/overlay stays the accessible name (the #1249 "never
//     color-only" rule extends to "never icon-only").
//
// Path data lives HERE (pure, JSX-free — the lib/muscle-anatomy-paths.ts precedent)
// and components/fitness-pictograms.tsx renders it, so the battery⇆pictogram
// totality test runs in the pure tier. An unknown/future test key resolves to the
// neutral `fallback` figure — never a crash (pinned in
// lib/__tests__/fitness-pictograms.test.ts, which also pins both directions:
// no icon-less test, no dead key).

import type { FitnessDomain } from "@/lib/fitness-battery";

// One entry per battery test key, plus the neutral fallback for unknown keys.
export type FitnessPictogramKey =
  | "vo2max"
  | "hrr"
  | "grip"
  | "pushups"
  | "chairstand"
  | "armcurl"
  | "biglift"
  | "vo2step2min"
  | "balance"
  | "tug"
  | "fourstage"
  | "sitreach"
  | "srt"
  | "deadhang"
  | "plank"
  | "bodyfat"
  | "restinghr"
  | "fallback";

// Small stroked circle (renders as a dot at stroke 1.75 — the Tabler figure-head
// convention). Kept as a helper so every head shares one radius language.
function dot(cx: number, cy: number, r = 1.5): string {
  return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
}

// Each pictogram is an ordered list of path `d` strings (all stroked, no fills).
export const FITNESS_PICTOGRAM_PATHS: Record<FitnessPictogramKey, string[]> = {
  // Sprinting figure + speed lines — cardiorespiratory capacity.
  vo2max: [
    dot(15, 4.5),
    "M14.6 6.2L12.6 11.6", // torso, leaning into the run
    "M14.2 7.3L10.9 8.5", // back arm
    "M14.2 7.3L17.2 9.4", // front arm
    "M12.6 11.6L15.8 14.2L16.6 18.2", // front leg driving
    "M12.6 11.6L9.4 14.4L6.6 12.9", // back leg trailing
    "M3.5 6.5h3", // speed lines
    "M3 9.5h2.2",
  ],
  // ECG pulse settling + a downward arrow — heart-rate recovery.
  hrr: [
    "M3 13.5h3.2l2 -5.5l3 8.5l1.9 -4.5h2.4",
    "M19.5 8.5v7.5",
    "M17.2 13.7L19.5 16L21.8 13.7",
  ],
  // Spring grip trainer: torsion coil + two handles in a narrow V.
  grip: [
    "M9.9 6.3a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0 -4.2 0", // coil
    "M11 8.3L9.2 17.6",
    "M13 8.3L14.8 17.6",
  ],
  // Push-up at the top: straight arm to the floor, body held high (deliberately a
  // different silhouette from the forearm plank — sibling tiles on one grid).
  pushups: [
    dot(5, 7.8, 1.4),
    "M7 9L19 14.6", // body line, high off the floor
    "M7.5 9.4L9.8 17.6", // straight supporting arm
    "M19 14.6L20 17.6", // toes
  ],
  // Rising out of a chair, hips back, arms reaching forward.
  chairstand: [
    "M19.8 5.8V18.4", // chair back + rear leg
    "M14.6 13.2H19.8", // seat
    "M15.3 13.2V18.4", // front chair leg
    dot(8.7, 5.6),
    "M8.9 7.4L10.6 12", // torso hinged forward
    "M9.4 8.6L5.8 10.2", // arms forward
    "M10.6 12L8.7 14.8L9.3 18.4", // bent legs
  ],
  // Seated dumbbell curl (Senior Fitness Test): bench, bent elbow, bell up.
  armcurl: [
    dot(8.3, 4.9),
    "M8.3 6.7V13", // torso
    "M8.3 13H12.9", // thigh
    "M12.9 13V18.3", // shin
    "M5.4 13H8.3", // bench seat
    "M6 13V18.3", // bench leg
    "M8.3 8.2L11.6 10.6L13.3 7.4", // curling arm
    "M11.6 6.5L15 8.3", // dumbbell across the hand
  ],
  // Overhead press under a loaded bar — the one big lift.
  biglift: [
    "M4.5 6.8H19.5", // bar
    "M6.3 4.4V9.2", // plates
    "M17.7 4.4V9.2",
    dot(12, 10.2, 1.4),
    "M8.4 7L11.1 12.2", // arms locked out to the bar
    "M15.6 7L12.9 12.2",
    "M12 12.2V15", // torso
    "M12 15L9.8 16.4L9.8 18.7", // braced legs
    "M12 15L14.2 16.4L14.2 18.7",
  ],
  // Marching in place, knee to height — the 2-minute step.
  vo2step2min: [
    dot(10.8, 4.4),
    "M10.8 6.2V12", // upright torso
    "M10.8 8L7.9 10.1", // swinging arms
    "M10.8 8L13.9 9.6",
    "M10.8 12L10 18.3", // standing leg
    "M10.8 12L14.6 11.2L14.6 15.4", // raised knee
    "M6.5 18.6H15.5", // floor
  ],
  // One-leg stand, arms out like wings.
  balance: [
    dot(12, 4.3),
    "M12 6.1V12.2", // torso
    "M5.5 10.2L12 8.1L18.5 10.2", // balancing arms
    "M12 12.2V18.6", // standing leg
    "M12 12.2L15.2 14L13.5 16.6", // tucked leg
    "M9.2 18.8H14.8", // floor
  ],
  // Walking stride + a U-turn arrow — up, go, and back.
  tug: [
    dot(9.8, 5.7),
    "M10 7.4L10.7 12.8", // torso
    "M10.2 9.2L7.9 11.4", // arms mid-swing
    "M10.2 9.2L12.9 11.2",
    "M10.7 12.8L7.5 18.2", // striding legs
    "M10.7 12.8L13.9 18.2",
    "M14.6 5.6h3.1a2.6 2.6 0 0 1 0 5.2h-3.3", // turn-around arrow
    "M16.2 9L14.2 10.8L16.2 12.6",
  ],
  // Two footprints stepping heel-to-toe — the tandem stance.
  fourstage: [
    "M11.13 5.61L11.93 9.61a1.6 1.6 0 0 0 3.14 -0.62L14.27 4.99a1.6 1.6 0 0 0 -3.14 0.62z", // front foot
    dot(12.3, 2.9, 0.55), // its toe
    "M8.73 13.41L9.53 17.41a1.6 1.6 0 0 0 3.14 -0.62L11.87 12.79a1.6 1.6 0 0 0 -3.14 0.62z", // back foot
    dot(9.9, 10.7, 0.55), // its toe
  ],
  // Seated forward fold reaching for the box.
  sitreach: [
    "M4.3 17.6H14.8", // legs along the floor
    "M14.8 17.6V14.9", // flexed foot
    "M16.4 18.3V14.1h4.2v4.2", // the reach box
    "M4.9 17.2L9 10.8", // torso folded forward
    dot(10, 9.3, 1.4),
    "M9.3 11.5L14.6 14.6", // reaching arms
  ],
  // Cross-legged floor sit + an up arrow — sitting-rising.
  srt: [
    dot(9.7, 5.8),
    "M9.7 7.6V12.4", // torso
    "M9.7 9L7.2 11.2", // arms out for the unassisted rise
    "M9.7 9L12.2 11.2",
    "M9.7 12.4L5.6 15.4L10.3 16.5", // crossed legs
    "M9.7 12.4L13.8 15.4L9.1 16.5",
    "M17.8 15.8V8.8", // rise arrow
    "M15.6 11L17.8 8.8L20 11",
  ],
  // Straight-arm hang from the bar.
  deadhang: [
    "M4 4.6H20", // the bar
    "M10 4.8L11.1 9.4", // straight arms, grip at shoulder width
    "M14 4.8L12.9 9.4",
    dot(12, 7.6, 1.3),
    "M12 9.4V14.2", // torso
    "M12 14.2L10.7 18.6", // hanging legs
    "M12 14.2L13.3 18.6",
  ],
  // Forearm plank: one straight line, forearm planted.
  plank: [
    dot(5.5, 10.9, 1.4),
    "M7.4 11.8L18.9 14.5", // body line
    "M7.8 11.9L7.2 17.3H11.4", // upper arm + forearm on the floor
    "M18.9 14.5L20 17.3", // toes
  ],
  // A tape measure around the waist of an hourglass torso.
  bodyfat: [
    "M8.2 4.6C8.2 8.2 7 9.8 7 12.6C7 15.8 8 17 8.2 19.4", // torso sides
    "M15.8 4.6C15.8 8.2 17 9.8 17 12.6C17 15.8 16 17 15.8 19.4",
    "M5 12.3H19", // the tape band
    "M5 14.7H19",
  ],
  // A heart at rest (with a "z" of sleep) — resting heart rate.
  restinghr: [
    "M10.8 19.5l-6.3 -6.3a4.1 4.1 0 0 1 5.8 -5.8l.5 .5l.5 -.5a4.1 4.1 0 0 1 5.8 5.8z",
    "M17.2 3.8h3.4l-3.4 3.4h3.4",
  ],
  // Neutral standing figure — the safe unknown-key fallback.
  fallback: [
    dot(12, 4.7),
    "M12 6.5V12.4",
    "M7.6 9.9L12 8.4L16.4 9.9",
    "M12 12.4L9.2 18.4",
    "M12 12.4L14.8 18.4",
  ],
};

// The domain glyphs — same stroke language, more abstract (they label groups, not
// tests): tile domain chips + the "By domain" bars render these beside their text.
export const FITNESS_DOMAIN_GLYPH_PATHS: Record<FitnessDomain, string[]> = {
  // Heartbeat trace.
  endurance: ["M3 12.4h3.9l2.2 -5.6l3.7 10.4l2.2 -4.8h4"],
  // Dumbbell.
  strength: [
    "M8.2 12h7.6",
    "M6.4 8.6v6.8",
    "M17.6 8.6v6.8",
    "M4.2 10v4",
    "M19.8 10v4",
  ],
  // Ball poised on a beam over a fulcrum.
  balance: [
    "M10.1 10.3a1.9 1.9 0 1 0 3.8 0a1.9 1.9 0 1 0 -3.8 0",
    "M5 12.9H19",
    "M12 13.1l-2.4 5.1h4.8z",
  ],
  // A deep-bend arc sweeping upward.
  flexibility: [
    "M5.2 17.6A11.6 11.6 0 0 1 17.4 6.4",
    "M15.4 8.1L17.4 6.4L18.1 8.9",
  ],
  // Range-of-motion sweep around a pivot.
  mobility: [
    "M5.2 17.6a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0 -2.2 0",
    "M7.4 17.6H17.6",
    "M17.6 17.6A11.3 11.3 0 0 1 6.3 6.3",
    "M8.6 4.7L6.3 6.3L8.6 7.9",
  ],
  // Person silhouette — body composition.
  body: [
    "M9.4 6.6a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0 -5.2 0",
    "M5.4 19.2a6.6 6.6 0 0 1 13.2 0",
  ],
};

// Resolve a battery test key to its pictogram; unknown/future keys get the neutral
// fallback figure, never a crash.
export function resolveFitnessPictogram(testKey: string): FitnessPictogramKey {
  return testKey in FITNESS_PICTOGRAM_PATHS && testKey !== "fallback"
    ? (testKey as FitnessPictogramKey)
    : "fallback";
}
