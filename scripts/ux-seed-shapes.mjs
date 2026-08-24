// Named data shapes for the UX walkthrough (#3489 D3).
//
// `UX_SEED` is the runner-facing name. The seed entrypoint owns dial vectors,
// so this module only plans whether to seed, which fixed vector name to pass,
// and whether a post-seed transform is required. Keeping those jobs separate
// means the browser harness cannot grow a second copy of the dirty vector.

export const UX_SEED_SHAPES = [
  { name: "1", label: "seeded", seed: true },
  { name: "thin", label: "thin", seed: true, postSeed: "thin" },
  {
    name: "dirty",
    label: "dirty",
    seed: true,
    seedDialShape: "dirty",
  },
  {
    name: "one-cycle",
    label: "one-cycle",
    seed: true,
    seedDialShape: "one-cycle",
  },
];

export function uxSeedShapeFromEnv(env) {
  const raw = env.UX_SEED?.trim();
  const shape = raw
    ? UX_SEED_SHAPES.find((entry) => entry.name === raw)
    : { name: null, label: "fresh", seed: false };
  if (!shape)
    return {
      kind: "unknown",
      raw,
      known: UX_SEED_SHAPES.map((entry) => entry.name),
    };
  const persona = env.SEED_PERSONA?.trim();
  if (persona && shape.name !== "1")
    return {
      kind: "conflict",
      raw,
      reason: `SEED_PERSONA=${persona} is set but UX_SEED=${raw || "unset"} — persona runs need UX_SEED=1, otherwise the census would label a differently-shaped DB with a persona it doesn't contain.`,
    };
  const seedRng = env.SEED_RNG?.trim();
  if (seedRng && !shape.seed)
    return {
      kind: "conflict",
      raw,
      reason: `SEED_RNG=${seedRng} is set but UX_SEED is fresh; use UX_SEED=1 or UX_SEED=thin so the sampled dial vector is actually seeded`,
    };
  if (persona && seedRng)
    return {
      kind: "conflict",
      raw,
      reason: `SEED_PERSONA=${persona} cannot be combined with SEED_RNG=${seedRng}; persona seeding replaces the dial vector`,
    };
  if (shape.seedDialShape && seedRng)
    return {
      kind: "conflict",
      raw,
      reason: `UX_SEED=${raw} pins a complete dial vector; remove SEED_RNG`,
    };
  return { kind: "found", shape };
}

// Build the actual child-process environment. Always clear a caller's direct
// SEED_DIAL_SHAPE first: UX_SEED is the census label recorded in run.json, so it
// must be the one authority over the data the seed writes. The served harness
// owns freshness structurally with a unique scratch directory; child env planning
// must not revive the older table-content classifier.
export function applyUxSeedShapeEnv(env, shape) {
  const out = { ...env };
  delete out.SEED_DIAL_SHAPE;
  delete out.SEED_REQUIRE_EMPTY;
  if (shape.seedDialShape) out.SEED_DIAL_SHAPE = shape.seedDialShape;
  return out;
}

export function uxSeedRunInfo(shape, env) {
  return {
    uxSeed: shape.name,
    seedRng: env.SEED_RNG?.trim() || null,
    seedPersona: env.SEED_PERSONA?.trim() || null,
    seedDialShape: shape.seedDialShape ?? null,
  };
}
