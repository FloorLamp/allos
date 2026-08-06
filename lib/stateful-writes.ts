// Gated-table write registry (issue #1893) — the enforcement half of the stateful-
// affordance pattern (#1892).
//
// THE SPLIT, stated plainly, because the two halves guarantee different things:
//
//   • THIS SCAN GUARANTEES NO SILENT CORRUPTION. Where a stateful write CORE exists, no
//     other module may reach past it to the table with a raw INSERT/UPDATE/DELETE. Every
//     write therefore passes the core that enforces the gate and returns a typed refusal.
//   • THE AUDIT UPGRADES REFUSALS INTO GOOD UX. No static check can prove that a button
//     was rendered from state — that is what the `offerState` field names, so a reviewer
//     has ONE place to look for the derivation a surface should be rendering. With the
//     scan in place, the worst a state-blind button can do is tap → honest refusal. It
//     can never corrupt.
//
// The criterion the audit applies: ADDITIVE writes may stay plain; LIFECYCLE writes render
// from state. A weight entry or a food serving adds a fact and is correctly a plain
// button; a period start, an episode close, or a supply counter is a transition over
// existing state and needs a core that can refuse.
//
// Registering a table asserts that its listed `cores` are the only modules allowed to
// mutate it, and that each core answers with a typed outcome rather than confirming
// unconditionally. The registry is deliberately SMALL — it is a chokepoint list, not an
// inventory of the schema. Precedents for the shape: CROSS_PROFILE_SQL_MODULES
// (lib/cross-profile.ts) and the lib/notifications/telegram.ts outbound chokepoint.
//
// Enforced by lib/__tests__/stateful-writes.test.ts over the shared source scanner.

export interface StatefulWriteTable {
  // The SQL table name, matched as a whole word directly after INSERT INTO / UPDATE /
  // DELETE FROM.
  table: string;
  // Optional COLUMN narrowing. When present, only a write that also names one of these
  // columns is gated — the table itself has many legitimate non-stateful writes and it is
  // one counter on it that carries the state. A DELETE names no column and so is never
  // matched by a column-narrowed entry: removing the row is not a counter transition.
  columns?: readonly string[];
  // Repo-relative path SUFFIXES of the modules permitted to hold that DML. Suffix-matched
  // like the profile-scoping allowlist, so a nested path resolves.
  cores: readonly string[];
  // The auth-blind write core layered ABOVE the store, when the guard logic and the SQL
  // live in different modules. Named for review; not itself a scan permission (it holds
  // no DML, which is exactly the point — it can only reach the table through `cores`).
  gate?: string;
  // The shared offer-state derivation an affordance over this table should RENDER, so a
  // label always names the write it will perform (#221/#1892). Absent where the domain's
  // affordance state has not been extracted yet — an honest gap, not a claim.
  offerState?: string;
  why: string;
}

export const STATEFUL_WRITE_TABLES: readonly StatefulWriteTable[] = [
  {
    table: "cycles",
    cores: ["lib/cycle-store.ts"],
    gate: "lib/cycle-write.ts",
    offerState: "cycleControlState",
    why: "#1892/#1681: period start/end/reopen are LIFECYCLE transitions over an open-period invariant. lib/cycle-write.ts is the auth-blind core — one writeTx per transition, every refusal typed (already-open / duplicate / too-soon / too-old) and enforced with the SAME pure predicates the Cycle control, the phase widget, and the quick-log sheet render from (cycleControlState). It reaches the table only through lib/cycle-store.ts, which holds the DML; a raw write anywhere else could mint a second simultaneously-open period, which is precisely the state every derivation assumes cannot exist.",
  },
  {
    table: "illness_episodes",
    cores: ["lib/illness-episode-store.ts", "lib/illness-episode-write.ts"],
    why: "#856/#799: an episode is an open/closed LIFECYCLE row — starting, ending, reopening, and merging it drive the illness front door, the school-return finding, and the recently-resolved dismissal. The store owns the CRUD and lib/illness-episode-write.ts owns the transitions (which is why both are cores, not one plus a gate). A raw close from a third module would leave the episode's associated symptom logs, stopped meds, and encounter links unreconciled — the row-op completeness rule.",
  },
  {
    table: "shared_supplies",
    columns: ["quantity_on_hand"],
    cores: [
      "lib/queries/intake/refill.ts",
      "lib/queries/intake/supply-pool.ts",
    ],
    offerState: "refillRecencyLine",
    why: "#1374/#467: the household bottle's counter is written by MANY takers, so every adjustment is a compare-and-set under the IMMEDIATE write lock — refill.ts owns the dose decrement and the relative refill increment, supply-pool.ts owns pool create/edit and the link/unlink transfers. A raw absolute UPDATE from a fourth module would clobber a concurrent taker's decrement, which is the exact accounting split #1374 exists to end.",
  },
  {
    table: "intake_item_logs",
    cores: ["lib/queries/intake/adherence.ts"],
    // No `offerState`, honestly: DoseStatusControl already renders from the dose's
    // taken/skipped/clear state and each surface gates the control on its own
    // (active && due) read, but that derivation has not been extracted into one shared
    // pure function. An honest gap, not a claim.
    why: "#2039/#232: the dose ledger row is a LIFECYCLE row — taken ↔ skipped ↔ clear — and it is what DRIVES the supply counter one column over, so a parallel core desynchronizes the two. It had one: a tri-state twin in the nutrition Server Action module with its own DELETE/INSERT/UPDATE, its own increment/decrement crossings, and (having drifted) no paused-item refusal at all, while lib/offline/writes.ts already records a THIRD parallel dose writer that drifted and was deleted for it. lib/queries/intake/adherence.ts now owns every transition of the table — the tri-state, the one-way resolvers, the PRN administration ledger and the historical-dose corrections — each under one BEGIN IMMEDIATE with a typed refusal (stale-dose / inactive / already-taken / already-skipped). A raw INSERT from a fourth module would re-mint the #797 double-decrement the exists-check under the write lock exists to prevent.",
  },
  {
    table: "intake_items",
    columns: ["quantity_on_hand", "active"],
    cores: [
      "lib/queries/intake/refill.ts",
      "lib/queries/intake/supply-pool.ts",
      "lib/intake-active-write.ts",
      "lib/intake-obligation-write.ts",
      "lib/queries/intake/medications.ts",
    ],
    offerState: "refillRecencyLine",
    why: "#467/#1893: the PRIVATE (unpooled) supply counter, same discipline as the pool one column over — refill.ts holds the only increment/decrement, supply-pool.ts nulls and restores it across a link/unlink. #2133 added `active`: it is the pause LIFECYCLE flag, not a form field — a read-then-flip toggle inverted a stale tab's tap — so every flip is a state-named CAS in lib/intake-active-write.ts (supplements) or lib/queries/intake/medications.ts (medications, which must move course history in the same transaction). lib/intake-obligation-write.ts is a core only because its obligation CAS names `active` in its guard WHERE. Column-narrowed because intake_items carries the whole medication/supplement record: name, dose, obligation and cadence edits are ordinary last-write-wins form writes and are none of this gate's business. The item FORM's own absolute write and the importer's item CREATE are allowlisted in the scan with their justifications.",
  },
  {
    table: "medication_courses",
    cores: ["lib/queries/intake/medications.ts"],
    why: "#2132: the invariant 'intake_items.active = 1 ⇔ an open (stopped_on IS NULL) course exists' was prose enforced in one module but the table was written from THREE — exactly the illness_episodes hazard ('a raw close from a third module would leave … unreconciled'). medications.ts now owns every course transition — stop, restart, end-date, pause-sync, start-date correction, renewal and import creation — each a typed, changes-checked outcome that moves `active` in the SAME transaction. The adherence backdated-extension and the edit form's course-start write reach the table only through setCourseStartDate under the caller's Tx token. A raw close anywhere else would desync scheduling from course history, which is the state every reader assumes cannot exist.",
  },
  {
    table: "intake_item_doses",
    columns: ["retired"],
    cores: ["lib/queries/intake/dose-lifecycle.ts"],
    why: "#2131: `retired` decides whether a dose's child ledger rows are still SCHEDULED — the child table (intake_item_logs) was gated (#2074) while this parent flag was raw SQL in a Server Action with no typed outcome and no reopen. dose-lifecycle.ts owns both transitions: retire-or-delete for removed doses (retire keeps the row precisely because deleting would CASCADE away its taken history) and the guarded un-retire (only a retired dose with no conflicting live slot reopens), each bounding dueness through appended schedule versions (#1973) so neither transition ever re-judges a past day. Column-narrowed: amount/time/window edits on a live dose are ordinary form writes (the edit UPDATE's `retired = 0` guard predicate is allowlisted in the scan).",
  },
  {
    table: "intake_item_side_effects",
    columns: ["resolved"],
    cores: ["lib/queries/intake/medications.ts"],
    why: "#2133 (sibling): `resolved` is an open/closed lifecycle flag and was a blind `SET resolved = 1 - resolved` toggle, so a stale tab's 'Mark resolved' REOPENED an effect someone else had resolved. medications.ts owns the state-named CAS (setMedicationSideEffectResolved), the stop-time capture, the edit form write and the promote-to-allergy resolution — all in one module already, so the gate just keeps a second toggle from growing elsewhere. Column-narrowed: effect/severity/notes edits are ordinary form writes.",
  },
];

// True when a repo-relative path is one of an entry's registered cores.
export function isStatefulWriteCore(
  rel: string,
  entry: StatefulWriteTable
): boolean {
  return entry.cores.some((c) => rel.endsWith(c));
}

// PURE detector: does this SQL statement WRITE the entry's gated table (and, when the
// entry narrows by column, name one of those columns)?
//
// Deliberately matches only a LITERAL table name directly after the DML verb. A statement
// whose table name is interpolated (`DELETE FROM ${root.table}` — the generic undo-delete
// machinery) is invisible to a text scan and is NOT claimed to be covered; see the scan's
// own documentation of what this does and does not guarantee.
export function writesGatedTable(
  sql: string,
  entry: StatefulWriteTable
): boolean {
  const verb = new RegExp(
    `\\b(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|UPDATE(?:\\s+OR\\s+\\w+)?|DELETE\\s+FROM)\\s+${entry.table}\\b`,
    "i"
  );
  if (!verb.test(sql)) return false;
  if (!entry.columns) return true;
  return entry.columns.some((c) => new RegExp(`\\b${c}\\b`, "i").test(sql));
}
