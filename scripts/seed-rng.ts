// Deterministic seed entropy (#2594) — the census's fourth axis, orthogonal to
// the fresh/thin/seeded shapes (#1544).
//
// The seed script is ~3,000 lines of hand-authored fixed data: one look. The
// 2026-08 readability sweep showed the cost — its highest-value bugs (the merge
// ordering regression #2578, import qualifier duplicates #2589, cross-domain
// symptom frecency #2583) were all invisible to that one look. Pure per-value
// noise would not have found them either: they came from specific
// CONFIGURATIONS. So entropy enters as a small vector of scenario DIALS sampled
// from a seeded PRNG, each dial mapped to the defect class it exists to
// surface, with fine-grained jitter riding a SEPARATE stream underneath.
//
// Contracts, all load-bearing:
//   - `SEED_RNG` unset (or =1, DEFAULT_SEED) ⇒ BASELINE_DIALS, the historical
//     look, byte-stable. `npm run seed`, the e2e template DB, and `--baseline`
//     census diffing all depend on that pin. Entropy is a seeing-tool feature,
//     never a test-tier one.
//   - Same seed ⇒ same dials, forever: dials draw IN DECLARATION ORDER from a
//     fresh stream, so a new dial is APPENDED (one draw at the end), never
//     inserted — inserting would silently re-deal every existing seed's look.
//   - Jitter (`jitterStream`) is a separate stream derived from the same seed,
//     so adding or removing a jitter call in seed.ts can never shift which
//     dials a seed samples.
//   - seed → dials is pure; the census records the seed and prints the dial
//     description, so a finding reads "seed 7: heavy volume + active illness"
//     and any look is reproducible from its number.

export const DEFAULT_SEED = 1;

// Mulberry32 — small, fast, deterministic; ample quality for data-shape dials.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The scenario dials. Each maps to a defect class the 2026-08 sweep found only
// in live data; see the hooks in scripts/seed.ts.
export interface SeedDials {
  // Illness episode overlapping today vs safely past — frecency interference on
  // domain symptom pickers (#2583's Fever-on-Cycle).
  illnessNow: "active" | "past";
  // Source-system artifacts written the way an import lands them: a duplicated
  // visit diagnosis with a " - Primary" qualifier baked into the name (#2589)
  // and biomarker family spelling variants (#482's vitamin D).
  importQuirks: "clean" | "quirky";
  // A pile of far-dated goals — the #2579 Later-band look, and enough same-band
  // rows for ordering defects (#2578) to become visible.
  volume: "lean" | "heavy";
  // A multi-day logging/sync outage — day-fill and gap rendering.
  gapiness: "continuous" | "gappy";
  // Long names — truncation and wrap behavior.
  textLength: "short" | "long";
}

// The pinned default: exactly the hand-authored look the seed has always
// produced (the current illness episode IS part of that look).
export const BASELINE_DIALS: SeedDials = {
  illnessNow: "active",
  importQuirks: "clean",
  volume: "lean",
  gapiness: "continuous",
  textLength: "short",
};

export interface NamedSeedDialShape {
  /** The SEED_DIAL_SHAPE value handed to scripts/seed.ts. */
  name: string;
  /** One-line audit/log description of what this fixed look exercises. */
  description: string;
  /** A complete vector, never a seed whose sampled meaning can drift. */
  dials: SeedDials;
}

// Named census looks that need to stay in the standard rotation. These are
// complete vectors by construction: adding or reordering RNG draws cannot
// change what a name means. Keep unrelated dimensions on the baseline so a
// dirty-profile review is about imported residue and uncontrolled names, not a
// simultaneous illness/volume/gap scenario.
export const NAMED_SEED_DIAL_SHAPES: readonly NamedSeedDialShape[] = [
  {
    name: "dirty",
    description: "portal import quirks + long uncontrolled names",
    dials: {
      ...BASELINE_DIALS,
      importQuirks: "quirky",
      textLength: "long",
    },
  },
];

export type SeedDialSelection =
  | { kind: "entropy"; seed: number; dials: SeedDials }
  | { kind: "named"; shape: NamedSeedDialShape; dials: SeedDials }
  | { kind: "unknown"; raw: string; known: string[] }
  | { kind: "conflict"; raw: string; reason: string };

// Sample the dial vector for a seed. DEFAULT_SEED is special-cased to the
// baseline BY CONSTRUCTION (not by hoping draws land right), so the pin cannot
// rot as dials are appended. Every other seed draws one value per dial, in
// declaration order — append new dials at the END (see module comment).
export function sampleDials(seed: number): SeedDials {
  if (seed === DEFAULT_SEED) return { ...BASELINE_DIALS };
  const rng = mulberry32(seed);
  return {
    illnessNow: rng() < 0.5 ? "active" : "past",
    importQuirks: rng() < 0.5 ? "clean" : "quirky",
    volume: rng() < 0.5 ? "lean" : "heavy",
    gapiness: rng() < 0.5 ? "continuous" : "gappy",
    textLength: rng() < 0.5 ? "short" : "long",
  };
}

// One line for logs and audit.md: names only the non-baseline dials, or says
// it's the baseline. "seed 7: heavy volume + past illness" beats a JSON dump.
export function describeDials(dials: SeedDials): string {
  const parts: string[] = [];
  if (dials.illnessNow !== BASELINE_DIALS.illnessNow)
    parts.push("past illness");
  if (dials.importQuirks !== BASELINE_DIALS.importQuirks)
    parts.push("import quirks");
  if (dials.volume !== BASELINE_DIALS.volume) parts.push("heavy volume");
  if (dials.gapiness !== BASELINE_DIALS.gapiness) parts.push("logging gaps");
  if (dials.textLength !== BASELINE_DIALS.textLength) parts.push("long names");
  return parts.length ? parts.join(" + ") : "baseline look";
}

// The fine-grained jitter stream (adherence misses, minor count variation).
// Derived from the same seed but XOR-salted so it is INDEPENDENT of the dial
// draws: consuming more or less jitter never re-deals a seed's dials.
export function jitterStream(seed: number): () => number {
  return mulberry32((seed ^ 0x9e3779b9) >>> 0);
}

// Parse SEED_RNG from a caller-supplied environment record. Absent, empty, or
// non-integer input falls back to DEFAULT_SEED — a typo must produce the
// pinned look, never a silently different one. The env is a required argument,
// deliberately never read from the global process here, so this module stays a
// PURE helper outside the script-env-bootstrap scan: the entrypoint
// (scripts/seed.ts) loads ./load-env first and hands its environment in.
export function seedFromEnv(env: Record<string, string | undefined>): number {
  const raw = env.SEED_RNG?.trim();
  if (!raw) return DEFAULT_SEED;
  const n = Number(raw);
  return Number.isInteger(n) ? n : DEFAULT_SEED;
}

// Resolve the vector scripts/seed.ts will actually use. A named shape and an
// entropy seed are mutually exclusive: recording both would make a run claim a
// sampled look while the fixed vector won. Unknown names fail at the entrypoint
// instead of quietly producing baseline data under a dirty label.
export function seedDialsFromEnv(
  env: Record<string, string | undefined>
): SeedDialSelection {
  const raw = env.SEED_DIAL_SHAPE?.trim();
  if (!raw) {
    const seed = seedFromEnv(env);
    return { kind: "entropy", seed, dials: sampleDials(seed) };
  }
  const shape = NAMED_SEED_DIAL_SHAPES.find((entry) => entry.name === raw);
  if (!shape)
    return {
      kind: "unknown",
      raw,
      known: NAMED_SEED_DIAL_SHAPES.map((entry) => entry.name),
    };
  if (env.SEED_RNG?.trim())
    return {
      kind: "conflict",
      raw,
      reason: `SEED_DIAL_SHAPE=${raw} pins a complete vector; remove SEED_RNG`,
    };
  return { kind: "named", shape, dials: { ...shape.dials } };
}
