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
];

export function uxSeedShapeFromEnv(env) {
  const raw = env.UX_SEED?.trim();
  if (!raw)
    return {
      kind: "found",
      shape: { name: null, label: "fresh", seed: false },
    };
  const shape = UX_SEED_SHAPES.find((entry) => entry.name === raw);
  if (!shape)
    return {
      kind: "unknown",
      raw,
      known: UX_SEED_SHAPES.map((entry) => entry.name),
    };
  if (shape.seedDialShape && env.SEED_RNG?.trim())
    return {
      kind: "conflict",
      raw,
      reason: `UX_SEED=${raw} pins a complete dial vector; remove SEED_RNG`,
    };
  return { kind: "found", shape };
}

// Build the actual child-process environment. Always clear a caller's direct
// SEED_DIAL_SHAPE first: UX_SEED is the census label recorded in run.json, so it
// must be the one authority over the data the seed writes.
export function applyUxSeedShapeEnv(env, shape) {
  const out = { ...env };
  delete out.SEED_DIAL_SHAPE;
  if (shape.seedDialShape) out.SEED_DIAL_SHAPE = shape.seedDialShape;
  return out;
}

export function uxSeedRunInfo(shape, env) {
  return {
    uxSeed: shape.name,
    seedRng: env.SEED_RNG ?? null,
    seedPersona: env.SEED_PERSONA ?? null,
    seedDialShape: shape.seedDialShape ?? null,
  };
}
