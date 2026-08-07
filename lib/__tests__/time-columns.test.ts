// PURE TIER — the declared temporal-column index (issue #2205 phase 3).
//
// Two jobs, both of them ratchets:
//
//   1. The registry's own INTERNAL consistency, and the freshness of the docs page it
//      generates. #2090 was closed because a hand-maintained index next to a moving
//      schema stops being true; the fix is only worth anything if the published copy
//      cannot fall behind the declaration.
//
//   2. A SOURCE SCAN over the fallbacks the row readers exist to replace. A dozen
//      surfaces hand-roll `COALESCE(given_at, taken_at)` and four more pair
//      `eaten_at ?? logged_at`. Both are declared fallbacks now — the first WITHIN the
//      record question (the owner's #2205 ruling made given_at a record instant), the
//      second ACROSS questions, which is the one that has to stay visible. Each is
//      frozen at its current count with a reason; a NEW one fails, and converting one
//      must LOWER the count, so the ledger only shrinks.
//
// The companion DB-tier scan (lib/__db_tests__/time-column-index.test.ts) is what
// checks the registry against the real schema — it needs a migrated database, which
// this tier does not open.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NOT_TEMPORAL,
  TIME_COLUMNS,
  TIME_COLUMN_INDEX_DOC,
  timeColumnIndexBlock,
  timeColumnsFor,
  type TemporalTable,
  type TimeColumn,
} from "@/lib/time-columns";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const SEMANTICS = new Set([
  "event",
  "record",
  "window-start",
  "window-end",
  "day",
  "planned",
  "lifecycle",
  "bookkeeping",
]);
const GRAINS = new Set([
  "instant",
  "day",
  "local-datetime",
  "time-of-day",
  "mixed",
]);
const CONVENTIONS = new Set([
  "canonical",
  "bare",
  "iso-ms",
  "mixed",
  "unverified",
  "n/a",
]);

function entries(): { table: TemporalTable; col: TimeColumn }[] {
  const out: { table: TemporalTable; col: TimeColumn }[] = [];
  for (const table of Object.keys(TIME_COLUMNS) as TemporalTable[]) {
    for (const col of TIME_COLUMNS[table] as readonly TimeColumn[]) {
      out.push({ table, col });
    }
  }
  return out;
}

describe("the declared index is internally consistent", () => {
  it("uses only the declared vocabulary", () => {
    // The types already say this; the registry is DATA, and a `satisfies` clause is
    // checked at build time only. This is the runtime half, so a hand edit that slips
    // past a stale build still fails.
    const bad = entries()
      .filter(
        ({ col }) =>
          !SEMANTICS.has(col.semantic) ||
          !GRAINS.has(col.grain) ||
          !CONVENTIONS.has(col.convention)
      )
      .map(({ table, col }) => `${table}.${col.column}`);
    expect(bad, bad.join(", ")).toEqual([]);
  });

  it("states an instant convention for instants and none for anything else", () => {
    const bad: string[] = [];
    for (const { table, col } of entries()) {
      const isInstant = col.grain === "instant";
      if (isInstant && col.convention === "n/a") {
        bad.push(
          `${table}.${col.column}: instant-grained but declares no convention`
        );
      }
      if (!isInstant && col.convention !== "n/a") {
        bad.push(
          `${table}.${col.column}: grain ${col.grain} has no instant serialization, so convention must be "n/a"`
        );
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("keeps `day` semantics day-grained", () => {
    // #2205 constraint 4: a profile-local day is a different question from an instant,
    // and nothing in phase 3 may quietly promote one.
    const bad = entries()
      .filter(({ col }) => col.semantic === "day" && col.grain !== "day")
      .map(({ table, col }) => `${table}.${col.column}`);
    expect(bad, bad.join(", ")).toEqual([]);
  });

  it("declares at most one event column per table", () => {
    // A RECORD chain is legitimate — intake_item_logs falls from given_at to taken_at,
    // and both answer "when did this enter the app". An EVENT chain never is: falling
    // from one event column to another would be a substitution wearing a declaration.
    const bad = (Object.keys(TIME_COLUMNS) as TemporalTable[])
      .filter((t) => timeColumnsFor(t, "event").length > 1)
      .map((t) => `${t}: ${timeColumnsFor(t, "event").length} event columns`);
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("explains every record chain, link by link", () => {
    // A second record column is a fallback the readers will silently take, so each
    // link has to say why it belongs in the chain and where it sits.
    const bad: string[] = [];
    for (const table of Object.keys(TIME_COLUMNS) as TemporalTable[]) {
      const chain = timeColumnsFor(table, "record");
      if (chain.length < 2) continue;
      for (const col of chain) {
        if ((col.note ?? "").trim().length < 40) {
          bad.push(
            `${table}.${col.column} is part of a record chain with no explanation`
          );
        }
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("requires a note wherever the declaration is not self-explanatory", () => {
    // `mixed` and `unverified` are the two values that state a PROBLEM rather than a
    // fact. Either without a note is the rot this file exists to prevent.
    const bad = entries()
      .filter(
        ({ col }) =>
          (col.grain === "mixed" ||
            col.convention === "mixed" ||
            col.convention === "unverified") &&
          (col.note ?? "").trim().length < 20
      )
      .map(({ table, col }) => `${table}.${col.column}`);
    expect(bad, bad.join(", ")).toEqual([]);
  });

  it("freezes the mixed ledger so it can only shrink", () => {
    // THE #2245 RATCHET. `mixed` states a PROBLEM — this column holds more than one
    // shape — and the first real defect in this registry was a column declared
    // `grain: "instant"` / `convention: "mixed"` on the strength of a note copied
    // from a same-named column in another table. The note was prose and prose does
    // not fail CI; a FIELD VALUE frozen in an explicit list does. `unverified`
    // already worked this way and `mixed` did not, which is why one of them caught
    // nothing.
    //
    // Adding a name here is the point: it forces the claim "this column really does
    // hold two shapes" to be made deliberately, next to every other column making
    // it, rather than typed once into a field nobody reads back. Removing one — as
    // #2245 removed activities.start_time and end_time, which held a profile-local
    // HH:MM and nothing else — is the ratchet turning.
    const mixed = (kind: "grain" | "convention") =>
      entries()
        .filter(({ col }) => col[kind] === "mixed")
        .map(({ table, col }) => `${table}.${col.column}`)
        .sort();

    // #2234 split appointments.scheduled_at into date + time_of_day, retiring the
    // last mixed-GRAIN column — the ratchet turning again. A future entry here is
    // a deliberate claim that a new column really holds two shapes.
    expect(mixed("grain")).toEqual([]);
    expect(mixed("convention")).toEqual([
      "integration_backfill_jobs.finished_at",
      "integration_backfill_jobs.retry_after_at",
      "integration_backfill_jobs.started_at",
      "integration_connections.last_sync_at",
      "integration_connections.refresh_claimed_at",
      "metric_samples.end_time",
      "metric_samples.start_time",
    ]);
  });

  it("freezes the unverified ledger so it can only shrink", () => {
    // Every entry here is a column whose stored serialization is settled by neither a
    // schema DEFAULT nor a writer that was read. That is the phase-2 worklist. A new
    // one has to be justified out loud; a resolved one has to lower this number.
    const unverified = entries()
      .filter(({ col }) => col.convention === "unverified")
      .map(({ table, col }) => `${table}.${col.column}`)
      .sort();
    expect(unverified).toEqual([
      "activity_telemetry.snapshot_at",
      "coverage_gaps.ai_generated_at",
    ]);
  });

  it("gives every NOT_TEMPORAL exemption a reason", () => {
    const thin = Object.entries(NOT_TEMPORAL)
      .filter(([, why]) => why.trim().length < 20)
      .map(([name]) => name);
    expect(thin, thin.join(", ")).toEqual([]);
  });
});

describe("the published index cannot fall behind the declaration", () => {
  it("matches the committed docs page", () => {
    const doc = fs.readFileSync(path.join(REPO, TIME_COLUMN_INDEX_DOC), "utf8");
    expect(
      doc.includes(timeColumnIndexBlock()),
      `${TIME_COLUMN_INDEX_DOC} is stale — run \`npm run gen:time-columns\` and commit the result.`
    ).toBe(true);
  });
});

// ---- The hand-rolled-pairing ledger -----------------------------------------
//
// Files permitted to pair a table's event and record columns by hand, frozen at their
// current count with the reason the pairing has not moved to `bestKnownInstant` yet.
// The reason may be "not converted yet" — what it may not be is absent, because the
// point of the ledger is that each of these is a decision somebody made rather than a
// spelling.
const PAIRING_ALLOW: Record<string, { count: number; why: string }> = {
  "lib/queries/intake/adherence.ts": {
    count: 7,
    why: "the adherence reader's SQL — one projection and six ORDER BY / MAX() expressions walking the given_at → taken_at RECORD CHAIN. Correct values (the owner's #2205 ruling settled that both links answer one question), spelled by hand in seven places. Routing them through recordInstant means selecting both columns and ordering in JS, which changes the perf shape of the medication surface's hottest query — a read-path change with its own PR.",
  },
  "lib/queries/nutrition.ts": {
    count: 3,
    why: "the EATING-TIME reads: the eating-minute distribution and the recent-serving lookup, each pairing `eaten_at` with `logged_at` (the meal-event projection stopped collapsing them in #2227 — it now carries both facts so the correction sheet can say which one it shows). This is the sharpest instance of the substitution in the repo — an eating-time distribution that quietly includes tap times for every serving nobody stated a time for — and the module's own comments already say so. Converting the rest is a product decision about what those charts should show when the instant is undeclared, not a mechanical swap, so #2205 phase 3 declares it and leaves the answer to its own change.",
  },
  "lib/queries/search.ts": {
    count: 1,
    why: "`ORDER BY COALESCE(onset_date, created_at)` over allergies, which pairs a DAY with an INSTANT — the two sort against each other lexically and a same-day pair therefore orders arbitrarily. Search ordering is cosmetic, so this is logged rather than urgent, but it is a genuine grain confusion and belongs in phase 2's sweep.",
  },
  "lib/school-return-data.ts": {
    count: 1,
    why: "the ORDER BY that sequences a day's administrations over the record chain. The JS-side read moved to bestKnownInstant in #2205 phase 3; the SQL ordering stays until the same pass converts the query shape.",
  },
  "lib/illness-episode.ts": {
    count: 1,
    why: "as school-return-data: the ORDER BY only. The row read moved to bestKnownInstant.",
  },
  "app/(app)/medications/med-data.ts": {
    count: 2,
    why: "the medication detail's administration list and its 'last taken' label. A rendered surface, so converting it needs a browser test in the same change — deliberately left to the surface's own PR rather than smuggled into the substrate one.",
  },
  "lib/food-slot-count.ts": {
    count: 1,
    why: "`eatenAt ?? loggedAt` deciding which meal window a serving falls in. This one is a deliberate product decision, not an oversight: every serving must land in a slot, and the tap stamp is the app's best evidence when nobody stated a time. It should become an explicit bestKnownInstant so the substitution is visible, which is a behaviour-identical change to a pure module — but it is a change to a module several nudges read, so it ships on its own.",
  },
  "lib/profile-food-slot.ts": {
    count: 1,
    why: "the DB-reading twin of food-slot-count's pairing, and it moves with it.",
  },
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const camel = (snake: string): string =>
  snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

// Every (event, record) pair the registry declares, in both the SQL spelling and the
// JS one. Each pair carries the event column's spelling as a cheap `includes` gate:
// almost no file mentions any of them, so the regex work is skipped outright rather
// than run ~80 times over every file in the repo.
interface PairPattern {
  needle: string;
  re: RegExp;
}

function pairPatterns(): PairPattern[] {
  const out: PairPattern[] = [];
  for (const table of Object.keys(TIME_COLUMNS) as TemporalTable[]) {
    // The table's declared FALLBACK ORDER: its event column, then its record chain.
    // Any ordered pair drawn from it is a substitution a reader can hand-roll —
    // whether it crosses the event/record line (`eaten_at ?? logged_at`) or stays
    // inside the record question (`COALESCE(given_at, taken_at)`). Both belong to
    // lib/row-instants.ts now, so both are counted here.
    const chain = [
      ...timeColumnsFor(table, "event"),
      ...timeColumnsFor(table, "record"),
    ];
    const pairs: string[][] = [];
    for (let i = 0; i < chain.length; i++) {
      for (let j = i + 1; j < chain.length; j++) {
        pairs.push([chain[i].column, chain[j].column]);
        pairs.push([camel(chain[i].column), camel(chain[j].column)]);
      }
    }
    for (const [e, r] of pairs) {
      // `\b` already lets `a.given_at` and `admins[0].given_at` match, so no member
      // path has to be spelled out — which is also what keeps the regex linear.
      out.push({
        needle: e,
        re: new RegExp(
          String.raw`COALESCE\s*\(\s*[\w.]*\b${e}\b\s*,\s*[\w.]*\b${r}\b\s*\)` +
            "|" +
            String.raw`\b${e}\b\s*(?:\?\?|\|\|)\s*[\w.$\[\]]*\b${r}\b`,
          "g"
        ),
      });
    }
  }
  return out;
}

function countPairings(text: string, patterns: PairPattern[]): number {
  let n = 0;
  for (const p of patterns) {
    if (!text.includes(p.needle)) continue;
    n += [...text.matchAll(p.re)].length;
  }
  return n;
}

describe("the event/record pairing ledger (issue #2205 phase 3)", () => {
  it("freezes every hand-rolled pairing, so the ledger only shrinks", () => {
    const patterns = pairPatterns();
    const counts = new Map<string, number>();
    for (const dir of ["lib", "app", "components", "scripts"]) {
      const abs = path.join(REPO, dir);
      if (!fs.existsSync(abs)) continue;
      for (const full of walk(abs)) {
        const rel = path.relative(REPO, full).split(path.sep).join("/");
        if (
          rel.includes("__tests__") ||
          rel.includes("__db_tests__") ||
          rel.includes("__action_tests__") ||
          rel.startsWith("lib/migrations/versions/") ||
          // The readers themselves, and the module that declares the pairs.
          rel === "lib/row-instants.ts" ||
          rel === "lib/time-columns.ts"
        ) {
          continue;
        }
        const text = stripComments(fs.readFileSync(full, "utf8"));
        const n = countPairings(text, patterns);
        if (n > 0) counts.set(rel, n);
      }
    }

    const violations: string[] = [];
    for (const [rel, n] of counts) {
      const allowed = PAIRING_ALLOW[rel]?.count ?? 0;
      if (n > allowed) {
        violations.push(
          `${rel}: ${n} hand-rolled event/record pairing(s), ledger freezes ${allowed}. ` +
            `Ask the question instead: bestKnownInstant(table, row) returns the event ` +
            `instant when there is one, the record instant otherwise, and SAYS which. ` +
            `If the pairing genuinely has to stay, raise its entry in ` +
            `lib/__tests__/time-columns.test.ts WITH the reason.`
        );
      } else if (n < allowed) {
        violations.push(
          `${rel}: ${n} pairing(s) but the ledger freezes ${allowed} — LOWER (or delete) ` +
            `its entry in lib/__tests__/time-columns.test.ts so the ledger keeps shrinking.`
        );
      }
    }
    for (const rel of Object.keys(PAIRING_ALLOW)) {
      if (!counts.has(rel)) {
        violations.push(
          `${rel}: allowlisted but no pairing found — remove its entry in ` +
            `lib/__tests__/time-columns.test.ts.`
        );
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("gives every ledger entry a real reason", () => {
    const thin = Object.entries(PAIRING_ALLOW)
      .filter(([, v]) => v.why.trim().length < 40)
      .map(([rel]) => rel);
    expect(thin, thin.join("\n")).toEqual([]);
  });

  it("detects the pairing shapes the repo actually writes", () => {
    // A silently-empty match set would make the ledger pass vacuously.
    const patterns = pairPatterns();
    const hits = (s: string) => countPairings(s, patterns);
    expect(hits("ORDER BY COALESCE(l.given_at, l.taken_at) ASC")).toBe(1);
    expect(hits("const stored = r.given_at ?? r.taken_at;")).toBe(1);
    expect(hits("new Date(eatenAt ?? loggedAt)")).toBe(1);
    // The other direction is not a substitution and must not be flagged.
    expect(hits("const stamp = r.taken_at ?? r.given_at;")).toBe(0);
  });
});
