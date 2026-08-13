// Visit diagnoses, as the chips a card renders them into (#2589).
//
// WHAT THIS IS NOT. It is not a dedupe, it is not a normalizer, and it does not
// decide that two diagnoses are the same diagnosis. Two attempts to make that
// call from the string were refuted on the same axis (PR #2634): put the two
// cases side by side —
//
//   Encounter … procreative management  /  Encounter … procreative management - Primary
//   Hyperparathyroidism                 /  Hyperparathyroidism - Secondary
//
// — and they are structurally identical. Only clinical knowledge separates a
// rank from an etiology, so no string rule can, and both of those rules deleted
// a real diagnosis in a health record to prove it. Nothing here removes a name,
// re-files one, or reorders the list.
//
// WHAT IT IS. The filed harm is literal and it is about pixels: one long Z-code
// diagnosis rendered as two full-width amber chips that differ only by a
// suffix costs four wrapped lines on a phone card. When consecutive entries
// share a long leading run of text, the shared stem is printed ONCE and each
// entry's distinguishing tail after it. Every character of every name is still
// on screen — this is factoring, not hiding — and the renderer additionally
// carries the untouched full strings for assistive technology and hover.
//
// The worst case if the grouping is ever "wrong" is a chip that looks slightly
// odd. That is the whole point of doing it here instead of in storage.

// Split the "; "-joined diagnoses summary into individual names. Split on the
// delimiter with any surrounding whitespace so it matches the "; " join exactly.
// Shared by the visit list and the visit detail page, which each had their own
// copy of this before (#2589).
export function diagnosisList(diagnoses: string | null | undefined): string[] {
  if (!diagnoses) return [];
  return diagnoses
    .split(/\s*;\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// One rendered chip: either a name on its own, or a run of consecutive names
// that share a stem. `members[].name` is always the untouched original string
// and `stem + gap + tail` reconstructs it, so a renderer can show either.
export type DiagnosisChipGroup =
  | { kind: "single"; name: string }
  | {
      kind: "shared";
      stem: string;
      members: { name: string; tail: string }[];
    };

// The stem must be long enough that the pair genuinely wraps on a phone card —
// that wrapping IS the reported harm, and a stem shorter than one line of a chip
// costs nothing to repeat. It also keeps the compaction well away from short
// clinical pairs ("Hyperparathyroidism" / "Hyperparathyroidism - Secondary"),
// where there is no wrapping to fix and factoring would only invite the reader
// to see one diagnosis where there are two.
const MIN_SHARED_STEM = 40;

// Trailing separator punctuation trimmed off the printed stem (the tail keeps
// its own leading "- ", so the name still reads correctly when recombined).
const STEM_TRAILING = /[\s\-–—,;:/]+$/;

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

// Cut a raw common prefix back to a point that is a word boundary in EVERY
// member: either the member ends there, or the next character is not
// alphanumeric. Without this, "Diabetes mellitus type 1" and "… type 12" would
// share a stem that ends mid-token.
function boundaryStemLength(names: string[], rawLen: number): number {
  for (let k = rawLen; k > 0; k--) {
    const ok = names.every((n) => n.length === k || !/[\p{L}\p{N}]/u.test(n[k]));
    if (ok) return k;
  }
  return 0;
}

function groupOf(names: string[]): DiagnosisChipGroup | null {
  if (names.length < 2) return null;
  // The prefix shared by EVERY member, not just the first pair.
  const raw = names.reduce(
    (acc, n) => Math.min(acc, commonPrefixLength(names[0], n)),
    names[0].length
  );
  const k = boundaryStemLength(names, raw);
  if (k === 0) return null;
  const stem = names[0].slice(0, k).replace(STEM_TRAILING, "");
  if (stem.length < MIN_SHARED_STEM) return null;
  const members = names.map((name) => ({
    name,
    tail: name.slice(k).replace(/^\s+/, ""),
  }));
  // The shared part must dominate what distinguishes the entries; otherwise the
  // chip is not meaningfully shorter and the factored form is harder to read
  // than the two plain names.
  if (!members.every((m) => m.tail.length < stem.length)) return null;
  return { kind: "shared", stem, members };
}

// Group CONSECUTIVE entries only. Source order is information (a problem list is
// ordered by the clinician who wrote it), and pulling a match up from three
// entries away to sit beside its twin is a reordering — one of the defects the
// withdrawn migration was refuted for. A run is extended only while the whole
// run still qualifies together.
export function groupDiagnosisChips(names: string[]): DiagnosisChipGroup[] {
  const out: DiagnosisChipGroup[] = [];
  let i = 0;
  while (i < names.length) {
    let end = i + 1;
    let best: DiagnosisChipGroup | null = null;
    while (end < names.length) {
      const candidate = groupOf(names.slice(i, end + 1));
      if (!candidate) break;
      best = candidate;
      end++;
    }
    if (best) {
      out.push(best);
      i = end;
    } else {
      out.push({ kind: "single", name: names[i] });
      i++;
    }
  }
  return out;
}
