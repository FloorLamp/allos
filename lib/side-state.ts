// THE side-state census (issue #2087) — the registry of registries.
//
// Stars, dismissals, edit locks, tombstones, undo captures and send markers are one
// concept: state ABOUT a row, keyed by a grammar, de-orphaned by a sweep. Each family
// below already has its own registry with its own scan — but nothing guarded the
// CATEGORY, and every family exists because exactly that bit once: a namespace was
// invented inline, drifted, and had to be retrofitted a registry after its first
// defect (#1931 for dismissals, #2036 for send markers, #2038 for undo parity).
//
// This census is the category's declaration: every side-state family the app keeps,
// where it lives, which registry governs it, and which test enforces that registry.
// `lib/__tests__/side-state.test.ts` is its teeth:
//
//   1. REFLECTION — every family's registry module exists and exports the named
//      symbol; every named guard test exists and actually references that symbol,
//      so a census row cannot point at a registry that moved or a guard that
//      stopped guarding.
//   2. THE CATEGORY SCAN — a quoted key literal shaped like side-state
//      (SIDE_STATE_KEY_SHAPES) appearing in lib/ or scripts/ must belong to a
//      registered family's store or be listed in NON_SIDE_STATE_KEYS with what it
//      actually is. Today that scan is EMPTY by construction — the point is the day
//      it isn't: a new `"seen_…"`/`"pinned_…"` key cannot reach main without either
//      joining a family or being argued out, which is the decision this census
//      exists to force.
//
// WHAT THIS DOES NOT CATCH, stated plainly (the dismissal registry's own honesty
// rule): a side-state key whose spelling matches none of the declared shapes — and
// carries no `notify_` prefix (guarded by send-markers) and no `*_PREFIX` export
// (guarded by dismissal-classes) — escapes all three scans. The census shrinks the
// hole; it does not close it. Migrations are excluded from the scan because shipped
// migrations are frozen history, not live key-minting.
//
// Pure string constants only, importable from any tier.

/** One side-state family the app keeps, and what keeps it honest. */
export interface SideStateFamily {
  /** Short name, unique in the census. */
  family: string;
  /** What the state means, in one sentence. */
  concept: string;
  /** The physical store: a table, or a settings-key namespace. */
  store: string;
  /** Repo-relative module that owns the family's registry. */
  registryModule: string;
  /** The exported registry symbol in that module. */
  registrySymbol: string;
  /** How rows/keys are named — the grammar a new entry must follow. */
  keyGrammar: string;
  /** What de-orphans the state when its subject leaves. */
  sweep: string;
  /** Repo-relative test file enforcing the family's registry. */
  guard: string;
}

// The single source of truth. One entry per side-state family.
export const SIDE_STATE_FAMILIES: readonly SideStateFamily[] = [
  {
    family: "dismissal",
    concept:
      "A promise to stay quiet about a specific signal the person silenced.",
    store: "upcoming_dismissals.signal_key",
    registryModule: "lib/dismissal-classes.ts",
    registrySymbol: "DISMISSAL_KEY_REGISTRY",
    keyGrammar:
      "`<prefix><tail>`, the tail's recycle risk declared as a DismissalKeyClass; " +
      "name-keyed namespaces must name their sweep",
    sweep: "per-entry `sweep` for the name-keyed classes (#1931)",
    guard: "lib/__tests__/dismissal-classes.test.ts",
  },
  {
    family: "send-marker",
    concept:
      "A record that a notification was already sent, so cadence stays honest.",
    store: "profile_settings / settings `notify_*` keys",
    registryModule: "lib/notifications/send-markers.ts",
    registrySymbol: "SEND_MARKER_REGISTRY",
    keyGrammar:
      "a declared `notify_*` namespace + tail shape; variable tails mint " +
      "through builders over closed unions (#2036)",
    sweep: "per-entry retention/sweep, named in the registry entry",
    guard: "lib/__tests__/send-markers.test.ts",
  },
  {
    family: "undo-capture",
    concept:
      "A restorable snapshot of a deleted row (and its children) behind the Undo toast.",
    store: "deleted_rows",
    registryModule: "lib/undo-delete.ts",
    registrySymbol: "UNDO_KINDS",
    keyGrammar:
      "`kind` → KindSpec: root table, child captures, FK remaps, external refs (#30)",
    sweep: "buffer retention purge and the profile-delete sweep",
    guard: "lib/__tests__/undo-delete.test.ts",
  },
  {
    family: "import-tombstone",
    concept:
      "A record that an imported row was deliberately deleted, so re-ingest cannot resurrect it.",
    store: "import_tombstones",
    registryModule: "lib/integrations/tombstone-keys.ts",
    registrySymbol: "TOMBSTONE_TABLES",
    keyGrammar:
      "(table, natural source key), plus the `document:` namespace sharing the " +
      "storage but not the consult path (#1776/#1777)",
    sweep: "consulted at ingest; rows leave with their profile",
    guard: "lib/__tests__/tombstone-keys.test.ts",
  },
  {
    family: "edit-lock",
    concept:
      "A flag that a source-owned row was hand-corrected, so sync must never overwrite it.",
    store: "`edited` column on importer-written tables",
    registryModule: "lib/integrations/sync-log.ts",
    registrySymbol: "isEditLocked",
    keyGrammar:
      "row-level flag; set by a manual edit, read only through the predicate",
    sweep: "none needed — the flag dies with its row",
    guard: "lib/__db_tests__/import-edit-lock.test.ts",
  },
  {
    family: "saved-star",
    concept:
      'The ★ answer to "does this matter to me?" — membership drives curated surfaces.',
    store: "saved_items",
    registryModule: "lib/saved-items.ts",
    registrySymbol: "SAVED_KINDS",
    keyGrammar:
      "(kind, key): `biomarker` → #482 canonical name, `trend-metric` → metric id (#1456)",
    sweep:
      "kind-scoped deletes in the row merge/delete flows (lib/queries/medical.ts)",
    guard: "lib/__tests__/saved-items.test.ts",
  },
];

/**
 * Quoted-literal spellings that read as side-state. A key literal starting with one
 * of these, anywhere in lib/ or scripts/, must resolve to a registered family or be
 * listed in NON_SIDE_STATE_KEYS. (`notify_` is deliberately absent: the send-marker
 * scan already owns that namespace end to end, and two scans claiming one prefix
 * would disagree about the allowlist.)
 */
export const SIDE_STATE_KEY_SHAPES: readonly string[] = [
  "dismissed_",
  "seen_",
  "starred_",
  "pinned_",
  "snoozed_",
];

/**
 * Literals that MATCH a side-state shape but are not side-state, each with what it
 * actually is. Empty today, and the scan's value is that adding to it — or to a
 * family — is a reviewable act rather than an accident.
 */
export const NON_SIDE_STATE_KEYS: readonly {
  literal: string;
  reason: string;
}[] = [
  {
    literal: "dismissed_at",
    reason:
      "A COLUMN NAME, declared in the #2205 temporal-column index (lib/time-columns.ts) " +
      "as upcoming_dismissals\u2019 lifecycle instant — WHEN a dismissal was made. The " +
      "dismissal family\u2019s side-state KEY is `signal_key`, registered in " +
      "DISMISSAL_KEY_REGISTRY; this timestamp mints nothing and keys nothing, and it " +
      "matches only because the shape scan looks for the `dismissed_` prefix.",
  },
];
