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
// diagnosis rendered as two full-width amber chips that differ only by a suffix
// costs four wrapped lines on a phone card. When consecutive entries share a long
// leading run of text, the shared stem is printed ONCE and each entry's
// distinguishing tail after it, so the pair costs one chip instead of two.
//
// THE LENGTH GATE IS ABOUT WRAPPING, AND NOTHING ELSE. `MIN_SHARED_STEM` is not a
// clinical discriminator and must never be described as one: plenty of real
// etiology pairs clear it and DO group —
//
//   Amyloidosis of the kidney with nephrotic syndrome │ - Primary │ - Secondary
//   Adrenal cortical insufficiency with electrolyte disturbance │ - Primary │ …
//
// — and that is accepted, because this layer never claims the two are one
// diagnosis. It prints both names, in order, in full. The v1/v2 refuting inputs
// stay as plain chips because their names are SHORT, not because anything here
// can tell a rank from an etiology.
//
// So the invariants are what make it safe, and they are pinned by tests rather
// than by the gate:
//
//   1. `stem + tail === name`, exactly, for every member — no character of any
//      name is dropped between the two printed pieces. (The separator run trimmed
//      off the stem is carried by the tail, not deleted; a version that deleted it
//      printed "…of breast" + "Left" and lost the " - ".)
//   2. Order is preserved and only CONSECUTIVE entries group.
//   3. Nothing is removed: `members` carries every original string untouched, and
//      the renderer speaks those to assistive technology and hover verbatim.
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

// One rendered chip: either a name on its own, or a run of consecutive names that
// share a stem. `members[].name` is always the untouched original string, and
// `stem + tail` reconstructs it EXACTLY — that identity is what makes printing the
// stem once a factoring rather than a truncation.
export type DiagnosisChipGroup =
  | { kind: "single"; name: string }
  | {
      kind: "shared";
      stem: string;
      members: { name: string; tail: string }[];
    };

// The stem must be long enough that repeating it costs a wrapped line, since that
// wrapping is the whole harm being fixed. It is a PIXEL threshold — see the header:
// it says nothing about what the shared text means, and a long etiology pair
// groups just like a long rank pair does.
const MIN_SHARED_STEM = 40;

// Trailing separator punctuation not printed at the END of the stem — it reads as
// a dangling "…of breast - ". The run is NOT dropped: each tail starts at
// `stem.length`, so it carries those characters and `stem + tail` is still the
// original name.
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
    const ok = names.every(
      (n) => n.length === k || !/[\p{L}\p{N}]/u.test(n[k])
    );
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
    // From the end of the PRINTED stem, not from `k`: the separator run between
    // them belongs to somebody, and dropping it silently is how the first version
    // of this rendered "…of breast" beside a bare "Left".
    tail: name.slice(stem.length),
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
