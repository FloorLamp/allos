// WHAT A `MUTATION:` NOTE HAS TO CARRY (#3577).
//
// A `MUTATION:` note says "change X and this case goes red". It is how a reader
// learns what a test case actually holds — and it is PROSE. Nothing runs it, so a
// note that was measured and a note that was guessed read exactly alike.
//
// THE NUMBER THAT MADE THIS A CONVENTION RATHER THAN A HABIT. Round 11 of #3424
// ran every one of the 23 notes in `hc-overlap-supersede-refutations.test.ts`.
// FOURTEEN WERE WRONG, in three kinds: two claimed either of two changes would red
// a case (one killed nothing, the other killed a test that was not among the three
// named); SEVEN named a mutation that kills nothing IN THE TIER THE NOTE SITS IN —
// adding `nutrition_kcal` to `DAY_BUCKET_METRICS` leaves the whole db tier green
// while the pure tier reds three; and three were true of every possible output, so
// they proved nothing. Correcting them also found a surviving mutant in shipped
// code. A reader trusting a `MUTATION:` note was trusting an unexecuted claim.
//
// WHAT THIS GUARD DOES AND, JUST AS IMPORTANTLY, DOES NOT DO.
//
// It checks the SHAPE. It does not run anything, and it CANNOT tell a true measured
// note from a false one — a note claiming "Measured: 5 red in the db tier" passes
// this guard whether or not anybody ran it. Say that out loud, because a guard
// whose limits are unstated gets read as a stronger claim than it makes.
//
// A MUTATION-TESTING HARNESS WAS CONSIDERED AND DELIBERATELY NOT BUILT. Executing
// 50 notes means applying 50 source edits and running two tiers per edit; the db
// tier alone is minutes. Anything that expensive gets turned off, and a guard that
// is off is worse than a convention nobody wrote down. What is cheap is requiring
// each note to say WHERE it was measured — and that is the half that failed seven
// times out of fourteen, because "this goes red" without a tier is unfalsifiable
// by reading and was wrong more often than not.
//
// SO A CONFORMING NOTE STATES TWO THINGS:
//
//   1. THAT IT WAS RUN — the word `Measured`, which is the spelling the corrected
//      notes already use ("Measured: 5 red across the three HC specs", "Measured,
//      and this case does NOT move: 6624 db tests green").
//   2. WHERE — the tier or the spec the reds appear in ("the pure tier", "the db
//      tier", or a named `*.test.ts`). A note whose mutation reds a DIFFERENT tier
//      than the one it sits in must say so; that is the seven.
//
// A case with NO killing mutation — over-determined, two independent barriers each
// sufficient — says exactly that, and says it as a measured verdict. It is a real
// state and the house answer is to record it, not to delete the case or to invent
// a mutation that does not kill.

export interface ScannedSource {
  readonly file: string;
  readonly source: string;
}

export interface MutationNote {
  readonly file: string;
  /** 1-based line of the `MUTATION:` token itself. */
  readonly line: number;
  /** The whole contiguous comment run the note sits in, as a reader reads it. */
  readonly note: string;
  readonly measured: boolean;
  readonly tier: boolean;
}

const MARKER = "MUTATION:";

// The measurement marker. `Measured`/`measured` — one word, already in the tree,
// and impossible to write by accident.
const MEASURED_RE = /\bmeasured\b/i;

// WHERE IT WAS MEASURED. The vocabulary is the repo's own: two unit tiers named in
// vitest.config.ts and vitest.db.config.ts, the e2e tier, or a named spec file.
// Deriving it from how the tree already writes tiers rather than from how an issue
// describes them is the whole reason it matches anything at all.
const TIER_RE =
  /\b(pure tier|db tier|db tests|unit tier|e2e tier|[\w-]+\.test\.tsx?)\b/i;

const isCommentLine = (line: string): boolean => /^\s*(\/\/|\*)/.test(line);

/**
 * Every `MUTATION:` note in these sources, with the comment run it lives in.
 *
 * The run is taken in BOTH directions from the marker, because that is how a
 * reader reads it: several corrected notes state the measurement in a sentence
 * that begins before the word `MUTATION:` ("…stored. MUTATION: give `pushStampFor`
 * any window-derived fallback…"). A down-only reader would call those unmeasured
 * and send someone to re-measure work already done.
 */
export function findMutationNotes(
  sources: readonly ScannedSource[]
): MutationNote[] {
  const notes: MutationNote[] = [];
  for (const { file, source } of sources) {
    const lines = source.split("\n");
    lines.forEach((line, i) => {
      if (!line.includes(MARKER) || !isCommentLine(line)) return;
      let start = i;
      while (start > 0 && isCommentLine(lines[start - 1])) start--;
      let end = i;
      while (end < lines.length - 1 && isCommentLine(lines[end + 1])) end++;
      const note = lines.slice(start, end + 1).join("\n");
      notes.push({
        file,
        line: i + 1,
        note,
        measured: MEASURED_RE.test(note),
        tier: TIER_RE.test(note),
      });
    });
  }
  return notes;
}

export const conforms = (n: MutationNote): boolean => n.measured && n.tier;

/** One line per non-conforming note, in the shape a failing expectation prints. */
export function describeMutationNote(n: MutationNote): string {
  const missing = [
    n.measured ? null : "does not say it was MEASURED",
    n.tier ? null : "does not name the TIER or spec the reds appear in",
  ].filter((x): x is string => x !== null);
  return `${n.file}:${n.line} — ${missing.join("; ")}`;
}
