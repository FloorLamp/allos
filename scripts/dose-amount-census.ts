// Count the stored dose amounts nothing can read (#3320).
//
//   npm run census:dose-amounts                 # the live data/allos.db
//   npm run census:dose-amounts -- /path/to.db  # any copy of it
//
// READ-ONLY, and it opens the file directly rather than through lib/db, so counting
// can never run a migration against the database it is measuring.
//
// WHY A SCRIPT AND NOT SQL. The rule that decides whether an amount reads
// (`readGroupedNumber`, #3153) cannot be expressed in SQLite, and a GLOB restatement
// of it would be a second copy of the rule — measuring with a different rule than the
// app applies is how a census ends up describing something nobody ships. The
// classification is lib/dose-amount-census.ts and it calls the shipped function.
//
// A pure-SQL PREFILTER is still useful as a ceiling — if it returns 0 there is
// nothing here to count:
//
//   SELECT COUNT(*) AS dose_rows,
//          SUM(CASE WHEN amount GLOB '*[0-9][.,][0-9]*' THEN 1 ELSE 0 END)
//            AS separator_candidates
//     FROM intake_item_doses;
//
// It over-counts on purpose: every ordinary decimal ("2.5 mg") lands in it too.
//
// WHAT THIS CENSUS CANNOT COUNT, AND HOW TO SIZE IT INSTEAD (#3444).
//
// Every bucket below classifies the TEXT IN THE COLUMN. Until #3444 the medication
// import rewrote that text before it got there: "Bisoprolol 2,5 mg" was stored with a
// dose of "5 mg", which reads identically before and after #3153 and is therefore
// counted — correctly, and uselessly — as `always-correct`. No bucket can separate
// those rows from rows that really do say 5 mg, because by the time this script sees
// them they are the same string.
//
// The item NAME is what survived, so the rows are identifiable through it. The ceiling
// is pure SQL and needs no rule at all: a medication whose NAME carries a comma decimal
// while its dose does NOT is a row where the strength was re-spelled between the two.
// Since #3444 the stored amount keeps the comma, so newly imported rows fall out of it.
//
//   SELECT i.name, d.amount
//     FROM intake_item_doses d
//     JOIN intake_items i ON i.id = d.item_id
//    WHERE i.kind = 'medication'
//      AND i.name GLOB '*[0-9],[0-9]*'
//      AND d.amount NOT GLOB '*[0-9],[0-9]*';
//
// Read it as a candidate list, not a verdict: a dose legitimately edited afterwards, or
// one taken from the sig rather than the name, lands in it too. NOTHING HERE REPAIRS
// THEM, and nothing should. A comma decimal is the exact shape `readGroupedNumber`
// refuses to resolve, so a migration would have to guess the locale this codebase has
// now twice decided not to guess. The repair is a person confirming their own label.

import "./load-env";
import path from "node:path";
import Database from "better-sqlite3";
import {
  censusDoseAmounts,
  DOSE_AMOUNT_CENSUS_BUCKETS,
  DOSE_AMOUNT_CENSUS_LABELS,
  recoverableCandidates,
  type DoseAmountCensusRow,
} from "../lib/dose-amount-census";

const log = (line: string) => {
  // eslint-disable-next-line no-console
  console.log(line);
};

function main() {
  const dbPath =
    process.argv[2] ||
    process.env.ALLOS_DB_PATH ||
    path.join(process.cwd(), "data", "allos.db");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const rows = db
    .prepare(
      `SELECT d.amount AS amount, d.retired AS retired
         FROM intake_item_doses d
         JOIN intake_items i ON i.id = d.item_id
        ORDER BY d.id`
    )
    .all() as { amount: string | null; retired: number }[];
  const census = censusDoseAmounts(
    rows.map((r): DoseAmountCensusRow => ({
      amount: r.amount,
      retired: r.retired === 1,
    }))
  );

  log(`${dbPath}`);
  log(`dose rows examined: ${census.rows}\n`);
  log(`${"bucket".padEnd(72)} ${"live".padStart(6)} ${"retired".padStart(8)}`);
  for (const bucket of DOSE_AMOUNT_CENSUS_BUCKETS) {
    const c = census.buckets[bucket];
    log(
      `${DOSE_AMOUNT_CENSUS_LABELS[bucket].padEnd(72)} ` +
        `${String(c.live).padStart(6)} ${String(c.retired).padStart(8)}`
    );
  }
  const unreadable =
    census.buckets["unreadable-recoverable"].live +
    census.buckets["unreadable-recoverable"].retired +
    census.buckets["unreadable-unrecoverable"].live +
    census.buckets["unreadable-unrecoverable"].retired;
  log(`\nunreadable under readGroupedNumber, all rows: ${unreadable}`);
  log(
    `of those, with no recoverable original: ` +
      `${census.buckets["unreadable-unrecoverable"].live} live, ` +
      `${census.buckets["unreadable-unrecoverable"].retired} retired`
  );

  // Amount strings and counts only — never an item name or a profile id.
  for (const bucket of DOSE_AMOUNT_CENSUS_BUCKETS) {
    if (bucket === "always-correct" || bucket === "no-quantity") continue;
    const samples = census.samples[bucket];
    if (samples.length === 0) continue;
    log(`\n--- ${DOSE_AMOUNT_CENSUS_LABELS[bucket]} ---`);
    for (const s of samples.slice(0, 20)) {
      const candidates =
        bucket === "unreadable-recoverable"
          ? `   -> candidate: ${recoverableCandidates(s.amount).join(", ")}`
          : "";
      log(
        `  ${String(s.rows).padStart(5)}  ${JSON.stringify(s.amount)}${candidates}`
      );
    }
  }
  db.close();
}

main();
