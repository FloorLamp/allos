import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static guard for the date/time display-pref rollout (#964, finished by #1020) —
// the profile-scoping / telegram-chokepoint source-scan pattern applied to date
// rendering. It reads the repo's own production source as TEXT (no DB, no
// browser, so it stays "pure" in the vitest sense) and enforces two rules:
//
//   (i)  No implicit-locale Date formatting. `.toLocaleDateString(` /
//        `.toLocaleTimeString(` / `.toLocaleString(` render in the RUNTIME's
//        locale — on the server that's the host's locale (not even a stable
//        default), on the client the browser's, and both float free of the
//        login's date/time prefs. Every date render goes through the pref-aware
//        formatters in lib/format-date (or lib/record-format). Numeric
//        thousands-separator formatting is fine when the locale is pinned:
//        `.toLocaleString("en-US")` is allowed anywhere. The admin ops pages
//        (Active sessions, error/AI log tables, Settings → Server timestamps)
//        were grandfathered here by #1020 and were migrated by #1448, so the
//        allowlist is now EMPTY.
//
//  (iii) No raw `<input type="date">`. A native date control renders its value
//        in the BROWSER's format, which the app neither chooses nor can style —
//        a fifth date shape sitting beside pref-aware fields on the same form
//        (issue #1448). components/DateField.tsx is the styled, pref-aware
//        replacement; two deliberate survivors are frozen below.
//
// Both allowlists are per-file COUNT freezes (the e2e-hygiene model): an entry
// only ever shrinks — going below the frozen count fails with a message to lower
// it here in the same PR, so the lists can't silently go stale; a NEW occurrence
// (count above frozen, or a new file) fails the build.
//
// ---- Rule (ii) MOVED TO THE TYPE SYSTEM (#5351, owner ruling 2026-09-05) ------
//
// The numbering above keeps its holes on purpose. Rule (ii) banned pref-LESS calls
// of the pref-taking formatters by counting call arguments in source text against a
// per-formatter table, with a per-file allowlist for the login-less channels. That
// invariant is now the compiler's: `prefs` is a REQUIRED parameter on all NINE
// `DisplayFormatPrefs`-taking formatters — `formatLongDate`, `formatMonthDay`,
// `formatDateWithYear`, `formatWeekdayDate`, `formatTimestampDisplay` and
// `formatTimestamp` in lib/format-date.ts, `formatRecordDate`,
// `formatRecordDateTime` and `formatVisitLabel` in lib/record-format.ts — so
// omitting it is TS2554 at the call site rather than a text match here. The
// login-less channels (Telegram/push/HA sends, the .ics feed — a profile but no
// login in context) now pass `DEFAULT_FORMAT_PREFS` by name at the three files
// entitled to it, which is the point of the conversion: the fixed shape is a stated
// choice where it is exercised instead of an invisible fallback on the formatter.
//
// The scan's own table is why converting beat trusting it. It named six formatters
// when ten take a display pref — `formatWeekdayDate`, `formatTimestampDisplay`,
// `formatVisitLabel` and `formatClockValue` were never in it — and it recorded
// `formatRecordDateTime`'s prefs as the 3rd argument when the signature puts it
// 4th, so a three-argument pref-less call passed. That is
// docs/internals/verification-failure-modes.md line 83 exactly: a guard that lists
// a union's members does not track the union.
//
// TWO RESIDUES, named rather than claimed away. `formatClockValue` is the tenth,
// and it keeps its `timeFormat = DEFAULT_FORMAT_PREFS.timeFormat` default: no
// production call omits the argument today, but five pass a `timeFormat?:` carrier
// that may be `undefined` (four in lib/illness-episode-format.ts, one through
// lib/emergency-card-load.ts's login-less `getEmergencyCard`), so requiring it is a
// second cascade with its own login-less policy question and was out of this slice.
// Separately, about forty second-tier helpers — `visitFacts`, `resultFacts`, the
// rule-findings builders, `EpisodeSummary` and the rest — still take `prefs` with a
// `= DEFAULT_FORMAT_PREFS` parameter default or an `?? DEFAULT_FORMAT_PREFS`
// fallback of their own, so a pref-less call one level ABOVE the formatters is
// still silent. Rule (ii) saw neither: its table listed leaf formatters only, and a
// wrapper that passes its own default satisfies an argument COUNT. Neither is
// protection this slice gave up; both are what a later slice would take.
//
// lib/__tests__/format-locale-leak.test.ts (44 lines) went in the same commit. Its
// ban on `toLocale*(undefined` across four formatter modules is a strict SUBSET of
// rule (i) above, which bans every non-"en-US" `.toLocale*String(` call in all of
// app/, components/ and lib/ against an EMPTY allowlist — a live successor already
// in this file, not a deletion into thin air. Verified by planting
// `.toLocaleDateString(undefined, {})` in each of its four modules
// (lib/record-format.ts, lib/administration-format.ts, lib/format-date.ts,
// lib/training-log-card.ts) in turn: rule (i) below reds on all four.
//
// ---- Rule (i) STAYS, and is waiting on lint --------------------------------
//
// #5351's table routes the `toLocale*` ban to an ESLint rule. `eslint.config.mjs`
// has no such rule today, and no TYPE can state "this module contains no
// `.toLocaleDateString(` call", so until that lint rule exists this scan is the
// only thing holding the ban and it stays. Whoever owns eslint.config.mjs retires
// rule (i) — and only rule (i) — by porting TOLOCALE_RE to a `no-restricted-syntax`
// selector and deleting its block here. Rule (iii) is neither lint's nor a type's:
// its subject is a JSX attribute on a native element, so it stays either way.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Production source only — the test tiers legitimately exercise/assert on the
// raw formatter behaviors.
const SCAN_DIRS = ["app", "components", "lib"];

function isExcluded(rel: string): boolean {
  return (
    rel.includes("__tests__") ||
    rel.includes("__db_tests__") ||
    rel.includes("__action_tests__") ||
    rel.endsWith(".test.ts") ||
    rel.endsWith(".test.tsx")
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
      const rel = path.relative(REPO, full).replace(/\\/g, "/");
      if (isExcluded(rel)) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

// ---- Rule (i): implicit-locale toLocale* calls -----------------------------

// EMPTY, and that is the point (issue #1448). The admin-ops trio — Audit,
// Errors, AI logs — plus Active sessions, the delivery-error stamp and the
// Settings → Server status times were the last implicit-locale renders in the
// app: Audit printed SQLite's raw `2026-07-24 22:14:15` while its siblings
// called `toLocaleString()`, which resolves to the SERVER's zone when
// server-rendered and the BROWSER's after hydration (LogsStream carried a
// `suppressHydrationWarning` for exactly that mismatch). They now all render
// `formatTimestamp(..., { zone: "utc" })` — one shape, deterministic, labelled
// UTC in the column header. Keep this empty: a NEW entry means a surface went
// back to ambient-locale formatting.
const TOLOCALE_ALLOWLIST: Record<string, number> = {};

// A `.toLocale…(` CALL (leading dot keeps prose mentions in comments out);
// `.toLocaleString("en-US"` (pinned-locale numeric formatting) is allowed.
const TOLOCALE_RE = /\.toLocale(?:Date|Time)?String\((?!\s*["']en-US["'])/g;

function countMatches(text: string, re: RegExp): number {
  return [...text.matchAll(re)].length;
}

// ---- Rule (iii): raw <input type="date"> ----------------------------------

// A native date control renders its value in the BROWSER's format — "07/24/2026"
// on a US Chrome, "24/07/2026" elsewhere — which is a fifth date shape the app
// neither chooses nor can style, sitting beside pref-aware fields on the same
// form (issue #1448 format #2). components/DateField.tsx is the styled,
// pref-aware replacement (it renders through the same formatter vocabulary and
// submits the ISO value via a hidden input, so a form's payload is unchanged).
//
// Frozen per-file counts, shrink-only like the lists above. The two survivors are
// deliberate, not oversights:
const NATIVE_DATE_ALLOWLIST: Record<string, number> = {
  // Onboarding birthdate: DateField has no `disabled` prop, which this field
  // needs while the step is submitting. Native year-scrolling also genuinely
  // suits a birthdate (a 1-in-100-years reach) better than a month grid.
  "app/(app)/onboarding/AgeInputs.tsx": 1,
  // Training → endurance plan "Event date": converting it puts DateField's
  // portaled calendar over the inline plan bar's submit row. Worth doing, but
  // it needs its own layout pass rather than riding along here.
  "app/(app)/training/EndurancePlanBar.tsx": 1,
};

// The `type="date"` attribute itself, rather than an `<input …>` span: a JSX tag
// is multi-line and its attributes routinely contain `>` (an arrow function in
// `onChange`), so any "from `<input` to the closing bracket" pattern silently
// stops matching the moment the type attribute moves after a handler. Nothing but
// an input carries this attribute, so the attribute alone is the reliable
// signature. DateField renders `type="text"`, so it can never match its own ban.
const NATIVE_DATE_RE = /\btype=["']date["']/g;

// Comments must be stripped first: DateField's own header documents the control
// it replaces ("replacement for <input type=\"date\">"), and prose must not count
// as an offender. Same treatment notes-text.test.ts applies.
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const productionSources = sourceFiles();

describe("date/time display-pref guard (#964/#1020)", () => {
  it("no implicit-locale toLocale* date/time calls outside the frozen admin-ops allowlist", () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const { rel, text } of productionSources) {
      const count = countMatches(text, TOLOCALE_RE);
      if (count === 0) continue;
      seen.add(rel);
      const allowed = TOLOCALE_ALLOWLIST[rel] ?? 0;
      if (count > allowed) {
        problems.push(
          `${rel}: ${count} \`.toLocale*(\` call(s), allowed ${allowed}. ` +
            `Use the pref-aware formatters in lib/format-date (formatDateShape/` +
            `formatClock/formatLongDate/…) — or .toLocaleString("en-US") for ` +
            `numeric thousands separators.`
        );
      } else if (count < allowed) {
        problems.push(
          `${rel}: ${count} \`.toLocale*(\` call(s), allowlist froze ${allowed}. ` +
            `Lower its entry in TOLOCALE_ALLOWLIST to ${count} in this PR (the ` +
            `list only shrinks).`
        );
      }
    }
    for (const rel of Object.keys(TOLOCALE_ALLOWLIST)) {
      if (!seen.has(rel)) {
        problems.push(
          `${rel} is in TOLOCALE_ALLOWLIST but has no matches (or no longer ` +
            `exists) — remove its entry (the list only shrinks).`
        );
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it('no raw <input type="date"> outside the frozen allowlist — date entry goes through <DateField />', () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const { rel, text } of productionSources) {
      if (!text.includes("type") || !text.includes("date")) continue;
      const count = countMatches(stripComments(text), NATIVE_DATE_RE);
      if (count === 0) continue;
      seen.add(rel);
      const allowed = NATIVE_DATE_ALLOWLIST[rel] ?? 0;
      if (count > allowed) {
        problems.push(
          `${rel}: ${count} raw \`<input type="date">\`, allowed ${allowed}. A ` +
            `native date control renders its value in the BROWSER's format, ` +
            `which the app can neither choose nor style. Use ` +
            `components/DateField.tsx (same ISO form payload, pref-aware ` +
            `display, styled calendar).`
        );
      } else if (count < allowed) {
        problems.push(
          `${rel}: ${count} raw \`<input type="date">\`, allowlist froze ` +
            `${allowed}. Lower its entry in NATIVE_DATE_ALLOWLIST to ${count} ` +
            `in this PR (the list only shrinks).`
        );
      }
    }
    for (const rel of Object.keys(NATIVE_DATE_ALLOWLIST)) {
      if (!seen.has(rel)) {
        problems.push(
          `${rel} is in NATIVE_DATE_ALLOWLIST but has no raw date input (or no ` +
            `longer exists) — remove its entry (the list only shrinks).`
        );
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
});
