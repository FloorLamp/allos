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
    table: "intake_items",
    columns: ["quantity_on_hand"],
    cores: [
      "lib/queries/intake/refill.ts",
      "lib/queries/intake/supply-pool.ts",
    ],
    offerState: "refillRecencyLine",
    why: "#467/#1893: the PRIVATE (unpooled) supply counter, same discipline as the pool one column over — refill.ts holds the only increment/decrement, supply-pool.ts nulls and restores it across a link/unlink. Column-narrowed because intake_items carries the whole medication/supplement record: name, dose, obligation and cadence edits are ordinary last-write-wins form writes and are none of this gate's business. The item FORM's own absolute write is allowlisted in the scan with its #467 compare-and-set justification.",
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
