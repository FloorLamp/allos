// Deterministic niggle detection over `activities.notes` (issue #2948, part 2).
//
// NO AI PASS — an explicit owner decision, not a shortcut. The lexicon
// (lib/curated/niggle-lexicon.ts) is curated data; this module is the small, pure,
// fixture-testable reader over it. Zero per-note cost, no network, and a result you can
// reason about from the two word lists alone.
//
// ── THE ONE THING THIS MUST NOT DO ───────────────────────────────────────────
//
// A MISS is fine and expected. A CONFIDENT WRONG REGION is not, because the confirm chip
// renders the detector's answer back as a sentence — "sounds like a right knee niggle" —
// and a wrong one makes the app look like it understood. So every ambiguity below
// resolves toward SAYING NOTHING, and every dropped case is reported in the result rather
// than swallowed, so a surface (or a test) can see what the detector declined to answer.
//
// ── THE ALGORITHM, AND WHAT EACH AMBIGUITY DOES ──────────────────────────────
//
// 1. The note is lowercased, apostrophes normalized, and split into SEGMENTS on sentence
//    and clause punctuation (. ; ! ? newline , — /). A segment is the unit of attribution:
//    "right knee weird, left hip no good" is two independent reports, which is exactly
//    how the two real prod notes read.
// 2. Inside a segment, the longest matching lexicon phrase wins at each position, so
//    "lower back" beats "back" and "no good" beats the negator "no".
// 3. A sentiment term immediately preceded (within two words) by a negator is DROPPED.
//    "knee not sore" reports nothing — it is not evidence of a healthy knee either.
// 4. Then, per segment:
//      • no sentiment              → nothing. Naming a body part is not a complaint.
//      • sentiment, no body term   → NO candidate. Reported as `sentimentWithoutRegion`,
//                                    because "everything's sore today" is real but names
//                                    no region, and picking one would be invention.
//      • sentiment, body terms that resolve to MORE THAN ONE region
//                                  → NO candidate. Reported as `ambiguousRegion`. This is
//                                    the "first match wins" trap: "knee and shoulder
//                                    weird" gives no honest way to attach the one
//                                    sentiment, so it attaches to neither.
//      • sentiment, body terms all resolving to ONE region
//                                  → one candidate, using the first term as the surface
//                                    word. ("quad and knee sore" is one Legs report.)
// 5. LATERALITY is read from the same segment and is NEVER inferred:
//      • exactly one side word          → that side.
//      • "both"/"bilateral"             → bilateral (the only route to it).
//      • conflicting side words         → laterality NULL, segment reported as
//                                         `ambiguousLaterality`. A left-and-right pair is
//                                         NOT promoted to bilateral: "left knee fine,
//                                         right knee sore" collapsed into one segment
//                                         would then claim both knees hurt.
//      • no side word                   → laterality NULL. A region with no side is a
//                                         perfectly good niggle; the chip simply says
//                                         "knee niggle".
// 6. Candidates are de-duplicated on (region, laterality) — the `niggleKey` identity —
//    keeping the first, so a note that says the same thing twice offers one chip.

import {
  NIGGLE_BODY_TERMS,
  NIGGLE_LATERALITY_TERMS,
  NIGGLE_NEGATORS,
  NIGGLE_SENTIMENT_TERMS,
  bodyTermRegion,
} from "./curated/niggle-lexicon";
import { niggleKey } from "./niggle-model";
import type { InjuryLaterality } from "./injury-model";
import type { MuscleRegion } from "./lifts";

// One detected, NOT-YET-WRITTEN niggle. The user's tap on the confirm chip is the write
// (#798 confirm-never-silent); nothing here reaches a table.
export interface NiggleCandidate {
  region: MuscleRegion;
  laterality: InjuryLaterality | null;
  // The word the person used, for the chip's copy. Display only.
  bodyTerm: string;
  // The sentiment word that made this a report, so a reviewer (and a test) can see WHY
  // the detector fired.
  sentimentTerm: string;
  // The clause it came from, trimmed. Useful for a "from your note" line and for pinning
  // attribution in fixtures.
  segment: string;
}

// Everything the detector saw, including what it declined to answer.
export interface NoteNiggleReading {
  candidates: NiggleCandidate[];
  // Clauses that complained but named no body part.
  sentimentWithoutRegion: string[];
  // Clauses whose complaint could belong to more than one region.
  ambiguousRegion: string[];
  // Clauses that named conflicting sides; their candidate (if any) carries a null side.
  ambiguousLaterality: string[];
}

const EMPTY_READING: NoteNiggleReading = {
  candidates: [],
  sentimentWithoutRegion: [],
  ambiguousRegion: [],
  ambiguousLaterality: [],
};

type TermKind = "body" | "sentiment" | "laterality" | "negator";

interface LexEntry {
  term: string;
  kind: TermKind;
}

// One flat, longest-first term index. Built once at module load: the lists are curated
// data and never change at runtime.
const TERM_INDEX: LexEntry[] = [
  ...NIGGLE_BODY_TERMS.map((b) => ({ term: b.term, kind: "body" as const })),
  ...NIGGLE_SENTIMENT_TERMS.map((t) => ({
    term: t,
    kind: "sentiment" as const,
  })),
  ...NIGGLE_LATERALITY_TERMS.map((l) => ({
    term: l.term,
    kind: "laterality" as const,
  })),
  ...NIGGLE_NEGATORS.map((n) => ({ term: n, kind: "negator" as const })),
].sort((a, b) => b.term.length - a.term.length || a.term.localeCompare(b.term));

const BODY_BY_TERM = new Map(
  NIGGLE_BODY_TERMS.map((b) => [b.term, bodyTermRegion(b)])
);
const LATERALITY_BY_TERM = new Map(
  NIGGLE_LATERALITY_TERMS.map((l) => [l.term, l.laterality])
);

interface Hit {
  term: string;
  kind: TermKind;
  start: number;
  end: number;
}

// Is the character at `i` outside a word? Word characters are letters, digits and the
// in-word hyphen/apostrophe, so "lower-back" and "isn't" match as single tokens.
function isWordChar(ch: string | undefined): boolean {
  return ch != null && /[a-z0-9'-]/.test(ch);
}

// Every lexicon hit in one segment, longest-first at each position and non-overlapping.
function scanSegment(segment: string): Hit[] {
  const hits: Hit[] = [];
  let i = 0;
  while (i < segment.length) {
    if (!isWordChar(segment[i])) {
      i += 1;
      continue;
    }
    // Only start a match at a word boundary.
    if (isWordChar(segment[i - 1])) {
      i += 1;
      continue;
    }
    let matched: LexEntry | null = null;
    for (const entry of TERM_INDEX) {
      const end = i + entry.term.length;
      if (segment.startsWith(entry.term, i) && !isWordChar(segment[end])) {
        matched = entry;
        break;
      }
    }
    if (matched) {
      hits.push({
        term: matched.term,
        kind: matched.kind,
        start: i,
        end: i + matched.term.length,
      });
      i += matched.term.length;
      continue;
    }
    // Skip the rest of this unmatched word.
    while (i < segment.length && isWordChar(segment[i])) i += 1;
  }
  return hits;
}

// A sentiment hit is negated when a negator sits within the two preceding lexicon-or-word
// tokens ("knee not sore", "no pain in the knee"). Two words rather than one so a
// determiner between them ("not too sore") still negates.
function isNegated(hits: Hit[], index: number, segment: string): boolean {
  const hit = hits[index];
  const before = segment.slice(0, hit.start);
  const words = before.split(/[^a-z0-9'-]+/).filter(Boolean);
  return words.slice(-2).some((w) => NIGGLE_NEGATORS.includes(w));
}

// Split a note into attribution segments. Commas count: "right knee weird, left hip no
// good" must be two reports, not one two-region ambiguity.
function segments(text: string): string[] {
  return text
    .split(/[.;!?\n\r,/•|]+|\s+-\s+|—/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function detectNiggles(
  notes: string | null | undefined
): NoteNiggleReading {
  if (!notes || !notes.trim()) return { ...EMPTY_READING };
  const normalized = notes.toLowerCase().replace(/[‘’]/g, "'");

  const candidates: NiggleCandidate[] = [];
  const sentimentWithoutRegion: string[] = [];
  const ambiguousRegion: string[] = [];
  const ambiguousLaterality: string[] = [];
  const seen = new Set<string>();

  for (const segment of segments(normalized)) {
    const hits = scanSegment(segment);
    const sentiment = hits.filter(
      (h, i) => h.kind === "sentiment" && !isNegated(hits, i, segment)
    );
    if (sentiment.length === 0) continue;

    const bodyHits = hits.filter((h) => h.kind === "body");
    if (bodyHits.length === 0) {
      sentimentWithoutRegion.push(segment);
      continue;
    }

    const regions = new Set(bodyHits.map((h) => BODY_BY_TERM.get(h.term)!));
    if (regions.size > 1) {
      ambiguousRegion.push(segment);
      continue;
    }
    const region = BODY_BY_TERM.get(bodyHits[0].term)!;

    const sides = new Set(
      hits
        .filter((h) => h.kind === "laterality")
        .map((h) => LATERALITY_BY_TERM.get(h.term)!)
    );
    let laterality: InjuryLaterality | null = null;
    if (sides.size === 1) laterality = [...sides][0];
    else if (sides.size > 1) ambiguousLaterality.push(segment);

    const key = niggleKey(region, laterality);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      region,
      laterality,
      bodyTerm: bodyHits[0].term,
      sentimentTerm: sentiment[0].term,
      segment,
    });
  }

  return {
    candidates,
    sentimentWithoutRegion,
    ambiguousRegion,
    ambiguousLaterality,
  };
}

// The chip's sentence. Named here rather than in the component so the copy is
// fixture-testable and so every surface that offers the confirm says it identically.
// A QUESTION, always — the tap is the write, and the wording must not imply anything has
// been recorded (#798).
export function niggleChipPrompt(c: NiggleCandidate): string {
  const part =
    c.laterality === "bilateral"
      ? `${c.bodyTerm} (both sides)`
      : c.laterality
        ? `${c.laterality} ${c.bodyTerm}`
        : c.bodyTerm;
  return `Sounds like a ${part} niggle — track it?`;
}
