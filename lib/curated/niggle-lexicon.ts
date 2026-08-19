// The CURATED niggle lexicon (issue #2948, part 2) — data, not code.
//
// Two conservative word lists and nothing else: the colloquial BODY TERMS a person
// actually types after a workout ("knee", "hip", "lats"), and the SENTIMENT TERMS that
// say the part is bothering them ("sore", "weird", "no good"). The detector that reads
// them lives in lib/niggle-extract.ts; this file is the vocabulary it is allowed to see,
// kept beside the app's other curated reference data (lib/curated/) so it can be edited
// as data.
//
// ── ONE REGION VOCABULARY (the #2948 invariant) ──────────────────────────────
//
// This is NOT a parallel body-part list. Every entry below resolves into the EXISTING
// injury/lifts vocabulary — a `MuscleId` rolled up through `muscleRegion()`, or, for a
// JOINT that no muscle id names, the `MuscleRegion` directly. A niggle stores a
// `MuscleRegion` and an `InjuryLaterality` and nothing else structural; the surface form
// the user typed rides along as display text (the `Injury.label` precedent), never as an
// identity. `lib/__tests__/niggle-lexicon.test.ts` pins that every entry's region is a
// member of `REGION_SCOPES`, so a new term cannot invent a region.
//
// Joints are the reason a term list is needed at all: "knee" and "hip" are the two words
// the owner's own prod notes use, and neither is a muscle. Their region is the region the
// app already files them under — `hip` → Glutes follows the existing injury fixture
// (lib/__action_tests__/injuries.actions.test.ts logs the label "hip" against Glutes),
// and `knee`/`ankle` → Legs is the only coarse region the joint's musculature rolls into.
//
// ── CONSERVATIVE-LIST DISCIPLINE ─────────────────────────────────────────────
//
// Recall misses are the accepted cost (#2948: "honest misses over silent guesses"). A
// term earns its place only when it is UNAMBIGUOUSLY about a body part or about that part
// hurting, in the register of a gym note. So "off" is deliberately absent (an off day is
// not an off knee), and so is "bad" ("bad session"). Adding a term is a data edit; adding
// an ambiguous one is how the confirm chip starts looking like the app understood
// something it did not.

import { muscleRegion, type MuscleId, type MuscleRegion } from "../lifts";

// One colloquial body word and the region it resolves to. Exactly one of `muscle` /
// `region` is set — `muscle` for anything the fine-grained `MuscleId` enum already names
// (so the rollup is the app's, not ours), `region` only for JOINTS the enum has no id for.
export type NiggleBodyTerm =
  | { readonly term: string; readonly muscle: MuscleId }
  | { readonly term: string; readonly region: MuscleRegion };

// The curated body vocabulary. Order does not matter — the detector matches the LONGEST
// term first so "lower back" wins over "back".
export const NIGGLE_BODY_TERMS: readonly NiggleBodyTerm[] = [
  // Legs — the joints first, then the muscles the enum names.
  { term: "knee", region: "Legs" },
  { term: "knees", region: "Legs" },
  { term: "ankle", region: "Legs" },
  { term: "ankles", region: "Legs" },
  { term: "quad", muscle: "quads" },
  { term: "quads", muscle: "quads" },
  { term: "quadriceps", muscle: "quads" },
  { term: "hamstring", muscle: "hamstrings" },
  { term: "hamstrings", muscle: "hamstrings" },
  { term: "hammy", muscle: "hamstrings" },
  { term: "hammies", muscle: "hamstrings" },
  { term: "calf", muscle: "calves" },
  { term: "calves", muscle: "calves" },
  { term: "shin", muscle: "tibialis" },
  { term: "shins", muscle: "tibialis" },
  { term: "groin", muscle: "hip-adductors" },
  { term: "adductor", muscle: "hip-adductors" },
  { term: "adductors", muscle: "hip-adductors" },

  // Glutes — the hip joint files here (see the fixture precedent above).
  { term: "hip", region: "Glutes" },
  { term: "hips", region: "Glutes" },
  { term: "glute", muscle: "glutes" },
  { term: "glutes", muscle: "glutes" },

  // Shoulders.
  { term: "shoulder", region: "Shoulders" },
  { term: "shoulders", region: "Shoulders" },
  { term: "delt", muscle: "side-delts" },
  { term: "delts", muscle: "side-delts" },
  { term: "rotator cuff", region: "Shoulders" },

  // Arms — elbow and wrist are joints, the rest are muscles.
  { term: "elbow", region: "Arms" },
  { term: "elbows", region: "Arms" },
  { term: "wrist", region: "Arms" },
  { term: "wrists", region: "Arms" },
  { term: "bicep", muscle: "biceps" },
  { term: "biceps", muscle: "biceps" },
  { term: "tricep", muscle: "triceps" },
  { term: "triceps", muscle: "triceps" },
  { term: "forearm", muscle: "forearms" },
  { term: "forearms", muscle: "forearms" },

  // Chest.
  { term: "chest", muscle: "chest" },
  { term: "pec", muscle: "chest" },
  { term: "pecs", muscle: "chest" },

  // Back — "lower back" / "mid back" must out-rank the bare "back", which the
  // longest-match rule gives for free.
  { term: "lower back", muscle: "lower-back" },
  { term: "low back", muscle: "lower-back" },
  { term: "mid back", muscle: "mid-back" },
  { term: "upper back", muscle: "mid-back" },
  // The BARE word "back" is deliberately absent. It is the single most collision-prone
  // token in a gym note — "back squat", "back off set", "went back to 60kg" — and each of
  // those sits happily beside a sentiment word ("back squat felt weird") while meaning
  // nothing about the Back region. The qualified forms above carry the same signal
  // without the collision, and losing "back sore" is a miss we accept.
  { term: "lat", muscle: "lats" },
  { term: "lats", muscle: "lats" },
  // Plural "traps" only: singular "trap" is the trap BAR, an implement this app's own
  // extractor already knows about, and "trap bar pulls felt sore" is not a trapezius
  // report.
  { term: "traps", muscle: "traps" },
  { term: "neck", muscle: "neck" },

  // Core.
  { term: "abs", muscle: "abs" },
  { term: "oblique", muscle: "obliques" },
  { term: "obliques", muscle: "obliques" },
];

// The region a curated body term resolves to. The rollup is `muscleRegion()`'s — this
// function never decides one.
export function bodyTermRegion(entry: NiggleBodyTerm): MuscleRegion {
  return "muscle" in entry ? muscleRegion(entry.muscle) : entry.region;
}

// The curated sentiment vocabulary: words that say a named part is BOTHERING the person.
// Multi-word phrases are matched before single words, so "no good" is read as sentiment
// rather than as the negator "no" plus an unknown word.
//
// Deliberately excluded: "bad", "off", "rough", "heavy", "dead" — every one of them is
// ordinary training talk about a SESSION, and none of them is evidence about a body part.
export const NIGGLE_SENTIMENT_TERMS: readonly string[] = [
  "no good",
  "not good",
  "not happy",
  "flare up",
  "flared up",
  "playing up",
  "acting up",
  "sore",
  "soreness",
  "tight",
  "tightness",
  "stiff",
  "stiffness",
  "weird",
  "tweak",
  "tweaked",
  "tweaky",
  "ache",
  "aches",
  "achy",
  "aching",
  "niggle",
  "niggly",
  "niggling",
  "twinge",
  "twingy",
  "pain",
  "painful",
  "hurt",
  "hurts",
  "hurting",
  "dodgy",
  "cranky",
  "grumpy",
  "pinch",
  "pinched",
  "pinching",
  "unhappy",
];

// Words that NEGATE a sentiment term standing right before it ("knee not sore"). Kept
// short and literal; a negated hit is dropped rather than inverted — "knee not sore" is
// not evidence of a healthy knee worth storing, it is simply not a niggle report.
export const NIGGLE_NEGATORS: readonly string[] = [
  "no",
  "not",
  "never",
  "without",
  "isnt",
  "isn't",
  "wasnt",
  "wasn't",
  "nothing",
  "zero",
];

// The side words a note may carry, and the `InjuryLaterality` each means. "both" and
// "bilateral" are the only ways to reach `bilateral` — the detector NEVER infers a side,
// and never promotes a left-and-right pair to bilateral (see lib/niggle-extract.ts).
export const NIGGLE_LATERALITY_TERMS: readonly {
  readonly term: string;
  readonly laterality: "left" | "right" | "bilateral";
}[] = [
  { term: "left", laterality: "left" },
  { term: "right", laterality: "right" },
  { term: "both", laterality: "bilateral" },
  { term: "bilateral", laterality: "bilateral" },
];
// Single-letter abbreviations ("L knee", "R shoulder") are deliberately NOT here. They
// are real gym shorthand, but a bare `l`/`r` also falls out of set notation and rep
// scribbles ("5x5 r"), and a wrongly-sided chip is the failure this feature must not
// have. A miss on "R knee sore" costs a tap; a chip that says "left knee" when the note
// said right is the app claiming to have understood.
