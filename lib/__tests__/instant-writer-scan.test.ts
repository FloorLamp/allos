import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static boundary guard for the STORED-INSTANT convention (issue #2205, phase 1).
//
// The schema carried three storage conventions for "when did this happen" — UTC with
// `Z`, UTC bare (SQLite's own `datetime('now')`), and profile-local bare — and a
// reader that assumed the wrong one for a table produced correct-looking SQL with a
// confidently wrong answer. Phase 1 unifies STORAGE: one declared serialization for
// instants, one writer helper, and this scan as the ratchet.
//
// The rule this guard freezes, in three parts:
//
//   A. A column on the CANONICAL convention (the registry below) is written through a
//      BOUND PARAMETER — i.e. from lib/date.ts's utcInstant / lib/clock.ts's
//      instantNow — never from SQL's own clock and never from a literal. SQLite's
//      `datetime('now')` writes the BARE shape; letting it default or interpolate into
//      a canonical column is exactly how a column ends up holding two conventions.
//
//   B. No statement that touches a canonical table may carry a raw SQL now-read at
//      all. A canonical column compared against `datetime('now', '-1 hour')` is a
//      LEXICAL comparison between two different serializations of UTC: for the same
//      day, 'T' (0x54) sorts after ' ' (0x20), so every canonical value looks newer
//      than every bare cutoff on that day and the window silently stops working.
//      Bind the cutoff instead.
//
//   C. A module that writes SQL may not HAND-BUILD an instant. `.toISOString()`
//      (milliseconds, `Z`) and a template like `${day} 00:00:00` are two more
//      serializations of the same quantity; both must come from lib/date.ts so the
//      shape a column receives is decided by the column, not by the call site.
//
// `date` semantics are deliberately untouched: a profile-local YYYY-MM-DD day
// attribution (#94) is the answer to a DIFFERENT question, and `.toISOString()
// .slice(0, 10)` — a day derivation, not an instant — is not a violation.
//
// This test reads the repo's own source as TEXT (no DB, no network), the same shape
// as lib/__tests__/sql-clock-seam.test.ts and lib/__tests__/profile-scoping.test.ts.
//
// SCOPE / KNOWN GAPS, stated rather than implied:
//   • Rule C's gate is "this module writes SQL". An instant hand-built in a pure
//     NORMALIZER (lib/integrations/oura.ts and its siblings map a provider payload to
//     rows another module writes) is not seen here. Those feed metric_samples, whose
//     natural-key dedupe is keyed on the stored instant — converting them is a value
//     change with an idempotency blast radius, so phase 1 leaves them and the
//     registry does not claim them.
//   • Column DEFAULTs live in shipped, immutable migrations and cannot be scanned
//     from source. A canonical table's DEFAULT is pinned by its own migration test.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const SCAN_DIRS = ["lib", "app", "scripts"];

// ---- The canonical-convention registry --------------------------------------
//
// Every column here stores `YYYY-MM-DDTHH:MM:SSZ` (lib/date.ts's utcInstant). The
// rest of the schema's instants remain on SQLite's bare shape and are written through
// utcSqlString / sqlNow; they are not a free-for-all, they are simply not yet
// converted.
//
// TWO WAYS IN, and only two:
//
//   CONVERTED — the migration that moves an existing column onto the convention adds
//   its entry in the same change as its readers. Never speculatively, because rules A
//   and B are enforced against it immediately: claiming a column is canonical before
//   its values are would fail the very statements that are still correct.
//
//   BORN ON IT — a BRAND-NEW nullable column with no rows and no writer yet
//   (`occurred_at`, migration 165). There is nothing to convert and nothing to get
//   wrong: the column is empty, so the claim cannot be false, and listing it here is
//   what makes it stay true — rule A forces the FIRST writer that lands to bind
//   utcInstant()/instantNow() instead of deciding a serialization at the call site.
//   Leaving it out until a writer existed would mean the writer's PR chooses the shape
//   and this file follows, which is the wrong order. This is the growth rule #2235
//   constraint 4 names; it applies ONLY to a column that has never held a value.
const CANONICAL_INSTANT_COLUMNS: Record<
  string,
  { columns: string[]; why: string }
> = {
  medical_records: {
    columns: ["occurred_at"],
    why: "migration 165 (#2154) — BORN canonical: the nullable event instant a vitals reading carries when somebody stated a time. No rows hold a value and nothing writes it yet, so the entry exists to bind the first writer rather than to record a conversion. `created_at` beside it stays bare and is NOT claimed here.",
  },
  body_metrics: {
    columns: ["occurred_at"],
    why: "migration 165 (#2235) — BORN canonical: the day's weigh-in instant. Same rule as medical_records, and the table's only instant column.",
  },
  intake_item_logs: {
    columns: ["occurred_at"],
    why: "migration 165 (#2229's owner ruling) — BORN canonical: this table's first event instant, filled only when a user states when a dose was actually taken. `given_at` and `taken_at` beside it are the bare-shaped RECORD chain and are NOT claimed here; the rename that settles their names is a later slot.",
  },
  integration_sync_events: {
    columns: ["at", "created_at"],
    why: "migration 163 — the sync ledger's own instants. `at` is the timestamp #2205 names: it is joined and compared against columns that carry `Z` (metric_samples' instants, a caller's ISO cursor), and it defaulted to SQLite's bare shape.",
  },
  integration_sync_rows: {
    columns: ["created_at"],
    why: "migration 163 — the per-row provenance stamp (#1333), converted with its parent so the arrival-lag join reads one convention on both sides.",
  },
};

// ---- Rule C allowlist --------------------------------------------------------
//
// Files permitted to hand-build an instant, frozen at their current count with the
// reason the value is NOT a stored instant on a convention this scan owns. A NEW
// hand-built instant anywhere fails; so does a stale count, so the ledger keeps
// shrinking. Adding an entry means asserting "no column receives this string in a
// shape the column did not declare" — say why.
const HANDBUILT_ALLOW: Record<string, { count: number; why: string }> = {
  "lib/queries/intake/adherence.ts": {
    count: 4,
    why: "the dose-burst reader and the restamp core each re-serialize ALREADY-STORED stamps (parseUtcSql → toISOString) into the in-memory `tapAt` / `statedAt` the pure burst grouping compares — `taken_at` for identity and freshness, `given_at` for the instant the row stands at (#2206). Nothing writes them: the values never reach a bind parameter, the write itself re-serializes through utcSqlString, and the burst's own output is ids plus a label.",
  },
  "lib/reading-writes.ts": {
    count: 1,
    why: "`${date}T00:00:00` — the DAY, not an instant. A reading with no stated time is filed at its profile-local day's midnight, and that string is the metric_samples natural key (profile, metric, source, origin, start_time) that makes a re-entry a correction instead of a duplicate. Moving it onto a UTC instant would change a day attribution, which #2205 constraint 4 puts out of scope by definition, AND would break the dedupe.",
  },
  "lib/ttc-store.ts": {
    count: 1,
    why: "the same day-midnight anchor for a waking BBT, whose whole point is one reading per DAY: the natural key is (profile, bbt_c, manual, origin IS NULL, `${date}T00:00:00`). Day attribution, not an instant.",
  },
  "lib/offline/writes.ts": {
    count: 1,
    why: "the same day-midnight anchor in the offline replay's manual-sample upsert — deliberately identical to the online path's so a queued tap and a live one land on ONE row. Day attribution, not an instant.",
  },
  "scripts/seed.ts": {
    count: 22,
    why: "the sample-data generator, whose job is to reproduce what each column's PRODUCTION writer actually stores — including the shapes phase 1 has not converted. Two are the Health Connect 5k session's start/end in the live normalizer's millisecond ISO shape (metric_samples' natural-key dedupe is keyed on that exact string, so a different serialization of the same session would make a real re-push insert a duplicate instead of being free); four are the #1850 peak-flow stream's morning/evening `${date}T07:30:00` / `${date}T20:00:00` start_time+end_time pairs, the same profile-local wall-clock instants recordReading writes for a timed reading and the same natural key it dedupes on; the rest are per-column bare/`Z` stamps and day-midnight anchors matching their writers. Frozen: seeding a NEW shape fails here, and each migration that converts a column lowers this count in the same change.",
  },
  "lib/photo/metadata-backfill.ts": {
    count: 3,
    why: "the #1844 backfill's claim marker — `claimedAt` / `finishedAt` inside a JSON blob written to `settings.value`, which is an opaque TEXT column, not a datetime one. Nothing compares these in SQL: `photoBackfillDue` parses `claimedAt` with `Date.parse` and compares MILLISECONDS in JS against the stale-claim window, so the lexical hazard rules A–C exist for cannot arise. A datetime column is never bound from here.",
  },
};

function isExcluded(rel: string): boolean {
  return (
    rel.includes("__tests__") ||
    rel.includes("__db_tests__") ||
    rel.includes("__action_tests__") ||
    rel.endsWith(".test.ts") ||
    rel.endsWith(".test.tsx") ||
    // Shipped migrations are immutable (lib/migrations/manifest.json). A migration
    // that CONVERTS a column necessarily writes both shapes; a fix there is an
    // appended migration, never an edit.
    rel.startsWith("lib/migrations/versions/") ||
    // The definition sites of the convention itself.
    rel === "lib/date.ts" ||
    rel === "lib/clock.ts"
  );
}

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

function sourceFiles(): { rel: string; text: string }[] {
  const files: { rel: string; text: string }[] = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const full of walk(abs)) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (isExcluded(rel)) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

// Strip line and block comments so PROSE about a convention — of which this codebase
// has plenty, including the explanations phase 1 added — can't trip the scanner.
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ---- SQL extraction ----------------------------------------------------------
//
// SQL reaches the driver as a string or template literal argument to db.prepare(), so
// each literal is at most one statement. Pulling the literals out (rather than
// regexing the whole file) keeps a SQL keyword in a comment, a variable name or a
// user-facing string from being read as a statement.
function sqlLiterals(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let j = i + 1;
      let body = "";
      while (j < text.length) {
        if (text[j] === "\\") {
          body += text[j] + (text[j + 1] ?? "");
          j += 2;
          continue;
        }
        if (text[j] === quote) break;
        // A newline ends an unterminated single/double-quoted literal (JS forbids it),
        // which keeps a stray apostrophe in prose from swallowing the rest of a file.
        if (quote !== "`" && text[j] === "\n") break;
        body += text[j];
        j++;
      }
      if (/\b(INSERT|UPDATE|DELETE|SELECT)\b/i.test(body)) out.push(body);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

// Split on commas that are not inside parentheses or a SQL string literal.
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let quote: string | null = null;
  for (const c of s) {
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// The body of the parenthesised group starting at `open`, plus the index of its
// closing paren. Null when unbalanced (a truncated literal).
function balanced(
  s: string,
  open: number
): { body: string; end: number } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return { body: s.slice(open + 1, i), end: i };
    }
  }
  return null;
}

const IDENT = String.raw`["'\`]?([A-Za-z_][A-Za-z0-9_]*)["'\`]?`;

// (column, value-expression) pairs a statement writes, per target table.
interface Written {
  table: string;
  column: string;
  value: string;
}

function writesIn(sql: string): Written[] {
  const out: Written[] = [];

  // INSERT [OR ...] INTO <t> (cols) VALUES (vals) [... ON CONFLICT ... DO UPDATE SET ...]
  const insertHead = new RegExp(
    String.raw`INSERT\s+(?:OR\s+\w+\s+)?INTO\s+${IDENT}\s*(?=\()`,
    "gi"
  );
  for (let m = insertHead.exec(sql); m; m = insertHead.exec(sql)) {
    const table = m[1];
    const cols = balanced(sql, m.index + m[0].length);
    if (!cols) continue;
    const valuesAt = sql.slice(cols.end).search(/VALUES\s*\(/i);
    if (valuesAt < 0) continue;
    const openAt = sql.indexOf("(", cols.end + valuesAt);
    const vals = balanced(sql, openAt);
    if (!vals) continue;
    const names = splitTopLevel(cols.body).map((c) =>
      c.replace(/["'`]/g, "").trim()
    );
    const exprs = splitTopLevel(vals.body);
    names.forEach((column, idx) => {
      if (exprs[idx] !== undefined)
        out.push({ table, column, value: exprs[idx] });
    });
    // The upsert half writes the same table.
    const conflict = /DO\s+UPDATE\s+SET\s+/i.exec(sql.slice(vals.end));
    if (conflict) {
      const from = vals.end + conflict.index + conflict[0].length;
      out.push(...assignments(table, sql.slice(from)));
    }
  }

  // UPDATE <t> SET <assignments> [WHERE ...]
  const updateHead = new RegExp(String.raw`\bUPDATE\s+${IDENT}\s+SET\s+`, "gi");
  for (let m = updateHead.exec(sql); m; m = updateHead.exec(sql)) {
    if (/^SET$/i.test(m[1])) continue; // "DO UPDATE SET", handled above
    out.push(...assignments(m[1], sql.slice(m.index + m[0].length)));
  }

  return out;
}

// `col = expr, col = expr` up to the clause's end.
function assignments(table: string, tail: string): Written[] {
  let depth = 0;
  let quote: string | null = null;
  let end = tail.length;
  for (let i = 0; i < tail.length; i++) {
    const c = tail[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) {
        end = i;
        break;
      }
      depth--;
    } else if (depth === 0 && /\s/.test(c)) {
      const rest = tail.slice(i);
      if (/^\s+(WHERE|RETURNING|FROM)\b/i.test(rest)) {
        end = i;
        break;
      }
    }
  }
  return splitTopLevel(tail.slice(0, end))
    .map((a) => {
      const eq = a.indexOf("=");
      if (eq < 0) return null;
      return {
        table,
        column: a.slice(0, eq).replace(/["'`]/g, "").trim(),
        value: a.slice(eq + 1).trim(),
      };
    })
    .filter((w): w is Written => w !== null);
}

// A raw now-read in SQL text (same vocabulary as lib/__tests__/sql-clock-seam.test.ts).
const NOW_READ_RE =
  /(?:\b(?:date|datetime|julianday|strftime|unixepoch)\s*\(\s*[^)]*'now')|\bCURRENT_TIMESTAMP\b/i;

const SQL_WRITE_RE =
  /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE\s+\w+\s+SET)\b/i;

// A hand-built instant: an ISO serialization, or a template that assembles one out of
// a date and a wall clock.
//
// Two shapes are deliberately NOT instants and must not be flagged:
//   • `.toISOString().slice(0, 10)` — a calendar DAY (#94 semantics, untouched here).
//   • `Date.parse(`${day}T00:00:00Z`)` / `new Date(...)` — the UTC-anchored day
//     arithmetic lib/date.ts itself uses. The string never leaves as a string; it is
//     immediately consumed as a number of days.
const HANDBUILT_RE =
  /\.toISOString\(\)(?!\s*\.slice\(\s*0\s*,\s*10\s*\))|`\$\{[^`]*\}[ T]\d{2}:\d{2}:\d{2}/g;

const DAY_ARITHMETIC_PREFIX = /(?:Date\.parse|new Date)\s*\(\s*$/;

function countHandbuilt(text: string): number {
  const stripped = stripComments(text);
  let n = 0;
  for (const m of stripped.matchAll(HANDBUILT_RE)) {
    if (DAY_ARITHMETIC_PREFIX.test(stripped.slice(0, m.index))) continue;
    n++;
  }
  return n;
}

describe("stored-instant convention (issue #2205, phase 1)", () => {
  it("A. every canonical instant column is written through a bound parameter", () => {
    const violations: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      for (const sql of sqlLiterals(stripComments(text))) {
        for (const w of writesIn(sql)) {
          const declared = CANONICAL_INSTANT_COLUMNS[w.table];
          if (!declared || !declared.columns.includes(w.column)) continue;
          if (w.value === "?") continue;
          // `excluded.<col>` in an upsert forwards the bound VALUES expression.
          if (/^excluded\.\w+$/i.test(w.value)) continue;
          violations.push(
            `${rel}: ${w.table}.${w.column} is written as \`${w.value}\`. ` +
              `It is on the canonical UTC+Z convention (${declared.why}) — bind ` +
              `utcInstant()/instantNow() instead, so the stored shape comes from ` +
              `lib/date.ts and not from SQLite's own bare-shaped clock.`
          );
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("B. no statement touching a canonical instant table carries a raw SQL now-read", () => {
    // The rule is TABLE-scoped on purpose — a bare cutoff anywhere in a statement can
    // meet a canonical column through a join or an ORDER BY, so the safe unit is the
    // statement, not the column. Note the consequence for a MIXED table
    // (medical_records, body_metrics, intake_item_logs, whose occurred_at is canonical
    // while their other instants are still bare): a now-read is refused there even
    // when the column it meets happens to be a bare one. That is deliberate — the
    // sibling ratchet in lib/__tests__/sql-clock-seam.test.ts already requires a
    // reasoned allowlist entry for any new raw now-read, so the marginal cost is nil
    // and binding the cutoff is what that scan would have asked for anyway.
    const tables = Object.keys(CANONICAL_INSTANT_COLUMNS);
    const violations: string[] = [];
    if (tables.length > 0) {
      const mentions = new RegExp(`\\b(?:${tables.join("|")})\\b`, "i");
      for (const { rel, text } of sourceFiles()) {
        for (const sql of sqlLiterals(stripComments(text))) {
          if (!mentions.test(sql) || !NOW_READ_RE.test(sql)) continue;
          violations.push(
            `${rel}: a statement over ${sql.match(mentions)?.[0]} reads SQL's own ` +
              `clock. Its instants are stored as 'YYYY-MM-DDTHH:MM:SSZ' and SQLite ` +
              `renders 'now' as 'YYYY-MM-DD HH:MM:SS', so the comparison is between ` +
              `two serializations and sorts wrong. Bind the instant/cutoff from ` +
              `utcInstant() instead.\n  ${sql.replace(/\s+/g, " ").trim().slice(0, 160)}`
          );
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("C. no module that writes SQL hand-builds an instant", () => {
    const violations: string[] = [];
    const seen = new Set<string>();
    for (const { rel, text } of sourceFiles()) {
      const stripped = stripComments(text);
      if (!SQL_WRITE_RE.test(stripped) && !HANDBUILT_ALLOW[rel]) continue;
      const count = countHandbuilt(text);
      if (count === 0 && !HANDBUILT_ALLOW[rel]) continue;
      seen.add(rel);
      const allowed = HANDBUILT_ALLOW[rel]?.count ?? 0;
      if (count > allowed) {
        violations.push(
          `${rel}: ${count} hand-built instant(s), allowlist freezes ${allowed}. ` +
            `A stored instant comes from lib/date.ts — utcInstant()/instantNow() for ` +
            `a canonical column, utcSqlString()/sqlNow() for one still on SQLite's ` +
            `bare shape. If the value is never stored, raise its entry in ` +
            `lib/__tests__/instant-writer-scan.test.ts WITH the reason.`
        );
      } else if (count < allowed) {
        violations.push(
          `${rel}: ${count} hand-built instant(s) but the allowlist freezes ${allowed}. ` +
            `You removed one — LOWER (or delete) its entry in ` +
            `lib/__tests__/instant-writer-scan.test.ts so the ledger keeps shrinking.`
        );
      }
    }
    for (const rel of Object.keys(HANDBUILT_ALLOW)) {
      if (!seen.has(rel)) {
        violations.push(
          `${rel}: allowlisted but the file no longer exists (or no longer writes ` +
            `SQL) — remove its entry in lib/__tests__/instant-writer-scan.test.ts.`
        );
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("every allowlist / registry entry states its reason", () => {
    const thin = [
      ...Object.entries(HANDBUILT_ALLOW),
      ...Object.entries(CANONICAL_INSTANT_COLUMNS),
    ]
      .filter(([, v]) => v.why.trim().length < 20)
      .map(([rel]) => rel);
    expect(
      thin,
      `These entries need a real reason (what the value is, and why it is or is not ` +
        `a stored instant):\n${thin.join("\n")}`
    ).toEqual([]);
  });

  it("the writer helpers exist where the convention says they do", () => {
    const date = fs.readFileSync(path.join(REPO, "lib/date.ts"), "utf8");
    expect(/export function utcInstant\b/.test(date)).toBe(true);
    expect(/export function toUtcInstant\b/.test(date)).toBe(true);
    expect(/export function utcSqlString\b/.test(date)).toBe(true);
    const clock = fs.readFileSync(path.join(REPO, "lib/clock.ts"), "utf8");
    expect(/export function instantNow\b/.test(clock)).toBe(true);
  });
});

describe("the SQL extraction the scan relies on", () => {
  // The scanner is only as good as its parse, and a silently-empty parse would make
  // every rule above pass vacuously. These pin the shapes the repo actually writes.
  it("aligns INSERT columns with their value expressions", () => {
    const w = writesIn(
      `INSERT INTO integration_sync_events
         (profile_id, provider, at, ok)
       VALUES (?, ?, datetime('now'), ?)`
    );
    expect(w).toContainEqual({
      table: "integration_sync_events",
      column: "at",
      value: "datetime('now')",
    });
  });

  it("reads an UPDATE's SET clause and stops at WHERE", () => {
    const w = writesIn(
      "UPDATE import_jobs SET status = ?, updated_at = datetime('now') WHERE id = ?"
    );
    expect(w).toContainEqual({
      table: "import_jobs",
      column: "updated_at",
      value: "datetime('now')",
    });
    expect(w.map((x) => x.column)).not.toContain("id");
  });

  it("reads the upsert half of an ON CONFLICT statement", () => {
    const w = writesIn(
      `INSERT INTO hr_minutes (profile_id, ts, bpm) VALUES (?, ?, ?)
       ON CONFLICT(profile_id, ts) DO UPDATE SET bpm = excluded.bpm, ts = datetime('now')`
    );
    expect(w).toContainEqual({
      table: "hr_minutes",
      column: "ts",
      value: "datetime('now')",
    });
  });

  it("sees SQL only inside literals, not in prose or identifiers", () => {
    expect(
      sqlLiterals(`const updateSelected = 1; // UPDATE foo SET bar = 1`)
    ).toEqual([]);
    expect(sqlLiterals(`db.prepare("SELECT 1 FROM x")`)).toEqual([
      "SELECT 1 FROM x",
    ]);
  });

  it("counts a hand-built instant but not a day derivation", () => {
    expect(countHandbuilt("const a = d.toISOString();")).toBe(1);
    expect(countHandbuilt("const a = d.toISOString().slice(0, 10);")).toBe(0);
    expect(countHandbuilt("const a = `${day} 00:00:00`;")).toBe(1);
    expect(countHandbuilt("const a = `${day}T04:30:00`;")).toBe(1);
    expect(countHandbuilt("const a = Date.parse(`${day}T00:00:00Z`);")).toBe(0);
  });
});
