// Shared cross-profile multi-view RENDERING RULES (issue #1327). These are the pure,
// framework-free decisions the multi-view flagship (#1096 Upcoming) hardened, extracted
// so the Tier-1 fan-out (#1328 — 12 more lists) consumes ONE implementation instead of
// re-deriving each per page. Every rule here is PURE (no DB, no JSX) and keyed off the
// scope/stamp data (#534 disambiguation, stampSubjects in lib/scope.ts) — never a
// hand-rolled label or a page-local special case.
//
// #1328 ADOPTERS CONSUME FROM HERE: the write-target affordance gate
// (itemAffordanceVisible), the subject-chip-visibility rule (subjectChipVisible), the
// view-set count label (viewCountLabel), and the ViewMode vocabulary + its param parser.
// The per-list MERGE that implements the two modes lives in each list's merge layer
// (Upcoming's is lib/attention.ts — mergeAttentionPageGroups / groupAttentionByPerson),
// but follows the ViewMode names defined here so every adopter speaks the same words.

// Where a list item's inline write action lands (issue #1327 fix 5). Most items write to
// their OWN subject ("item" — a dose confirmed on Sam's row writes to Sam). A few write to
// whoever is ACTING regardless of the row's subject ("acting" — e.g. a condition-suggestion
// confirm, which confirmConditionSuggestion always applies to the acting profile). Promoting
// this to a DECLARED item property means the shared row scaffolding gates the affordance
// automatically; the hand-rolled `(!multi || isActing)` a page had to remember was the exact
// #1013 wrong-profile-write risk this removes.
export type WriteTarget = "item" | "acting";

// Whether an item's inline write affordance may render on a given row.
//   • "item"   → gate on the SUBJECT's write access (a read-only-granted member's rows
//                show no write buttons — the #858 per-item access rule generalized).
//   • "acting" → render ONLY on the acting profile's own row; the write targets the acting
//                profile, so offering it on another member's row is a wrong-target write.
// In single-view every row IS the acting profile (isActing true, subject null → canWrite
// true), so both branches collapse to "shown" — the single-profile page is unchanged.
export function itemAffordanceVisible(
  writeTarget: WriteTarget | undefined,
  ctx: { isActing: boolean; subjectCanWrite: boolean }
): boolean {
  return writeTarget === "acting" ? ctx.isActing : ctx.subjectCanWrite;
}

// Whether a row renders its subject chip (#534). Chips inform ONLY on cross-profile rows
// that are NOT the acting profile's own: a single view needs no chips (one implied subject),
// and the acting profile's rows are already implied by the view strip naming who's acting
// (#1327 fix 1) — chipping them just doubles density (a seeded 3-profile view rendered nine
// consecutive "admin" chips in the Overdue band). So: multi AND not the acting row.
export function subjectChipVisible(ctx: {
  multi: boolean;
  isActing: boolean;
}): boolean {
  return ctx.multi && !ctx.isActing;
}

// The view-set BADGE label (#1327 fix 6, product-decided): a multi-view badge reads
// "N across M profiles" so it can't read as a contradiction against the acting-only
// dashboard hero / nav counts (which STAY acting-only by design — their subject is you).
// Single view keeps the plain "N total". Recorded as a shared rule so no future adopter
// "fixes" the deliberate difference.
export function viewCountLabel(total: number, profileCount: number): string {
  return profileCount > 1
    ? `${total} across ${profileCount} profiles`
    : `${total} total`;
}

// The two orderings a multi-view list offers (#1327 fix 2, product-decided). "interleaved"
// (default) keeps date bands with subjects merged across members; "by-person" groups by
// member with per-member headers, so a caregiver triaging "what does Riley need" stops
// scanning chips. The merge layer implements both modes; the page toggles between them.
export type ViewMode = "interleaved" | "by-person";

// Parse the page-level mode toggle from a URL search param, defaulting to "interleaved" for
// any absent/unknown value (so a stale or typo'd link never errors or renders empty).
export function parseViewMode(raw: string | string[] | undefined): ViewMode {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === "by-person" ? "by-person" : "interleaved";
}
