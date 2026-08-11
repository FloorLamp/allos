import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static hygiene guard for the e2e suite (issue #868, fix a) — the #448 /
// telegram-chokepoint source-scan pattern applied to Playwright specs. It reads
// every e2e/*.ts source (specs AND the shared driver/helper modules, e.g.
// symptom-helpers.ts — issue #868 phase 2 widened the scan past *.spec.ts so a
// settle anti-pattern can't hide in a helper the specs import) as TEXT (no
// browser, no DB, so it stays "pure" in the vitest sense) and freezes TODAY's
// count of two settle anti-patterns per file:
//
//   (i)  waitForLoadState("networkidle") — a readiness gate that settles on a
//        quiet page but NOT one with a long-poll/SSE/streaming request, and waits
//        for the WRONG thing (network silence, not "my interaction landed"). The
//        blessed replacement is e2e/helpers.ts (settledClick / followLink).
//   (ii) waitForTimeout(...) — a fixed sleep that asserts nothing and is either
//        too short (flakes under CI contention) or too long (slows the suite). The ONE
//        sanctioned use — an irreducible bounded absence-of-effect proof (a known
//        product window in which nothing must happen) — carries a same-line
//        `waitfortimeout-ok: <why>` marker and is excluded from the count.
//
// Existing offenders are grandfathered via a per-file allowlist (file → count);
// a NEW occurrence, or a NEW file introducing either, exceeds its allowed
// count (0 when absent) and FAILS. Reducing a count below its frozen value also
// fails — with a message telling you to lower the allowlist — so the allowlist
// only ever shrinks as offenders are migrated (the same immutable-manifest
// discipline as the migration hash manifest). This is a per-file COUNT freeze,
// not line numbers, so it survives ordinary edits.
//
// A THIRD frozen pattern (the fixture-ownership follow-through):
//
//   (iii) .first() — on a SHARED seeded surface (an offer list, a dose list, a
//         review inbox) "the first row" is whatever a neighbor spec or a retry
//         left on top, which the orchestration runbook calls the #1 recurring
//         failure class. A .first() scoped to a spec-OWNED fixture is fine —
//         mark that line with a `first-ok: <why>` comment and it is not
//         counted. Everything else is frozen at today's per-file count; new
//         unmarked occurrences fail. Prefer an exact locator (testid, unique
//         marker text the spec planted) or a dedicated fixture login
//         (e2e/fixture-logins.ts) over "whichever row is first".
//
// A FOURTH frozen pattern (the "commented last resort", now with teeth):
//
//   (iv) .toPass(...) — a retrying block that re-runs arbitrary steps until they
//        stick. It HIDES the same interaction races settledClick/followLink close
//        properly (the retry masks WHICH step raced), slows the suite when the
//        first attempt fails, and — like CI retries writ small — proves "passes
//        within N attempts", not "works". The doc always called it a commented
//        last resort; this freeze enforces that. A reviewed, genuinely-necessary
//        use (e.g. a reload-until-rendered loop over a navigation, where no
//        single awaitable event exists) carries a same-line `topass-ok: <why>`
//        comment and is excluded from the count. Everything else is frozen at
//        today's per-file count; new unmarked occurrences fail.
//
// A FIFTH frozen group (the family-create freeze, issue #868 phase-2):
//
//   (v)  Inline Settings → Family create-login / create-profile / set-grants
//        sequences. Those controls are onClick Server-Action handlers (NOT form
//        submits), so an inline goto→fill→click flakes on the hydration swallow /
//        toaster false-settle (#830/#1111) — nine near-identical copies had grown
//        across the dynamic specs. They now live in the ONE blessed home
//        e2e/family-helpers.ts (createLoginViaFamily / createProfileViaFamily /
//        setGrantsViaFamily); the three inline markers (`getByPlaceholder("Username")`,
//        `"Add a profile"`, `"Save access"`) are frozen at ZERO in every OTHER file,
//        so a NEW inline sequence fails. The helper module is SKIPPED (not
//        allowlisted) for these three — it OWNS the markers by design.
//
// A SIXTH check (the fixture-LOGIN budget, issue #1392) — not a count-freeze but a
// per-fixture rule:
//
//   (vi) Every `E2E_LOGIN_*` constant seeded by the fixture-login modules (the
//        e2e/logins/* set that e2e/fixture-logins.ts composes, #1511) must be
//        referenced by a spec AND used in a sign-in position, else carry a written
//        justification. The seeded login population is MONOTONIC — each one is a
//        permanent Settings → Family row — and that ratchet is what grew the family
//        page into the #830/#1111/#1392 census family. See LOGIN_NO_SIGNIN_ALLOW.
//
// NOT mechanically enforced here (documented rule only — see
// docs/internals/e2e-hygiene.md): exact-count assertions against SHARED-SEED
// fixture rows ("2 today", "≥ 2 episode rows"). Detecting those syntactically
// (a numeric literal inside a toContainText/toHaveCount against a seeded testid)
// is too clever — it can't tell a shared-seed count from a spec's own
// self-created fixture, so it would fire on legitimate dedicated-fixture asserts
// and miss obfuscated ones. The honest scope is the four mechanically-detectable
// anti-patterns above; the fixture-ownership rule lives in the doc and is a
// review/convention gate, not a linter.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const E2E_DIR = path.join(REPO, "e2e");

// The blessed interaction module (e2e/helpers.ts) OWNS networkidle/timeout usage
// (followLink's internal settle, plus prose mentions of both patterns in its
// decision-tree header), so it is never scanned — every OTHER e2e/*.ts is.
const SCAN_EXCLUDE = new Set(["helpers.ts"]);
// Match `waitForLoadState("networkidle"` regardless of a trailing options arg —
// symptom-helpers.ts's `idleSettle` passes `{ timeout }`, so an `…\)`-anchored
// regex silently MISSED it (the second half of the phase-2 "known gap": the guard
// couldn't see helper files AND couldn't see the options-arg form).
const NETWORKIDLE_RE = /waitForLoadState\(\s*["']networkidle["']/g;
const WAITFORTIMEOUT_RE = /\.waitForTimeout\(/g;
// A `.waitForTimeout(` on a line carrying a `waitfortimeout-ok: <why>` comment is a
// reviewed IRREDUCIBLE bounded absence-of-effect proof (same same-line escape-marker
// shape as first-ok/topass-ok). It probes a KNOWN product time window and asserts
// NOTHING happened within it — a NON-occurrence has no positive event to await, so a
// bounded sleep is the only truthful gate. Everything else is banned.
const WAITFORTIMEOUT_OK_MARKER = "waitfortimeout-ok";
const FIRST_RE = /\.first\(\)/g;
// A `.first()` on a line carrying a `first-ok: <why>` comment is a reviewed,
// spec-owned-fixture use and is excluded from the count (the same same-line
// escape-marker shape as phi-scan's `phi-scan-ok`).
const FIRST_OK_MARKER = "first-ok";
const TOPASS_RE = /\.toPass\(/g;
// A `.toPass(` on a line carrying a `topass-ok: <why>` comment is a reviewed
// last-resort use (same escape-marker shape as first-ok). Note the marker line
// is wherever `.toPass(` itself appears — usually the closing `}).toPass({...})`.
const TOPASS_OK_MARKER = "topass-ok";

// The family-create freeze (issue #868, phase-2 create-member hardening). The
// Settings → Family create/grant controls are onClick Server-Action handlers, NOT
// form submits, so an inline goto→fill→click sequence flakes on the hydration swallow /
// toaster false-settle (#830/#1111). Nine near-identical copies of that dance had
// accreted across the dynamic specs; they now live in the ONE blessed home
// e2e/family-helpers.ts (createLoginViaFamily / createProfileViaFamily /
// setGrantsViaFamily). These freeze the three inline markers at ZERO everywhere ELSE,
// so a NEW inline create/grant sequence fails CI and must route through the helper.
const FAMILY_HELPERS = "family-helpers.ts";
// The create-login form's username field (`placeholder="Username"`) — unique to that
// form (the login page uses `input[name="username"]`, not a placeholder).
const CREATE_LOGIN_RE = /getByPlaceholder\(\s*["']Username["']\s*\)/g;
// The grants matrix's save button label.
const SET_GRANTS_RE = /["']Save access["']/g;
// The profiles card's section label, used as the `hasText` scope for the create field.
const ADD_PROFILE_RE = /["']Add a profile["']/g;
// All inline family-create sequences were migrated onto e2e/family-helpers.ts, so every
// OTHER spec freezes at zero. A new inline sequence (or a new offender file) fails; the
// blessed home is skipped, not allowlisted, since it OWNS these markers by design.
const CREATE_LOGIN_ALLOW: Record<string, number> = {};
const SET_GRANTS_ALLOW: Record<string, number> = {};
const ADD_PROFILE_ALLOW: Record<string, number> = {};

// ── (vii) The fixture-PROFILE constructor freeze (issue #1487) ───────────────
// A fixture profile created with a bare `INSERT INTO profiles` starts with NO
// `saved_items` rows — which was invisible while Trends Overview rendered the four
// standard metric tiles unconditionally, and became a broken, unreachable-in-
// production state the moment Overview went membership-driven (#1487): a raw-SQL
// fixture profile renders an EMPTY grid, while every profile a real user can create
// (createProfile / bootstrapAuth) is seeded with the standard metric saves. ~107
// fixture profiles were in that state.
//
// So profile creation in e2e goes through the ONE blessed constructor
// e2e/fixture-profile.ts (createFixtureProfile / createFixtureProfileWithId), which
// calls the SAME lib/standard-metric-seeds.ts core the production paths call. The raw
// insert is frozen at ZERO everywhere else, so a new fixture can't reintroduce the
// divergence; the constructor module OWNS the marker and is skipped, not allowlisted.
//
// The DELETE side is frozen the same way, and it is not hypothetical: the moment the
// constructor started seeding, two specs' hand-rolled cleanups (`DELETE FROM profiles`
// after clearing their own rows) began failing on `saved_items.profile_id`'s foreign
// key. Creation gained side-state and the destructors did not — the #1487 "row
// operations carry their side-state" rule, applied to fixtures. So the pair lives in
// one module: `destroyFixtureProfile` removes what the constructor wrote, and a raw
// profile DELETE is banned everywhere else, which is what makes the NEXT addition to
// the production seed core a one-file edit instead of a suite-wide FK hunt.
// ── (viii) The DB-per-worker harness freeze (issue #1538) ───────────────────
// Each Playwright worker now runs against its OWN database and its OWN app server.
// Two things make that work, and both are one-line-easy to get wrong:
//
//   • a spec gets its worker's server + session by importing `test` from
//     e2e/fixtures.ts. A spec that imports `test` from "@playwright/test" instead
//     silently opts OUT — no per-worker baseURL, no per-worker storage state — and
//     drives whatever happens to answer on the base port. Frozen at ZERO
//     everywhere but the fixture module itself (TYPE-only imports from
//     "@playwright/test" — Page, Locator, Browser — stay fine and are not matched).
//
//   • a spec that opens SQLite directly resolves the file with workerDbPath()
//     (e2e/worker-env.ts). `process.env.ALLOS_DB_PATH` is the APP SERVER's
//     environment, not the spec process's — reading it from a spec is how a
//     direct-DB spec would read the wrong worker's database (or none at all).
//     Frozen at ZERO outside the harness modules that legitimately set it.
// ── (ix) The wall-clock freeze (the #1538 drift follow-up) ──────────────────
// The app's clock is FROZEN for the whole run (ALLOS_TEST_NOW, #990): the seeded
// template, every worker's app server and — since the per-worker harness patched
// `browser.newContext` — every browser context answer the same `now()`. A spec
// process does NOT: `new Date()` / `Date.now()` there is the REAL clock, and the
// gap between real and frozen is however long the run has been going. That used to
// be a few minutes; a `--repeat-each=3` lane over a large spec set now runs ~90,
// which is long enough for a row a spec timestamps from the wall clock to land in
// the app's FUTURE and drop out of every recency window (the #1441 finished-session
// recap failed exactly this way, deterministically, 29 minutes in).
//
// So a spec's "now" is `frozenNow()` (e2e/worker-env.ts), never the wall clock.
// Every surviving real-clock read is a unique-name suffix or a TOTP probe that
// genuinely needs real time, never a stored timestamp, and carries a same-line
// `clock-ok: <why>` marker. The allowlist is empty: a NEW unmarked read fails.
const WALL_CLOCK_RE = /\bDate\.now\(\)|\bnew Date\(\)/g;
const WALL_CLOCK_OK_MARKER = "clock-ok";
const WALL_CLOCK_ALLOW: Record<string, number> = {};

// ── (x) The document-level overflow check freeze (issue #1543) ──────────────
// The app shell clips horizontal overflow (`<main className="… overflow-x-clip">`,
// app/(app)/layout.tsx), so the document NEVER reports itself wider than the
// viewport on an (app) page: a 3000px-wide div injected into <main> still reads a
// document scroll width of 360 at a 360px viewport. Every hand-rolled
// "document width ≤ viewport width" guard is therefore UNCONDITIONALLY TRUE — 15
// sites across 13 specs asserted exactly nothing, including one written in the
// inverted direction (unconditionally false), which is the same vacuity.
//
// The blessed guard is `expectNoClippedContent(page)` (e2e/helpers.ts, #1063): it
// asserts ELEMENT-level containment (every rendered element's right edge inside the
// viewport +2px, unless it sits in a working `overflow-x: auto|scroll` container
// that itself fits), reports the offending tag/testid/class + widths, and folds the
// document-level check in as belt-and-braces for surfaces OUTSIDE the clipping shell
// (share pages, print views) — so the honest home for that comparison is the helper,
// which the scan excludes.
//
// Frozen at ZERO: every site was converted in #1543. The scan is TEXTUAL, so a
// comment or string in an e2e file that spells the pattern out counts itself —
// phrase the prose without the literal (this file is not scanned, so it may).
// An alias (`const de = document.documentElement; de.scrollWidth`) evades the regex;
// that is a deliberate limit, not a supported escape.
const DOC_SCROLLWIDTH_RE = /(?:documentElement|document\.body)\.scrollWidth/g;
const DOC_SCROLLWIDTH_ALLOW: Record<string, number> = {};

const WORKER_HARNESS_FILES = new Set([
  "fixtures.ts",
  "worker-env.ts",
  "global-setup.ts",
  "global-teardown.ts",
]);
const PW_TEST_IMPORT_RE =
  /import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*["']@playwright\/test["']/g;
const PW_TEST_IMPORT_ALLOW: Record<string, number> = {};
const RAW_DB_ENV_RE = /process\.env\.ALLOS_DB_PATH/g;
const RAW_DB_ENV_ALLOW: Record<string, number> = {};

const FIXTURE_PROFILE_FILE = "fixture-profile.ts";
const RAW_PROFILE_INSERT_RE = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+profiles\b/g;
const RAW_PROFILE_INSERT_ALLOW: Record<string, number> = {};
const RAW_PROFILE_DELETE_RE = /DELETE\s+FROM\s+profiles\b/g;
const RAW_PROFILE_DELETE_ALLOW: Record<string, number> = {};

// Frozen offenders as of #868 (per-file counts). Migrate an entry to
// e2e/helpers.ts and LOWER its number here in the same PR; a fully-migrated file
// drops out entirely. New files must not appear.
//
// EMPTY as of the #868 tail migration: the last entry (symptom-helpers.ts's
// `idleSettle`, the old surface-parameterized networkidle settle) was replaced by
// the `Tap` parameter — `settledTap(page)` wraps settledClick, arming the
// action-POST wait BEFORE the tap inside each driver's toPass loop, so the
// dashboard's dependent steps wait on the RIGHT signal and the episode page's
// default `plainTap` stays optimistic. The suite now has ZERO networkidle waits;
// any new one fails here.
const NETWORKIDLE_ALLOW: Record<string, number> = {};

// EMPTY — the only sanctioned waitForTimeout is the IRREDUCIBLE bounded absence-of-effect
// proof, now carried by a same-line `waitfortimeout-ok: <why>` marker at each site (the
// training-log-provenance 700ms-autosave-must-not-fire probes and the profile-switch-toasts
// 6s-idle-poll ghost-toast probes), so it's excluded from the count and the allowlist is
// empty — uniform with FIRST_ALLOW/TOPASS_ALLOW. A NEW unmarked waitForTimeout fails CI.
const WAITFORTIMEOUT_ALLOW: Record<string, number> = {};

// Frozen .first() offenders (per-file counts, `first-ok`-marked lines excluded)
// as of the flaky-e2e hardening pass. Same immutable-downward discipline as the
// two lists above: migrate a spec onto an exact locator / dedicated fixture and
// LOWER its number in the same PR; a NEW unmarked .first() (or a new file) fails.
// EMPTY — the grandfathered .first() burn-down (#868) is complete: every spec that
// carried an unmarked .first() on a shared surface was migrated onto a spec-owned
// fixture (a dedicated fixture login, a beforeEach re-seed, or an exact locator) or
// marked `first-ok` at its owned-fixture use. The last three cleared were
// medications-page (dose-history invariant marked), edit-lock-badge (beforeEach
// restores its consumed lock → exact locators), and illness-care (dedicated sick
// profile). The freeze stays at ZERO: a NEW unmarked .first() on any e2e/*.ts fails.
const FIRST_ALLOW: Record<string, number> = {};

// EMPTY — the .toPass( burn-down is complete, mirroring FIRST_ALLOW. Every retry loop
// that survives is a reviewed, genuinely-necessary last resort carrying a same-line
// `topass-ok: <why>` marker (a pre-hydration re-click/re-press with no POST to settle
// on, a reload-until-persisted confirm, a re-mint-TOTP loop, a recharts hover, or a
// re-read-until-a-number-increases) — those are excluded from the count, so the
// allowlist itself is empty. illness-episode's two inline popover re-opens were the
// last conversion: they were verbatim copies of switchToProfile and now route through
// that ONE blessed helper (family-helpers.ts). The freeze stays at ZERO: a NEW unmarked
// .toPass( on any e2e/*.ts fails.
const TOPASS_ALLOW: Record<string, number> = {};

// ── (vi) The fixture-LOGIN budget (issue #1392) ──────────────────────────────
// Every seeded fixture login is a PERMANENT row on Settings → Family and a
// permanent member of the grant matrix. That population is monotonic — it only
// ever grows — and at ~90 logins it grew the family page into the #830/#1111/#1392
// census family (a 5 MB matrix render that starved the durable-row probes until the
// #1412 collapse capped the page at O(logins)). The product fix removed the cliff;
// this guard removes the RATCHET, per the issue's remaining "fixture-budget" lane.
//
// The rule: a fixture LOGIN is seeded only when a spec SIGNS IN as it (a separate
// cookie context is the only way to drive a non-profile-1 active profile without
// mutating the shared admin storageState's server-side active profile — see the
// e2e/fixture-logins.ts header) or when the login itself is the SUBJECT (access
// control / the family screen). A fixture that only needs an isolated PROFILE takes
// `fixtureProfileId(name)` alone and no login — a profile is free here, a login is not.
//
// Mechanically: every `E2E_LOGIN_*` constant in e2e/fixture-logins.ts must appear in
// at least one e2e/*.spec.ts (a login no spec references at all is dead weight) AND
// be used in a sign-in position (`loginAs(...)` / `creds(...)` / `username:`), unless
// it carries a written justification below. The check is textual, so a new sign-in
// wrapper may need an allowlist line — that's the point: adding a login stays a
// deliberate, justified act rather than a reflex.
const LOGIN_CONST_RE = /export const (E2E_LOGIN_[A-Z0-9_]+) = "([^"]+)"/g;
// The budget is measured over the COMPOSED population, not one file: #1511 split the
// constants into per-domain modules under e2e/logins/ that e2e/fixture-logins.ts
// re-exports. Every one of them declares logins, so all of them are the source of
// truth (and none of them counts as a "spec that references" a login).
const FIXTURE_LOGINS_FILE = "fixture-logins.ts";
const FIXTURE_LOGINS_DIR = "logins/";
const isFixtureLoginsModule = (name: string) =>
  name === FIXTURE_LOGINS_FILE || name.startsWith(FIXTURE_LOGINS_DIR);
// A constant used within this many characters after a sign-in opener counts as
// "signed in as" (covers the multi-line `loginAs(browser, { username: X, … })` form).
const SIGNIN_WINDOW_RE = /(?:loginAs\(|creds\(|username:)[\s\S]{0,200}/g;
// Fixture logins that are deliberately never signed in as, with WHY. Keep this list
// short — each entry is a login the family page carries forever.
const LOGIN_NO_SIGNIN_ALLOW: Record<string, string> = {
  E2E_LOGIN_SLEEP_EDIT:
    "template login: sleep-page clones its scrypt hash into per-test logins it creates and drives itself",
  E2E_LOGIN_GRANTEDIT:
    "access-control subject: family-grants drives its grant row / own-profile select AS THE ADMIN (#1412)",
};

// RECURSIVE since #1511 split the two append-magnet modules into per-domain files
// (e2e/seed/*.ts, e2e/logins/*.ts): a guard that stopped at the top level would
// silently stop scanning the moved content. `name` is the path RELATIVE to e2e/
// (posix), so a top-level file keeps its bare basename — every allowlist / skip-set
// key above is unchanged — and a nested one reads as "seed/medical.ts".
function specFiles(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // Skip the runtime dot-dirs (.data / .auth / test-results) — generated, not source.
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        const name = path.relative(E2E_DIR, full).split(path.sep).join("/");
        if (!SCAN_EXCLUDE.has(name)) {
          out.push({ name, text: fs.readFileSync(full, "utf8") });
        }
      }
    }
  };
  walk(E2E_DIR);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

function checkPattern(
  label: string,
  re: RegExp,
  allow: Record<string, number>,
  opts?: {
    hint?: string;
    // Lines matching this marker are excluded before counting (the first-ok escape).
    excludeLineMarker?: string;
    // Files skipped entirely — the blessed HOME for a pattern (e.g. family-helpers.ts
    // legitimately contains the family-create sequences it exists to centralize).
    skipFiles?: Set<string>;
  }
) {
  const files = specFiles().filter((f) => !opts?.skipFiles?.has(f.name));
  const seen = new Set<string>();
  const violations: string[] = [];
  const hint =
    opts?.hint ??
    `New occurrences are banned — use e2e/helpers.ts (settledClick/followLink); ` +
      `see docs/internals/e2e-hygiene.md.`;

  for (const { name, text } of files) {
    const marker = opts?.excludeLineMarker;
    const scanText = marker
      ? text
          .split("\n")
          .filter((line) => !line.includes(marker))
          .join("\n")
      : text;
    const count = countMatches(scanText, re);
    const allowed = allow[name] ?? 0;
    seen.add(name);
    if (count > allowed) {
      violations.push(
        `${name}: ${count} ${label} (allowed ${allowed}). ${hint}`
      );
    } else if (count < allowed) {
      violations.push(
        `${name}: ${count} ${label} but allowlist freezes ${allowed}. ` +
          `You reduced offenders — LOWER (or remove) its entry in ` +
          `lib/__tests__/e2e-hygiene.test.ts so the allowlist keeps shrinking.`
      );
    }
  }

  // A stale allowlist entry for a file that no longer exists must be removed.
  for (const name of Object.keys(allow)) {
    if (!seen.has(name)) {
      violations.push(
        `${name}: allowlisted for ${label} but the spec file no longer exists — ` +
          `remove its entry in lib/__tests__/e2e-hygiene.test.ts.`
      );
    }
  }

  expect(violations, violations.join("\n")).toEqual([]);
}

describe("e2e suite hygiene guard (issue #868)", () => {
  it('no NEW waitForLoadState("networkidle") in an e2e/*.ts (use e2e/helpers.ts)', () => {
    checkPattern(
      'waitForLoadState("networkidle")',
      NETWORKIDLE_RE,
      NETWORKIDLE_ALLOW
    );
  });

  it("no NEW unmarked waitForTimeout(...) in an e2e/*.ts (use e2e/helpers.ts or mark waitfortimeout-ok)", () => {
    checkPattern(
      "waitForTimeout(...)",
      WAITFORTIMEOUT_RE,
      WAITFORTIMEOUT_ALLOW,
      {
        excludeLineMarker: WAITFORTIMEOUT_OK_MARKER,
        hint:
          `New waitForTimeout(...) is banned — await the actual signal instead ` +
          `(settledClick / followLink / a plain retrying expect on one locator), or ` +
          `add a same-line \`waitfortimeout-ok: <why>\` comment ONLY for an irreducible ` +
          `bounded absence-of-effect proof (a known product window in which nothing must ` +
          `happen); see docs/internals/e2e-hygiene.md.`,
      }
    );
  });

  it("no NEW unmarked .first() in an e2e/*.ts (scope to an owned fixture, or mark first-ok)", () => {
    checkPattern(".first()", FIRST_RE, FIRST_ALLOW, {
      excludeLineMarker: FIRST_OK_MARKER,
      hint:
        `New .first() on a shared surface is banned — target a spec-owned fixture ` +
        `via an exact locator (testid / marker text you planted / e2e/fixture-logins.ts), ` +
        `or add a same-line \`first-ok: <why>\` comment for a reviewed, ` +
        `owned-fixture use; see docs/internals/e2e-hygiene.md.`,
    });
  });

  it("no NEW unmarked .toPass( in an e2e/*.ts (use a settled interaction, or mark topass-ok)", () => {
    checkPattern(".toPass(", TOPASS_RE, TOPASS_ALLOW, {
      excludeLineMarker: TOPASS_OK_MARKER,
      hint:
        `New .toPass( retry blocks are banned — await the actual signal instead ` +
        `(settledClick / followLink / a plain retrying expect on one locator), or ` +
        `add a same-line \`topass-ok: <why>\` comment for a reviewed last-resort ` +
        `use; see docs/internals/e2e-hygiene.md.`,
    });
  });

  it("no NEW inline create-login sequence in an e2e/*.ts (use createLoginViaFamily)", () => {
    checkPattern(
      "create-login (getByPlaceholder Username)",
      CREATE_LOGIN_RE,
      CREATE_LOGIN_ALLOW,
      {
        skipFiles: new Set([FAMILY_HELPERS]),
        hint:
          `Inline Settings → Family create-login sequences are banned — they flake on ` +
          `the onClick+refresh hydration swallow / toaster false-settle (#830/#1111). ` +
          `Use createLoginViaFamily from e2e/family-helpers.ts; see docs/internals/e2e-hygiene.md.`,
      }
    );
  });

  it("no NEW inline create-profile sequence in an e2e/*.ts (use createProfileViaFamily)", () => {
    checkPattern(
      "create-profile (Add a profile)",
      ADD_PROFILE_RE,
      ADD_PROFILE_ALLOW,
      {
        skipFiles: new Set([FAMILY_HELPERS]),
        hint:
          `Inline Settings → Family create-profile sequences are banned — they flake on ` +
          `the onClick+refresh hydration swallow (#830/#1111). Use createProfileViaFamily ` +
          `from e2e/family-helpers.ts; see docs/internals/e2e-hygiene.md.`,
      }
    );
  });

  it("no NEW inline set-grants sequence in an e2e/*.ts (use setGrantsViaFamily)", () => {
    checkPattern("set-grants (Save access)", SET_GRANTS_RE, SET_GRANTS_ALLOW, {
      skipFiles: new Set([FAMILY_HELPERS]),
      hint:
        `Inline Settings → Family grant sequences are banned — they flake on the ` +
        `onClick+refresh hydration swallow / toaster false-settle (#830/#1111). Use ` +
        `setGrantsViaFamily from e2e/family-helpers.ts; see docs/internals/e2e-hygiene.md.`,
    });
  });

  it("every seeded fixture login is signed in as by a spec (the #1392 fixture-login budget)", () => {
    const src = specFiles()
      .filter((f) => isFixtureLoginsModule(f.name))
      .map((f) => f.text)
      .join("\n");
    const constants = [...src.matchAll(LOGIN_CONST_RE)].map((m) => m[1]);
    // The constants file is the population's source of truth; an empty read means
    // the regex (or the file) moved, which must fail loudly rather than pass vacuously.
    expect(constants.length).toBeGreaterThan(0);

    const files = specFiles().filter((f) => !isFixtureLoginsModule(f.name));
    const violations: string[] = [];

    for (const name of constants) {
      const use = new RegExp(`\\b${name}\\b`);
      const referencedBy = files.filter((f) => use.test(f.text));
      const signsIn = files.some((f) =>
        (f.text.match(SIGNIN_WINDOW_RE) ?? []).some((w) => use.test(w))
      );
      const why = LOGIN_NO_SIGNIN_ALLOW[name];
      if (signsIn) {
        if (why)
          violations.push(
            `${name}: allowlisted as never-signed-in, but a spec now signs in as it — ` +
              `remove its LOGIN_NO_SIGNIN_ALLOW entry in lib/__tests__/e2e-hygiene.test.ts.`
          );
        continue;
      }
      if (why) continue;
      violations.push(
        referencedBy.length === 0
          ? `${name}: seeded in e2e/logins/ but NO e2e spec references it — ` +
              `delete the login (and its seedMemberLogin call); a dead login is a permanent ` +
              `Settings → Family row (#1392).`
          : `${name}: referenced by ${referencedBy
              .map((f) => f.name)
              .join(", ")} but never signed in as (loginAs/creds/username:). ` +
              `A fixture that only needs an isolated PROFILE takes fixtureProfileId(name) ` +
              `and NO login — the login population is monotonic and grows the family ` +
              `grant matrix forever (#1392). If this login IS the subject (access control) ` +
              `or a sign-in wrapper hides the use, add it to LOGIN_NO_SIGNIN_ALLOW in ` +
              `lib/__tests__/e2e-hygiene.test.ts with a reason; see docs/internals/e2e-hygiene.md.`
      );
    }

    for (const name of Object.keys(LOGIN_NO_SIGNIN_ALLOW)) {
      if (!constants.includes(name))
        violations.push(
          `${name}: allowlisted in LOGIN_NO_SIGNIN_ALLOW but no longer exists in ` +
            `e2e/logins/ — remove its entry.`
        );
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("no NEW raw INSERT INTO profiles in an e2e/*.ts (use createFixtureProfile)", () => {
    checkPattern(
      "raw fixture-profile insert",
      RAW_PROFILE_INSERT_RE,
      RAW_PROFILE_INSERT_ALLOW,
      {
        skipFiles: new Set([FIXTURE_PROFILE_FILE]),
        hint:
          `A raw INSERT INTO profiles skips the standard Overview metric seeds every ` +
          `production-created profile gets (#1487), so the fixture renders an empty ` +
          `Trends Overview no real profile can be in. Use createFixtureProfile from ` +
          `e2e/fixture-profile.ts; see docs/internals/e2e-hygiene.md.`,
      }
    );
  });

  it("no NEW raw DELETE FROM profiles in an e2e/*.ts (use destroyFixtureProfile)", () => {
    checkPattern(
      "raw fixture-profile delete",
      RAW_PROFILE_DELETE_RE,
      RAW_PROFILE_DELETE_ALLOW,
      {
        skipFiles: new Set([FIXTURE_PROFILE_FILE]),
        hint:
          `A raw DELETE FROM profiles leaves the rows the fixture CONSTRUCTOR seeded ` +
          `(#1487 standard metric saves) and fails on their foreign key. Use ` +
          `destroyFixtureProfile from e2e/fixture-profile.ts — the constructor's pair; ` +
          `see docs/internals/e2e-hygiene.md.`,
      }
    );
  });

  it("the blessed fixture-profile constructor exists and seeds the standard metric saves", () => {
    const mod = fs.readFileSync(
      path.join(E2E_DIR, FIXTURE_PROFILE_FILE),
      "utf8"
    );
    expect(mod).toMatch(/export function createFixtureProfile\b/);
    expect(mod).toMatch(/export function createFixtureProfileWithId\b/);
    // The destructor is not optional: creation writes side-state, so a fixture that
    // deletes its profile needs the pair (see the DELETE freeze above).
    expect(mod).toMatch(/export function destroyFixtureProfile\b/);
    // It must delegate to the production seeding core, not re-implement it.
    expect(mod).toMatch(/seedStandardMetricSaves\(/);
  });

  it("no e2e/*.ts imports `test` from @playwright/test (import it from ./fixtures)", () => {
    checkPattern(
      "@playwright/test `test` import",
      PW_TEST_IMPORT_RE,
      PW_TEST_IMPORT_ALLOW,
      {
        skipFiles: WORKER_HARNESS_FILES,
        hint:
          `A spec that imports \`test\` from "@playwright/test" opts out of the ` +
          `DB-per-worker harness (#1538): no per-worker baseURL, no per-worker session. ` +
          `Import { test, expect } from "./fixtures" — TYPE imports (Page, Locator, ` +
          `Browser) may stay on "@playwright/test"; see docs/internals/e2e-hygiene.md.`,
      }
    );
  });

  it("no e2e/*.ts reads process.env.ALLOS_DB_PATH (use workerDbPath())", () => {
    checkPattern(
      "process.env.ALLOS_DB_PATH read",
      RAW_DB_ENV_RE,
      RAW_DB_ENV_ALLOW,
      {
        skipFiles: WORKER_HARNESS_FILES,
        hint:
          `ALLOS_DB_PATH is the APP SERVER's environment, not the spec process's — a ` +
          `spec reading it opens the wrong worker's database (#1538). Use ` +
          `workerDbPath() from ./worker-env; see docs/internals/e2e-hygiene.md.`,
      }
    );
  });

  it("no document-level overflow check in an e2e/*.ts (use expectNoClippedContent)", () => {
    checkPattern(
      "document-level overflow check",
      DOC_SCROLLWIDTH_RE,
      DOC_SCROLLWIDTH_ALLOW,
      {
        hint:
          `The app shell clips horizontal overflow, so a document-width vs ` +
          `viewport-width comparison is unconditionally true on every (app) page — ` +
          `it asserts NOTHING (#1543). Use expectNoClippedContent(page) from ` +
          `e2e/helpers.ts, which measures element-level containment (right edge ` +
          `inside the viewport unless inside a working overflow-x scroller that ` +
          `itself fits) and names the offending element; see ` +
          `docs/internals/e2e-hygiene.md.`,
      }
    );
  });

  it("no NEW wall-clock read in an e2e/*.ts (derive timestamps from frozenNow())", () => {
    checkPattern("wall-clock read", WALL_CLOCK_RE, WALL_CLOCK_ALLOW, {
      skipFiles: WORKER_HARNESS_FILES,
      excludeLineMarker: WALL_CLOCK_OK_MARKER,
      hint:
        `A spec's "now" is the harness's frozen now, never the wall clock: the app ` +
        `serves a frozen \`now()\` and a long lane drifts ~90 minutes from real time, ` +
        `so a wall-clock timestamp lands in the app's future (#1538). Use ` +
        `frozenNow() from ./worker-env, or add a same-line \`clock-ok: <why>\` ` +
        `comment for a use that is NOT a stored timestamp (a unique-name suffix, a ` +
        `TOTP probe); see docs/internals/e2e-hygiene.md.`,
    });
  });

  it("the per-worker harness exposes its addressing helpers", () => {
    const env = fs.readFileSync(path.join(E2E_DIR, "worker-env.ts"), "utf8");
    expect(env).toMatch(/export function workerDbPath\b/);
    expect(env).toMatch(/export function workerDir\b/);
    expect(env).toMatch(/export function workerPort\b/);
    const fixtures = fs.readFileSync(path.join(E2E_DIR, "fixtures.ts"), "utf8");
    // The two option overrides are what point page/context at THIS worker.
    expect(fixtures).toMatch(/baseURL:\s*async/);
    expect(fixtures).toMatch(/storageState:\s*async/);
  });

  it("the blessed interaction module exists and exports settledClick + followLink", () => {
    const helpers = fs.readFileSync(path.join(E2E_DIR, "helpers.ts"), "utf8");
    expect(helpers).toMatch(/export async function settledClick\b/);
    expect(helpers).toMatch(/export async function followLink\b/);
  });

  it("the family helper module exists and exports the three create/grant drivers", () => {
    const fam = fs.readFileSync(path.join(E2E_DIR, FAMILY_HELPERS), "utf8");
    expect(fam).toMatch(/export async function createLoginViaFamily\b/);
    expect(fam).toMatch(/export async function createProfileViaFamily\b/);
    expect(fam).toMatch(/export async function setGrantsViaFamily\b/);
  });
});
