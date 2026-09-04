import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./strip-comments";

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

// A committed skip is missing coverage disguised as a test. Runtime skips are worse:
// the same revision tests different behavior by wall-clock or environment state, so a
// green run cannot say which contract actually ran. Keep the committed count at zero;
// a scenario that is no longer valuable is deleted, and a real boundary is made
// deterministic in its fixture.
const TEST_SKIP_RE = /\btest\.skip\s*\(/g;
const TEST_SKIP_ALLOW: Record<string, number> = {};

// A branch on `process.env.CI` (#2648). The runner is not a property of the app, and
// three of the four sites this rule was written from were the SAME category error:
// `process.env.CI` standing in for "is this a production build". It never was one —
// e2e/fixtures.ts spawns every worker's `next start` with NODE_ENV=production
// unconditionally, so since #1538 the non-CI arm has been unreachable and the CI arm
// has been the only thing running. "Both runs stay green" had quietly become "CI
// stays green", which is an assertion that asserts less than it appears to and gets
// found out only when the behaviour changes.
//
// So the rule is: a line that branches on the runner must SAY which runner-only fact
// it needs, via a `ci-ok: <why>` comment (the first-ok escape-marker shape). Unlike
// the other markers this one is accepted on the branch line OR on either line
// touching it — `if (process.env.CI) {` is too short to carry a reason worth
// reading, and a marker crammed onto it is how a reason turns into a rubber stamp.
// There is no per-file allowlist: the honest answer is a written reason or a deleted
// branch. Prose that merely NAMES the variable (a comment explaining why a branch was
// removed, like the ones in the specs this rule came from) is not a branch.
const CI_ENV_RE = /process\.env\.CI\b/;
const CI_OK_MARKER = "ci-ok";

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

// A bare calendar year in a text assertion is a date fuse with no date attached:
// against a relative fixture it eventually turns red, while the negated form can
// turn vacuously green. Assert the fixture-derived display date, or use a year-shape
// regex when the contract is that no date is rendered (#4369).
const BARE_YEAR_ASSERTION_RE =
  /(?:not\.)?toContainText\(\s*(?:["'`]20\d{2}["'`]|\/[^/\n]*\b20\d{2}\b[^/\n]*\/[a-z]*)/g;
const BARE_YEAR_ASSERTION_ALLOW: Record<string, number> = {};

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

// ── (xi) Navigating while "offline" (issue #3002) ───────────────────────────
// Playwright's offline emulation is per-browser-CONTEXT and does not cover requests
// the SERVICE WORKER initiates. `context.setOffline(true)` cuts the page's own
// fetches; `cacheFirst` in public/sw.js still reaches the server from inside the
// worker. So an "it renders offline" assertion can pass on assets pulled over the
// network DURING the offline navigation — measured on the /offline shell: chunks
// absent from the cache before `setOffline(true)` were present after it. A real
// device has no such escape hatch, and there a missing chunk is a blank page.
//
// The rule is scoped to the case that can lie. Going offline on an ALREADY-LOADED
// page — the offline write queue's tap → queued → reconnect → replayed flows — is
// honest as written: nothing navigates, so no shell has to come from anywhere, and
// the page's own POST is exactly what the emulation does block. Only a `goto` /
// `reload` inside the offline window needs the shell, so only that shape is caught.
//
// The fix is never to delete the block: the coverage is wanted, the CLAIM is what
// was wrong. `readyForOffline(page)` (e2e/helpers.ts) states the precondition the
// harness cannot fake — a live controlling worker, and every chunk the /offline
// document declares already in the worker's cache BEFORE the network goes away.
// Call it before `setOffline(true)` and the block measures the app again.
//
// An offline navigation that asserts something the bypass genuinely cannot fake and
// needs no shell of its own carries an `offline-nav-ok: <why>` marker anywhere in
// its offline window (the `first-ok` escape shape).
const SET_OFFLINE_TRUE_RE = /setOffline\(\s*true\s*\)/;
const SET_OFFLINE_FALSE_RE = /setOffline\(\s*false\s*\)/;
const OFFLINE_NAVIGATION_RE = /\.(?:goto|reload)\(/;
const OFFLINE_READY_RE = /readyForOffline\(/;
const OFFLINE_NAV_OK_MARKER = "offline-nav-ok";
// The helper module that OWNS the precondition — it spells the markers out by design.
const OFFLINE_HELPERS_FILE = "helpers.ts";

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

// A SHARED-PROFILE activity cleanup, spelled inline (#3946). The freeze is ZERO and
// there is no allowlist: `deleteActivitiesTitled` in e2e/shared-profile-guard.ts is
// the one definition, and it existed verbatim in three specs before this.
//
// THE PATTERN COMES FROM HOW THE SPECS ACTUALLY SPELL IT, not from how #3946
// described it. A census of `DELETE FROM activities` across e2e/ found FIVE
// spellings — `WHERE title = ?`, `WHERE profile_id = 1 AND title = '…'`,
// `WHERE profile_id = 1 AND title IN (?, ?)`, `WHERE profile_id = ? AND title = ?`,
// and `WHERE title LIKE ?` — so a rule written for the first alone would have shipped
// green and blind to the other four.
//
// IT DELIBERATELY STOPS SHORT OF `profile_id = ?`, AND THAT IS AN HONEST LIMIT, not
// an oversight. A regex cannot resolve a constant, so `profile_id = ?` may be the
// shared profile (annual-retrospective's SEED_PROFILE is 1) or a spec-owned fixture
// profile (multi-view deletes on its OWNER profile, which the shared helper must
// never touch). Matching it would fire on both and the second is correct code.
// So the rule covers what it can decide: an UNSCOPED delete, and one scoped to the
// literal shared profile.
//
// `LIKE` is out of scope too — a prefix sweep is a different contract from the
// helper's exact-title delete, and training-log-search-depth and
// unclassified-activity both use one legitimately.
const SHARED_ACTIVITY_DELETE_RE =
  /DELETE\s+FROM\s+activities\s+WHERE\s+(?:profile_id\s*=\s*1\s+AND\s+)?title\s*(?:=|IN\s*\()/gis;

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
// training-log-provenance 700ms-autosave-must-not-fire probes), so it's excluded from
// the count and the allowlist is empty — uniform with FIRST_ALLOW/TOPASS_ALLOW. The
// profile-switch toaster polls became identifiable GETs in #1878/#4592, so that spec
// awaits the responses directly. A NEW unmarked waitForTimeout fails CI.
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

// ── Multi-box geometry reads (#2437's settledBoxes, the #2559 follow-up) ─────
// `await Promise.all([a.boundingBox(), b.boundingBox()])` LOOKS atomic and is
// not: each box is its own CDP round-trip and the page keeps laying out between
// them. Subtract two of those reads and the result can describe a layout that
// never existed — then it is asserted with a plain numeric `expect`, which
// cannot retry, because the numbers are already in variables. That is a flake
// with two nasty properties: it needs a real layout shift to show up (so it
// hides for months), and `boundingBox()` has no ceiling of its own, so when the
// element never arrives the test burns its FULL timeout instead of failing at
// five seconds.
//
// `settledBoxes([...])` reads the whole group and repeats until two consecutive
// passes agree, so every box comes from one settled layout and none is null.
//
// EMPTY after the test-fragility sweep migrated the remaining 25 reads. There is
// no per-line escape marker on purpose: unlike `.first()` there is no legitimate
// reason to read RELATIVE geometry from two unsynchronised snapshots.
// The `(?!Promise\.all)` lookahead is load-bearing twice over. Without it a lazy
// `[\s\S]*?` walks out of one Promise.all and into the NEXT one to find its second
// `.boundingBox(`, so a block holding a single box pairs up with a stranger's and
// the count drifts. Bounding on `[^\]]` instead does not work either: a selector
// like `locator('[data-testid="x"]')` inside the array carries its own `]` and
// ends the match early, under-counting. Both mistakes were made writing this.
const MULTI_BOX_RE =
  /await\s+Promise\.all\(\s*\[(?:(?!Promise\.all)[\s\S])*?\.boundingBox\((?:(?!Promise\.all)[\s\S])*?\.boundingBox\(/g;
const MULTI_BOX_ALLOW: Record<string, number> = {};

// ── (v-b) A swipe aimed at a point it MEASURED (issue #2714) ─────────────────
//
// `touchSwipe(page, from, to)` is for the gestures anchored to the DOCUMENT —
// the drawer's edge swipe, the Timeline's day swipe, a mid-screen swipe that
// must open nothing. Every one of them names its coordinates inline, because a
// screen position IS the gesture and no element has to be under it.
//
// A gesture anchored to an ELEMENT cannot be spelled that way honestly. Its
// point has to be measured, and a measured point is a fact about the PAST from
// the instant it is returned. #2714 is what that costs: the quick-log sheet
// gathers its "Due & usual now" row lazily (#1468) and a bottom-anchored panel
// grows UPWARD when it lands, so the drag handle left the coordinate a settled
// measurement had just certified, the recognizer's containment test rejected
// the landing, and the swipe did NOTHING — silently, while the spec waited out
// its budget for an exit that was never scheduled.
//
// So a `from` that is not an inline `{ x, y }` literal is banned: use
// `touchSwipeFrom(page, locator, { dx, dy })`, which re-aims and then proves
// where the finger landed. Un-exporting `centerOf` closed the blessed way to
// mint such a point; this closes the hand-rolled way (a `boundingBox()` read
// and some arithmetic), which is the half a helper change cannot reach.
//
// `touchSwipeFrom(` is not matched — the `\(` is anchored to the end of the
// name. The allowlist is EMPTY and there is no known reason to grow it.
//
// The whitespace goes INSIDE the lookahead — `,(?!\s*\{)`, never `,\s*(?!\{)`.
// The second spelling is the one that reads right and is always wrong: `\s*` can
// match nothing, so on ` { x: 2 …` the lookahead is asked about the SPACE, which
// is not a brace, and every compliant call site is reported. That bug is why
// this comment exists.
const SWIPE_POINT_RE = /touchSwipe\(\s*[A-Za-z_$][\w$]*\s*,(?!\s*\{)/g;
const SWIPE_POINT_ALLOW: Record<string, number> = {};

// ── (v-c) A bare .click() on a ⋯ MENU TRIGGER (issue #2942) ──────────────────
//
// A tap dispatched before React attaches the handler is DISCARDED — no error, no
// warning, Playwright's actionability checks all pass because the element really is
// there. The failure then surfaces seconds later as the thing the tap should have
// revealed being missing, which reads as "the menu is broken" rather than "the
// trigger was never pressed". `form-drafts.spec.ts` flaked two shards on exactly
// that shape, and the 2026-07-26 weekly census red was another copy of it
// (`wellbeing-check.spec.ts:154`, on two shards at once).
//
// WHY THIS RULE KEYS ON THE CONTROL AND NOT ON THE POSITION. #2942 first proposed the
// positional form — a `.click()` whose nearest preceding statement is a
// `goto`/`reload`/`waitForURL`. That rule cannot see its own motivating case:
// `openNewActivity`'s click is the FIRST statement of a module-local helper and the
// `goto` is in the CALLER, one function up. Following that would need the call graph,
// which a text scan does not have, and a helper called from five places is only
// sometimes preceded by a navigation anyway. The control's IDENTITY is the stable
// property, and it sits in the SAME statement as the click — so the rule is local, and
// it reaches into helper bodies for free (the scan has read every e2e/*.ts, module-local
// helpers included, since #868 phase 2; what it never had was a rule phrased locally
// enough to use that reach).
//
// THE CONTROL: the `OverflowMenu` trigger (components/OverflowMenu.tsx) — the row ⋯
// kebab. It is a pure client TOGGLE: no POST to settle on, no URL to watch, so
// `settledClick` and `followLink` do not apply and a retry loop would close the menu
// it just opened. `hydratedClick` is the primitive for exactly this — probe for React's
// markers on the node, then click ONCE.
//
// Located two ways in the suite, both matched: the `overflow-menu-trigger` testid, and
// the trigger's accessible name (`aria-label` on the same button), which since #3501
// reads "… actions for …" or "Actions for …" at EVERY call site — the name is composed
// in lib/overflow-menu-label.ts rather than typed per caller, so the accessible-name
// arm below no longer has exceptions to miss.
//
// THE MENU ITEM IS NOT IN SCOPE, and that is a mechanism claim, not a concession. The
// panel is `{open && createPortal(…)}` — a menu item exists only because a trigger
// click already landed, which is itself proof that React had attached. Scanning items
// too would have flagged 51 more sites for a window that is already closed; the
// false-positive tail #2942 anticipated turned out to live entirely in that half, and
// it is removed by an argument rather than papered over with a marker.
//
// KNOWN LIMIT: a trigger stored in a `const` and clicked in a later statement evades
// the `(?!;)` gap. That is deliberate — the testid is on every trigger, so the honest
// fix at an evading site is to spell it that way — not a supported escape.
//
// The OTHER limit this note used to carry is gone: three labels did not say "actions"
// at all (`"Snooze or dismiss"`, `${def.label} options`, `label={name}`) and their
// call sites were invisible to the name arm unless they used the testid. #3501 retired
// the `label` prop that let a caller write those, so the arm's coverage went up on its
// own — and the seven bare taps it then revealed (substance-use, substance-quicklog)
// were converted rather than granted an allowance, which is what raised those files to
// the discipline the rest of the suite already had.
//
// The `(?!;)` guard is the MULTI_BOX_RE `(?!Promise\.all)` trick: without it the lazy
// gap walks out of one statement and pairs a marker with a stranger's `.click(`.
const MENU_TRIGGER_CLICK_RE =
  /(?:overflow-menu-trigger|(?:getByLabel|getByRole)\((?:(?!;)[^)])*?[Aa]ctions)(?:(?!;)[\s\S])*?\.click\(/g;
// A same-line `hydrated-ok: <why>` comment is a reviewed bare click (the first-ok
// escape-marker shape). The one use today is a re-open-if-closed `toPass` guard that
// already tolerates a swallowed tap and only re-opens when the item is NOT visible,
// so it can never toggle the menu shut.
const MENU_TRIGGER_OK_MARKER = "hydrated-ok";
// Frozen at today's per-file counts. This is a GRANDFATHER list, not an endorsement:
// every entry is a bare tap on a control whose click can be swallowed, and the same
// immutable-downward discipline as FIRST_ALLOW applies — convert a site to
// hydratedClick and LOWER its number in the same PR. The #2942 pass cleared the
// module-local HELPER sites first (the class the issue was filed about, and the half a
// call-site-only reading would never have found): food-log, food-log-correction,
// illness-episode-followups, intake-lifecycle, offline-dose-confirm, saved-star.mobile,
// trends-default-range and trends-overview-curated.mobile, six of which reached zero.
const MENU_TRIGGER_CLICK_ALLOW: Record<string, number> = {
  "appointments.spec.ts": 2,
  "care-plan.spec.ts": 1,
  "clinical-undo.spec.ts": 3,
  "condition-family-attributes.spec.ts": 2,
  "dose-history.spec.ts": 6,
  "dose-skip.spec.ts": 1,
  "drug-interactions.spec.ts": 1,
  "entry-ergonomics.spec.ts": 1,
  "episode-med-reconcile.spec.ts": 1,
  "equipment-lifecycle.spec.ts": 3,
  "equipment-manager.spec.ts": 1,
  "food-log-correction.spec.ts": 3,
  "genomics.spec.ts": 2,
  "goal-metric-switch.spec.ts": 1,
  "imaging.spec.ts": 3,
  "immunization-delete-confirm.spec.ts": 1,
  "import-records-browser.spec.ts": 1,
  "intake-lifecycle.spec.ts": 2,
  "medications-followups.spec.ts": 4,
  "medications-page.spec.ts": 1,
  "menu-confirm-cancel.spec.ts": 1,
  "merge-conflict.spec.ts": 1,
  "merge-sets.spec.ts": 1,
  "mobile-ui-polish.spec.ts": 1,
  "multi-view.spec.ts": 3,
  "nway-merge.spec.ts": 1,
  "preventive-upcoming.spec.ts": 2,
  "protocol-practice.spec.ts": 1,
  "records-recency.spec.ts": 1,
  "shared-supply-details.spec.ts": 2,
  "shared-supply-picker.spec.ts": 1,
  "substance-use.spec.ts": 2,
  "training-log-merge.spec.ts": 1,
  "trends-card-pin.spec.ts": 1,
  "undo-delete.spec.ts": 1,
  "upcoming-aggregate.spec.ts": 2,
  "upcoming-row-actions.mobile.spec.ts": 1,
  "upcoming-row-actions.spec.ts": 1,
  "vision.spec.ts": 2,
};

// ── (v-d) A bare .click() on a confirm dialog's DELETE (issue #3454) ─────────
//
// Two clicks land the activity discard: the editor's Delete, then the confirm
// dialog's. The second one starts a Server Action, and the dialog closing is a
// `setState` — so a spec that clicks it and then asserts a CLIENT fact, or asserts
// nothing at all, has finished while `deleteActivity` is still in flight. That is
// #3292's confirm-then-assert-a-client-fact pattern, and the discard is the copy of
// it that costs other people merges: the `noSharedProfileLeak` teardown guard
// (e2e/fixtures.ts) reads the WORKER DATABASE once the page is gone, so it sees the
// row on its way out and fails — with a green body, in whatever spec happened to
// run, on whatever PR happened to be in CI.
//
// MEASURED THREE TIMES ON 2026-08-21, which is what took #3454 from P3 to P2:
// `entry-ergonomics.spec.ts:697` 2 failures in 4 runs on an UNMODIFIED origin/main
// control worktree; the same file's `:783` red once in a local batch on PR #3456 and
// green on an identical re-run; and `:697` again in `e2e (4)` on PR #3464, whose diff
// is entirely `lib/` number readers. Two distinct sites in one file, one root cause.
//
// THE BLESSED SPELLING IS `deleteActivityFromForm(page, { trigger? })`
// (e2e/helpers.ts, #3267). It settles on the "Activity deleted." toast, which
// `useUndoableDelete` raises only after `await action(fd)` has RESOLVED, so the row
// is gone when it returns — and it takes the toast down again, because a `fixed`
// bottom-right card intercepts the next click (#2861). Ten hand-rolled copies across
// six files were converted in #3454; the freeze is ZERO so an eleventh cannot appear.
//
// WHY THE COUNT-FREEZE AND NOT A REVIEW RULE. The un-settled spelling passes every
// gate on a quiet box — that is the entire defect — so the only thing that can see it
// before CI does is a scan. Run over origin/main at b0bcf2d2 this regex reports all
// ten converted sites plus the one marked below; over the converted tree it reports
// only the marked one.
//
// THE ESCAPE, and there is exactly one use: a discard whose OWN next assertion is a
// server fact the delete alone can satisfy. `unclassified-activity.spec.ts` waits for
// `/history`, and `leaveDeletedActivityPage` navigates only once `onDeleted` has
// fired; it also presses Undo afterwards, so the helper — which dismisses that very
// toast — is the wrong tool there rather than a missing one. Mark such a site with a
// same-line `confirm-delete-ok: <why>` comment on the `.click(` line (the `first-ok`
// escape shape). "The dialog closed" and "the form unmounted" are NOT such facts.
//
// KNOWN LIMIT, deliberate and not a supported escape: a dialog captured in a variable
// (`const d = await openConfirm(…)`) and clicked in a LATER statement evades the
// `(?!;)` statement gap, which is the same limit MENU_TRIGGER_CLICK_RE documents. The
// direct chain is how all eleven sites in the suite are actually written, and it is
// how anyone reintroducing the pattern would write it; encoding a shape the tree does
// not use would have made this guard green and blind at the same time.
//
// `name: "Delete"` is anchored on its closing quote on purpose: the longer destructive
// labels in the suite ("Delete login", "Delete document & its records") drive tables
// this teardown guard does not read, and each already ends on a `waitForURL` or a
// re-queried row count that only a landed write satisfies.
const CONFIRM_DELETE_CLICK_RE =
  /getByTestId\(\s*["']confirm-dialog["']\s*\)(?:(?!;)[\s\S])*?name:\s*["']Delete["'](?:(?!;)[\s\S])*?\.click\(/g;
const CONFIRM_DELETE_OK_MARKER = "confirm-delete-ok";
const CONFIRM_DELETE_CLICK_ALLOW: Record<string, number> = {};

// ── (v-e) An UNSCOPED page.getByTestId on a streaming page (issue #4890) ─────
//
// THE DEFECT. A page whose Suspense boundary streams delivers the boundary's
// content TWICE for a window: React flushes it into a `<div hidden>` appended to
// `<body>` and an inline `$RC(…)` script relocates it into the document. While
// both exist, every marker inside the boundary exists twice with the same testid,
// so a GLOBAL `page.getByTestId("x")` resolves to 2 elements and throws a
// strict-mode violation rather than retrying down to one. Under CI load the window
// outlives Playwright's retry, so it is a deterministic property of the page and
// not a flake.
//
// WHY IT IS A RULE AND NOT A HELPER. This was caught three times reading it one
// marker at a time — `history-row`, then `routine-new`, then
// `training-log-clear-filters` — across four specs, and each reading fixed the
// marker in front of it and left the page exposed. A `trainingRow()` helper covers
// the markers somebody thought to put on it; a lint rule covers the NEXT call site
// by default and forces an exemption to be written down. One occurrence reached
// the failure THROUGH e2e/helpers.ts, where the call site could not have scoped its
// way out at all — which is why this is the one guard here that also reads the
// blessed helper module.
//
// WHAT COUNTS AS SCOPED. The staged copy's ancestry stops at `<body>`, so any scope
// that lives in the document proper excludes it. A locator whose receiver is not
// the bare `page` — a row, a card, a dialog, `appContent(page)` — is already
// scoped and is not matched here. A `page.getByTestId(root)` naming one of the
// TESTID_SCOPE_ROOTS below IS the scope, so the chained
// `page.getByTestId("training-page").getByTestId("routine-new")` form that #4833
// shipped stays legal.
//
// A root has to be a marker that exists ONCE per document and sits ABOVE every
// boundary: `app-content-container` is the app shell's wrapper around every
// `(app)` page's children, and `training-page` is the hub header the #4890
// boundary sits inside. Do not add a root that could itself land inside a
// streamed section — that would bless the very duplicate this guard is about.
//
// THE ALLOWLIST IS THE HONEST RECORD. 5,422 unscoped lookups across 435 files exist
// today, and a rule that started as "scope all of them" would be 5,422 hand edits
// with nothing preventing the 5,423rd. So today's per-file counts are frozen in
// __fixtures__/e2e-testid-scope-allow.json — immutable-downward like every other
// list here — and the list says what has NOT been checked rather than claiming
// everything has. A NEW bare locator anywhere fails; scope it, or mark the line
// `testid-scope-ok: <why>` when the marker provably cannot be inside a streamed
// boundary (a `/login` page, an overlay portalled to `<body>`).
const TESTID_SCOPE_ROOTS = ["app-content-container", "training-page"];
// The argument test, as a NEGATIVE lookahead with the whitespace INSIDE it. Written
// as `\s*(?!…)` the `\s*` is greedy and backtracks until the lookahead succeeds, so
// `page.getByTestId(  "training-page")` would read as unscoped — a guard that fires on
// the one form it exists to bless.
const TESTID_ROOT_ARG = `(?!\\s*[\"'\`](?:${TESTID_SCOPE_ROOTS.join("|")})[\"'\`]\\s*\\))`;

// A Playwright `Page` under any name. `page` is the fixture, but a spec that opens a
// second context names it whatever the story needs — `member`, `tabB`, `anon`,
// `otherPage` — and 298 of the bare lookups in the suite are on one of those. A rule
// that read only the literal `page.` would have declared those clean, which is the
// same per-name narrowness #4890 was caught by three times, one level down.
const PAGE_ALIAS_RE =
  /\b([A-Za-z_$][\w$]*)\s*(?::\s*Page\b|=\s*await\s+[\w$.]*(?:newPage|loginAs|comparePage)\s*\()/g;

export function pageIdentifiers(code: string): Set<string> {
  const ids = new Set<string>(["page"]);
  for (const m of code.matchAll(PAGE_ALIAS_RE)) ids.add(m[1]);
  return ids;
}

/**
 * Lookups in `scanned` that start from a whole PAGE and name a testid that is not one
 * of the roots — i.e. the shape that also matches the staged copy (#4890).
 *
 * Receiver-based, not chain-based, deliberately. `page.getByTestId(root).getByTestId(x)`
 * is safe because the ROOT is unique in the document, never because a chain happens to
 * be two calls long: `page.getByTestId("history-row").locator("a")` chains just as far
 * and still matched both copies. So the question this asks is only ever "does this
 * lookup start at a page, and does it name a root".
 */
export function countUnscopedTestIds(scanned: string, code = scanned): number {
  let n = 0;
  for (const id of pageIdentifiers(code)) {
    const re = new RegExp(
      // Whitespace around the dot: prettier wraps a long chain as `page\n  .getByTestId(`,
      // and 443 lookups in the suite are written that way. An `\bpage\.` anchored rule
      // read every one of them as absent — the hole this guard's own mutation test found.
      `\\b${id.replace(/\$/g, "\\$")}\\s*\\.\\s*getByTestId\\(` +
        TESTID_ROOT_ARG,
      "g"
    );
    n += (scanned.match(re) ?? []).length;
  }
  return n;
}

const BARE_TESTID_OK_MARKER = "testid-scope-ok";
const BARE_TESTID_ALLOW_FILE =
  "lib/__tests__/__fixtures__/e2e-testid-scope-allow.json";
const BARE_TESTID_ALLOW: Record<string, number> = JSON.parse(
  fs.readFileSync(path.join(REPO, BARE_TESTID_ALLOW_FILE), "utf8")
) as Record<string, number>;

// The app's own streaming surface, frozen (#4890).
//
// `components/StreamedSection.tsx` is what makes a section genuinely suspend —
// every read in this app is synchronous better-sqlite3, so an `async` Server
// Component resolves in microtasks and a bare `<Suspense>` around it never
// flushes early. It is therefore the one thing that produces the staged
// `<div hidden>` copy, and its two call sites are the whole hazard surface:
// `/training` (the tab panel) and `/trends` (the Body census). The other two
// boundaries below do not stage server content — app/layout.tsx wraps a client
// component reading useSearchParams behind a null fallback, and the chart-empty
// harness suspends a client chart — but they are frozen with the rest so the
// list reads as "every Suspense in app/", which is the thing to re-check.
//
// `loading.tsx` is the other way in, and app/(app)/layout.tsx already refuses it
// in prose (#530). Frozen at zero below so the refusal has teeth.
const SUSPENSE_BOUNDARY_FILES = [
  "app/(app)/e2e-fixtures/chart-empty/ChartEmptyHarness.tsx",
  "app/(app)/training/page.tsx",
  "app/(app)/trends/page.tsx",
  "app/layout.tsx",
  // The three chart wrappers suspend a `dynamic(..., { ssr: false })` import from
  // inside a "use client" component — client-only, so nothing is ever staged.
  "components/BarSparkline.tsx",
  "components/LineChartCard.tsx",
  "components/ScatterChartCard.tsx",
];
const STREAMED_SECTION_FILES = [
  "app/(app)/training/page.tsx",
  "app/(app)/trends/page.tsx",
];

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
const LOGIN_CONST_NAME_RE = /\bE2E_LOGIN_[A-Z0-9_]+\b/g;
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
const SPEC_OWNED_DRAFT_SCOPE_RE =
  /kind:\s*["']spec-owned["'][\s\S]{0,300}?ownerLogin:\s*(E2E_LOGIN_[A-Z0-9_]+)/g;
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
//
// MEMOIZED for the file's lifetime. This walks the whole e2e tree and reads every
// source into memory, and it used to run again for EVERY check in this file — a
// couple of hundred file reads per run, growing with each check added. The suite's
// sources cannot change while the suite is running, so the repeat reads bought
// nothing but wall clock, and under the shared-registry tier's parallel load that
// clock is charged against a 5 s per-test timeout: the #1392 login-budget check
// (the heaviest reader here) started timing out when this file grew a 21st caller.
interface SpecFile {
  name: string;
  text: string;
  code?: string;
}

const strippedTextCache = new Map<string, string>();
function cachedStripComments(text: string): string {
  const cached = strippedTextCache.get(text);
  if (cached !== undefined) return cached;
  const code = stripComments(text);
  strippedTextCache.set(text, code);
  return code;
}

function codeFor(file: SpecFile): string {
  return (file.code ??= cachedStripComments(file.text));
}

let allE2eFilesCache: SpecFile[] | undefined;
function allE2eFiles(): SpecFile[] {
  if (allE2eFilesCache) return allE2eFilesCache;
  const out: SpecFile[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // Skip the runtime dot-dirs (.data / .auth / test-results) — generated, not source.
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        const name = path.relative(E2E_DIR, full).split(path.sep).join("/");
        out.push({ name, text: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(E2E_DIR);
  allE2eFilesCache = out.sort((a, b) => a.name.localeCompare(b.name));
  return allE2eFilesCache;
}

let specFilesCache: SpecFile[] | undefined;
function specFiles(): SpecFile[] {
  return (specFilesCache ??= allE2eFiles().filter(
    (f) => !SCAN_EXCLUDE.has(f.name)
  ));
}

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

/**
 * The text a frequency count is taken over: comments blanked once per source, with
 * escape-marked lines then dropped by consulting the original text (#3621).
 *
 * TWO PROJECTIONS, AND THE DISTINCTION IS THE WHOLE POINT. The
 * `first-ok:`/`topass-ok:` escape lives IN a comment, so marker detection reads the
 * raw line; matching reads the cached comment-blanked line. This used to express the
 * same distinction by stripping a newly filtered copy for every guard — twenty
 * full-corpus scanner passes over bytes that cannot change during the run.
 *
 * WHY BLANK AT ALL. These are counts over raw text, so a sentence EXPLAINING a
 * banned call counted as one: a spec that documents why it reaches for `.first()`
 * was itself an unmarked offender, and the fix everyone reaches for is to reword
 * the prose — which is the wrong fix twice over (#3621). Blanked in place rather
 * than deleted, so counts stay comparable and any line number derived from this
 * text still points at the real line. It lives INSIDE the scanner, not at the call
 * site, so the next pattern added here cannot forget it.
 *
 * STRING LITERALS SURVIVE, deliberately. A locator built from a string is a call
 * site, not prose.
 */
function hygieneScanTextFrom(
  text: string,
  stripped: string,
  excludeLineMarker?: string
): string {
  if (!excludeLineMarker) return stripped;
  const rawLines = text.split("\n");
  return stripped
    .split("\n")
    .filter((_, index) => !rawLines[index]?.includes(excludeLineMarker))
    .join("\n");
}

export function hygieneScanText(
  text: string,
  excludeLineMarker?: string
): string {
  return hygieneScanTextFrom(
    text,
    cachedStripComments(text),
    excludeLineMarker
  );
}

/**
 * Line indices in an e2e source that BRANCH on `process.env.CI` with no `ci-ok:`
 * reason within a line either side.
 *
 * ONE ANSWER IN THIS FILE TO "IS THIS PROSE" (#3402). This check used to hand-roll
 * its own strip — `line.replace(/\/\/.*$/, "")` — while the frequency counts above
 * use the shared scanner, and the divergence failed toward PASS: a `//` that opens a
 * URL rather than a comment blanked the rest of the line, so
 * `page.goto("https://…/" + (process.env.CI ? … : …))` was a real unmarked branch this
 * guard could not see. Specs are full of URLs, so that is the spelling to worry about.
 *
 * `stripComments` preserves newlines and byte offsets, so the blanked lines index
 * identically to the raw ones. The marker window deliberately still reads the RAW
 * lines: the `ci-ok:` escape LIVES in a comment.
 */
export function unmarkedCiBranchLines(text: string): number[] {
  // Comment stripping cannot create the marker. Most e2e files do not mention it,
  // so avoid lexing the whole corpus for the handful that can answer this check.
  if (!CI_ENV_RE.test(text)) return [];
  const lines = text.split("\n");
  const code = cachedStripComments(text).split("\n");
  const out: number[] = [];
  lines.forEach((line, i) => {
    if (!CI_ENV_RE.test(code[i] ?? "")) return;
    const window = [lines[i - 1], line, lines[i + 1]];
    if (window.some((l) => l?.includes(CI_OK_MARKER))) return;
    out.push(i);
  });
  return out;
}

function checkPattern(
  label: string,
  re: RegExp | ((scanned: string, file: SpecFile) => number),
  allow: Record<string, number>,
  opts?: {
    hint?: string;
    // Lines matching this marker are excluded before counting (the first-ok escape).
    excludeLineMarker?: string;
    // Files skipped entirely — the blessed HOME for a pattern (e.g. family-helpers.ts
    // legitimately contains the family-create sequences it exists to centralize).
    skipFiles?: Set<string>;
    // The corpus to read, when a rule's reach differs from the default one. The
    // #4890 testid-scope rule passes allE2eFiles() because one of its known
    // occurrences was inside e2e/helpers.ts itself, which SCAN_EXCLUDE hides.
    corpus?: SpecFile[];
    // Where the frozen counts live, when they are not inline in this file.
    allowFile?: string;
  }
) {
  const files = (opts?.corpus ?? specFiles()).filter(
    (f) => !opts?.skipFiles?.has(f.name)
  );
  const seen = new Set<string>();
  const violations: string[] = [];
  const hint =
    opts?.hint ??
    `New occurrences are banned — use e2e/helpers.ts (settledClick/followLink); ` +
      `see docs/internals/e2e-hygiene.md.`;

  for (const file of files) {
    const { name, text } = file;
    // Comment stripping cannot create a match. Keep the exact code-only verdict
    // for raw candidates without lexing guaranteed-empty files for every rule.
    const scanned = () =>
      hygieneScanTextFrom(text, codeFor(file), opts?.excludeLineMarker);
    const count =
      typeof re === "function"
        ? re(scanned(), file)
        : countMatches(text, re)
          ? countMatches(scanned(), re)
          : 0;
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
          `${opts?.allowFile ?? "lib/__tests__/e2e-hygiene.test.ts"} so the ` +
          `allowlist keeps shrinking.`
      );
    }
  }

  // A stale allowlist entry for a file that no longer exists must be removed.
  for (const name of Object.keys(allow)) {
    if (!seen.has(name)) {
      violations.push(
        `${name}: allowlisted for ${label} but the spec file no longer exists — ` +
          `remove its entry in ${opts?.allowFile ?? "lib/__tests__/e2e-hygiene.test.ts"}.`
      );
    }
  }

  expect(violations, violations.join("\n")).toEqual([]);
}

// ── WHAT THE FREQUENCY COUNTS CAN AND CANNOT SEE (#3621) ────────────────────
//
// Every count above is green over a tree that already complies, which says nothing
// about what it can see. These run the preparation step over sources authored to
// break it — the offender, the prose that must NOT be one, the reviewed escape, and
// the string literal that must still count.
//
// PROSE WAS THE LIVE DEFECT AND IT FAILED TOWARD RED, which is why it stayed latent:
// a spec explaining why it reached for a banned call became an unmarked offender,
// and the obvious fix — rewording the sentence — is one this repo has correctly
// refused twice. Handed to the function rather than planted in `e2e/`, because that
// directory is the corpus this same file walks and several other guards walk it too.
describe("the hygiene counts read code, not prose (#3621)", () => {
  const count = (text: string, marker?: string): number =>
    countMatches(hygieneScanText(text, marker), FIRST_RE);

  it("counts a real call", () => {
    expect(count('await page.getByRole("row").first().click();\n')).toBe(1);
  });

  it("does not count a line comment explaining one", () => {
    expect(
      count(
        "// The list is spec-owned, so .first() would be safe here — we still\n" +
          "// target the planted marker instead.\n" +
          'await page.getByTestId("planted-row").click();\n'
      )
    ).toBe(0);
  });

  it("does not count a block comment or a JSDoc explaining one", () => {
    expect(
      count(
        "/**\n * Why not .first(): the surface is seeded by two profiles.\n */\n" +
          'await page.getByTestId("planted-row").click();\n'
      )
    ).toBe(0);
  });

  it("still honours the reviewed same-line escape", () => {
    expect(
      count(
        "await owned.first().click(); // first-ok: fixture planted in this spec\n",
        "first-ok:"
      )
    ).toBe(0);
  });

  it("still counts one inside a string, which is a call site and not prose", () => {
    // The scanner preserves string and template contents verbatim; a locator
    // assembled as text is still a locator.
    expect(count('const sel = "row.first()";\n')).toBe(1);
  });

  it("counts a call that a comment shares a line with", () => {
    expect(
      count("await rows.first().click(); // the fold is spec-owned\n")
    ).toBe(1);
  });
});

describe("the bare-year assertion guard (#4369)", () => {
  const count = (text: string): number =>
    countMatches(hygieneScanText(text), BARE_YEAR_ASSERTION_RE);

  it("catches positive and vacuous-negative fixed years, not derived dates", () => {
    expect(
      count("await expect(row).toContainText(/Monday, July 1, 2026/);")
    ).toBe(1);
    expect(count('await expect(row).not.toContainText("2026");')).toBe(1);
    expect(count("await expect(row).toContainText(formatLongDate(day));")).toBe(
      0
    );
    expect(
      count("await expect(row).not.toContainText(/\\b(?:19|20)\\d{2}\\b/);")
    ).toBe(0);
  });
});

// The ci-ok check reads the SAME projection, and both directions matter (#3402).
// The URL case is the one the hand-rolled strip got wrong, and it got it wrong
// toward PASS — the silent direction — while the prose cases are the ones an author
// meets when they document a branch they removed.
describe("the testid-scope pattern discriminates a scoped locator from a bare one (#4890)", () => {
  const count = (text: string): number =>
    countUnscopedTestIds(
      hygieneScanText(text, BARE_TESTID_OK_MARKER),
      hygieneScanText(text)
    );

  it("flags a bare global locator — the shape that matched the staged copy", () => {
    expect(count('await page.getByTestId("routine-new").click();\n')).toBe(1);
    expect(
      count('await expect(page.getByTestId("history-row")).toHaveCount(3);\n')
    ).toBe(1);
    // Through a helper, where the call site could not have scoped its way out.
    expect(
      count('await hydratedClick(page, page.getByTestId("routine-new"));\n')
    ).toBe(1);
    // A dynamic testid is never a root.
    expect(count("page.getByTestId(`day-${iso}`).click();\n")).toBe(1);
  });

  it("does not flag a locator scoped through a root, a helper, or a held locator", () => {
    expect(
      count(
        'await page\n  .getByTestId("training-page")\n  .getByTestId("routine-new")\n  .click();\n'
      )
    ).toBe(0);
    expect(
      count('appContent(page).getByTestId("routine-new").click();\n')
    ).toBe(0);
    expect(count('row.getByTestId("history-row-title").click();\n')).toBe(0);
    expect(
      count('const main = page.getByTestId("app-content-container");\n')
    ).toBe(0);
  });

  it("honours the reviewed same-line escape and ignores prose", () => {
    expect(
      count(
        'await page.getByTestId("login-submit").click(); // testid-scope-ok: /login is outside the (app) shell\n'
      )
    ).toBe(0);
    expect(
      count(
        '// A bare page.getByTestId("routine-new") would match the staged copy too.\n' +
          'await appContent(page).getByTestId("routine-new").click();\n'
      )
    ).toBe(0);
  });

  it("reads the wrapped chain prettier actually writes", () => {
    // 443 lookups in the suite are wrapped this way; an `\bpage\.`-anchored rule saw none.
    expect(
      count('await page\n  .getByTestId("history-row")\n  .click();\n')
    ).toBe(1);
    // And the root test survives the same wrapping, in both directions.
    expect(
      count(
        'await page\n  .getByTestId(\n    "training-page"\n  )\n  .getByTestId("routine-new");\n'
      )
    ).toBe(0);
  });

  it("reads a SECOND page under whatever name the spec gave it", () => {
    expect(
      count(
        "const member = await loginAs(browser, creds(E2E_LOGIN_MEMBER));\n" +
          'await member.getByTestId("history-row").click();\n'
      )
    ).toBe(1);
    expect(
      count(
        "const member = await loginAs(browser, creds(E2E_LOGIN_MEMBER));\n" +
          'await appContent(member).getByTestId("history-row").click();\n'
      )
    ).toBe(0);
    // A Locator named like a page is not a page — nothing declares it one.
    expect(count('memberCard.getByTestId("history-row").click();\n')).toBe(0);
  });
});

describe("the ci-ok check reads code, not prose (#3402)", () => {
  it.each([
    ["if (process.env.CI) await slow();", [0], "a bare branch"],
    [
      'await page.goto("https://x.test/" + (process.env.CI ? "?ci" : ""));',
      [0],
      "a branch after a URL on the same line",
    ],
    [
      "const re = /\\/\\//; if (process.env.CI) await slow();",
      [0],
      "a branch after a regex holding a slash pair",
    ],
    [
      "// this used to sit behind `if (process.env.CI)` and no longer does",
      [],
      "prose about a removed branch",
    ],
    [
      "/**\n * Why there is no process.env.CI branch: one build shape.\n */",
      [],
      "a JSDoc explaining one",
    ],
    [
      "if (process.env.CI) await slow(); // ci-ok: only the runner has the artifact dir",
      [],
      "a reviewed same-line escape",
    ],
    [
      "// ci-ok: only the runner has the artifact dir\nif (process.env.CI) await slow();",
      [],
      "the escape on the line above",
    ],
  ])("%s -> %j (%s)", (text, expected) => {
    expect(unmarkedCiBranchLines(text)).toEqual(expected);
  });
});

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

  it("no e2e/*.ts branch on process.env.CI without a written reason (mark ci-ok)", () => {
    const violations: string[] = [];
    for (const { name, text } of specFiles()) {
      for (const i of unmarkedCiBranchLines(text)) {
        violations.push(
          `${name}:${i + 1}: branches on process.env.CI with no written reason. ` +
            `The harness serves ONE build shape — e2e/fixtures.ts spawns every ` +
            `worker with NODE_ENV=production — so process.env.CI is NOT a proxy ` +
            `for "is this a production build" (#2645/#2648): assert what the ` +
            `harness can actually serve. If the branch really does need a ` +
            `runner-only fact (an artifact path, a service only the runner has), ` +
            `add a \`ci-ok: <why>\` comment naming it, on this line or the one ` +
            `above/below; see docs/internals/e2e-hygiene.md.`
        );
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
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

  it("no committed test.skip in e2e/*.ts (delete it or make its fixture deterministic)", () => {
    checkPattern("test.skip(", TEST_SKIP_RE, TEST_SKIP_ALLOW, {
      hint:
        `A committed skip makes a green run ambiguous about which contracts ran. ` +
        `Delete obsolete coverage, or make the boundary deterministic in the fixture; ` +
        `see docs/internals/e2e-hygiene.md.`,
    });
  });

  it("no NEW multi-box Promise.all geometry read in an e2e/*.ts (use settledBoxes)", () => {
    checkPattern(
      "multi-box Promise.all boundingBox read",
      MULTI_BOX_RE,
      MULTI_BOX_ALLOW,
      {
        hint:
          `Reading two or more boundingBox()es through Promise.all is not atomic — ` +
          `each is its own round-trip and the page lays out between them, so a ` +
          `RELATIVE assertion built from them can describe a layout that never ` +
          `existed. Use settledBoxes([...]) from e2e/helpers.ts, which repeats the ` +
          `whole group until two consecutive reads agree and returns non-null ` +
          `boxes; see docs/internals/e2e-hygiene.md.`,
      }
    );
  });

  it("no NEW touchSwipe aimed at a measured point in an e2e/*.ts (use touchSwipeFrom)", () => {
    checkPattern(
      "touchSwipe from a non-literal point",
      SWIPE_POINT_RE,
      SWIPE_POINT_ALLOW,
      {
        hint:
          `A swipe's starting point may only be an inline { x, y } literal — that ` +
          `is a gesture anchored to the DOCUMENT (the drawer's edge swipe, the ` +
          `Timeline's day swipe). A gesture that must START INSIDE AN ELEMENT ` +
          `cannot aim at a measured point: the point is stale from the instant it ` +
          `is returned, and a surface that relays out after settling (#2714 — the ` +
          `quick-log sheet's lazily gathered context row grows the panel upward) ` +
          `moves the target out from under it, whereupon the recognizer rejects ` +
          `the landing and the gesture does nothing at all. Use ` +
          `touchSwipeFrom(page, locator, { dx, dy }) from e2e/helpers.ts, which ` +
          `re-aims and proves where the finger landed; see ` +
          `docs/internals/e2e-hygiene.md.`,
      }
    );
  });

  // The guard above has an EMPTY allowlist, so the suite passing proves only
  // that nothing matched — a pattern that matches NOTHING would pass it forever.
  // These four samples are what make the green mean something, and they are not
  // hypothetical: the first draft of the pattern spelled the brace check
  // `,\s*(?!\{)`, whose `\s*` matches nothing and hands the lookahead a SPACE,
  // so it flagged every compliant call site in the tree.
  it("the measured-point pattern discriminates a point from a literal", () => {
    const matches = (src: string) => countMatches(src, SWIPE_POINT_RE) > 0;

    expect(matches("await touchSwipe(page, grip, { x: grip.x, y: 1 });")).toBe(
      true
    );
    expect(
      matches("await touchSwipe(\n  page,\n  grip,\n  { x: 1, y: 2 }\n);")
    ).toBe(true);
    expect(
      matches("await touchSwipe(page, { x: 2, y: 500 }, { x: 220, y: 505 });")
    ).toBe(false);
    expect(matches("await touchSwipeFrom(page, handle, { dy: 240 });")).toBe(
      false
    );
  });

  it("no NEW bare .click() on a ⋯ menu trigger in an e2e/*.ts (use hydratedClick)", () => {
    checkPattern(
      "bare .click() on a ⋯ menu trigger",
      MENU_TRIGGER_CLICK_RE,
      MENU_TRIGGER_CLICK_ALLOW,
      {
        excludeLineMarker: MENU_TRIGGER_OK_MARKER,
        hint:
          `A row's ⋯ overflow-menu trigger is a pure client TOGGLE — no POST to ` +
          `settle on, no URL to watch — so a tap dispatched before React attaches ` +
          `its onClick is DISCARDED in silence, and the failure surfaces later as ` +
          `the menu item not being found (#2942). Use ` +
          `hydratedClick(page, trigger) from e2e/helpers.ts, which waits for ` +
          `React's markers on that node and then clicks ONCE (a retry loop is wrong ` +
          `here: the second tap closes the menu the first one opened). The menu ` +
          `ITEM needs no gate — it exists only because the trigger click landed. ` +
          `For a reviewed exception add a same-line \`hydrated-ok: <why>\` comment; ` +
          `see docs/internals/e2e-hygiene.md.`,
      }
    );
  });

  // The allowlist above is a per-file FREEZE, so the suite passing proves the counts
  // did not grow — it cannot prove the pattern still matches the thing it names. A
  // regex that silently stopped matching would freeze every count at a number it can
  // no longer reach and pass forever. These samples are what make the green mean
  // something, and each is a shape that was actually in the tree.
  it("the menu-trigger pattern discriminates a bare tap from a gated one", () => {
    const matches = (src: string) =>
      countMatches(src, MENU_TRIGGER_CLICK_RE) > 0;

    // Bare taps — the three spellings the suite uses.
    expect(
      matches('await tile.getByTestId("overflow-menu-trigger").click();')
    ).toBe(true);
    expect(
      matches(
        'await row.getByRole("button", { name: "Record actions" }).click();'
      )
    ).toBe(true);
    expect(matches('await row.getByLabel("More actions").click();')).toBe(true);
    // A regex name, and a chain broken across lines by the formatter.
    expect(
      matches(
        'await row.getByRole("button", { name: /^Actions for the/ }).click();'
      )
    ).toBe(true);
    expect(
      matches(
        'await page\n  .locator("[data-tile-key=x]")\n  .getByTestId("overflow-menu-trigger")\n  .click();'
      )
    ).toBe(true);

    // Gated — hydratedClick does not spell the tap `.click(` at all.
    expect(
      matches(
        'await hydratedClick(page, tile.getByTestId("overflow-menu-trigger"));'
      )
    ).toBe(false);
    // A trigger merely ASSERTED on, with an unrelated click in the NEXT statement.
    // Without the `(?!;)` gap guard this pairs the marker with a stranger's click.
    expect(
      matches(
        'await expect(row.getByTestId("overflow-menu-trigger")).toHaveCount(1);\n' +
          "await other.click();"
      )
    ).toBe(false);
    // The menu ITEM is deliberately out of scope — the panel renders only while the
    // menu is open, so its existence already proves the trigger click landed.
    expect(
      matches('await page.getByRole("menuitem", { name: "Edit" }).click();')
    ).toBe(false);
    // Not every button whose name merely CONTAINS a word is a menu trigger; the
    // marker is anchored to a locator call, so a testid that happens to read
    // "quick-actions" is not matched by the accessible-name arm.
    expect(matches('await page.getByTestId("quick-actions").click();')).toBe(
      false
    );
  });

  it("no NEW bare .click() on a confirm dialog's Delete in an e2e/*.ts (use deleteActivityFromForm)", () => {
    checkPattern(
      "bare .click() on a confirm dialog's Delete",
      CONFIRM_DELETE_CLICK_RE,
      CONFIRM_DELETE_CLICK_ALLOW,
      {
        excludeLineMarker: CONFIRM_DELETE_OK_MARKER,
        hint:
          `The confirm's Delete starts a Server Action, and the dialog closing is a ` +
          `\`setState\` — so "the dialog went away", "the form unmounted" and ending ` +
          `the test outright all finish while the DELETE is still in flight, and the ` +
          `noSharedProfileLeak teardown guard reads the row on its way out (#3454, ` +
          `#3292). Use deleteActivityFromForm(page, { trigger? }) from e2e/helpers.ts: ` +
          `it settles on the "Activity deleted." toast, which is raised only after the ` +
          `action RESOLVED, and dismisses it (#3267). For a discard whose own next ` +
          `assertion is a server fact — a waitForURL the delete alone can satisfy — ` +
          `add a same-line \`confirm-delete-ok: <why>\` comment; see ` +
          `docs/internals/e2e-hygiene.md.`,
      }
    );
  });

  // Same reason as the menu-trigger samples above: a per-file freeze at ZERO passes
  // forever if the regex quietly stops matching. Every TRUE case below is a verbatim
  // shape that was in the tree at origin/main b0bcf2d2 — the ten sites #3454
  // converted — and the FALSE cases are the neighbours the guard must stay silent on,
  // because a rule that cries wolf on the settled spellings would be deleted within a
  // week and take the real guard with it.
  it("the confirm-delete pattern discriminates an unsettled discard from a settled one", () => {
    const matches = (src: string) =>
      countMatches(src, CONFIRM_DELETE_CLICK_RE) > 0;

    // The formatter-broken chain — how all ten converted sites were spelled.
    expect(
      matches(
        'await page\n  .getByTestId("confirm-dialog")\n' +
          '  .getByRole("button", { name: "Delete", exact: true })\n  .click();'
      )
    ).toBe(true);
    // Same chain on one line, and without `exact`.
    expect(
      matches(
        'await page.getByTestId("confirm-dialog").getByRole("button", { name: "Delete" }).click();'
      )
    ).toBe(true);
    // Driven from another Page object (a second member's context).
    expect(
      matches(
        'await member\n  .getByTestId("confirm-dialog")\n' +
          '  .getByRole("button", { name: "Delete", exact: true })\n  .click();'
      )
    ).toBe(true);

    // The blessed spelling names no dialog at all.
    expect(matches("await deleteActivityFromForm(page);")).toBe(false);
    expect(
      matches("await deleteActivityFromForm(page, { trigger: del });")
    ).toBe(false);
    // Wrapped in settledClick, which arms the action-POST wait before the tap — the
    // trash / undo-delete spelling, and a settle this rule must not call an offence.
    expect(
      matches(
        'await settledClick(\n  page,\n  page\n    .getByTestId("confirm-dialog")\n' +
          '    .getByRole("button", { name: "Delete", exact: true })\n);'
      )
    ).toBe(false);
    // A non-destructive button in the same dialog.
    expect(
      matches(
        'await page.getByTestId("confirm-dialog").getByRole("button", { name: "Cancel" }).click();'
      )
    ).toBe(false);
    // A LONGER destructive label — a different table, and each of those sites already
    // ends on a waitForURL only a landed write satisfies.
    expect(
      matches(
        'await dialog.getByTestId("confirm-dialog").getByRole("button", { name: "Delete document & its records" }).click();'
      )
    ).toBe(false);
    // The dialog merely ASSERTED on, with an unrelated Delete click in the NEXT
    // statement: without the `(?!;)` gap guard this pairs a stranger's click with it.
    expect(
      matches(
        'await expect(page.getByTestId("confirm-dialog")).toBeVisible();\n' +
          'await row.getByRole("button", { name: "Delete" }).click();'
      )
    ).toBe(false);
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

    // Index the population in one corpus pass. The old loop scanned every file once
    // per fixture login for references, then every sign-in window once per login —
    // quadratic work whose wall-clock budget was the #3385 flake. This preserves the
    // same textual definition of a reference/sign-in while making the login count a
    // lookup rather than another tree walk.
    const population = new Set(constants);
    const referencedBy = new Map<string, string[]>(
      constants.map((name) => [name, []])
    );
    const signsIn = new Set<string>();
    for (const file of files) {
      const names = new Set(file.text.match(LOGIN_CONST_NAME_RE) ?? []);
      for (const name of names) {
        if (population.has(name)) referencedBy.get(name)!.push(file.name);
      }
      for (const window of file.text.match(SIGNIN_WINDOW_RE) ?? []) {
        for (const name of window.match(LOGIN_CONST_NAME_RE) ?? []) {
          if (population.has(name)) signsIn.add(name);
        }
      }
    }

    for (const name of constants) {
      const why = LOGIN_NO_SIGNIN_ALLOW[name];
      if (signsIn.has(name)) {
        if (why)
          violations.push(
            `${name}: allowlisted as never-signed-in, but a spec now signs in as it — ` +
              `remove its LOGIN_NO_SIGNIN_ALLOW entry in lib/__tests__/e2e-hygiene.test.ts.`
          );
        continue;
      }
      if (why) continue;
      const references = referencedBy.get(name)!;
      violations.push(
        references.length === 0
          ? `${name}: seeded in e2e/logins/ but NO e2e spec references it — ` +
              `delete the login (and its seedMemberLogin call); a dead login is a permanent ` +
              `Settings → Family row (#1392).`
          : `${name}: referenced by ${references.join(", ")} but never signed in as (loginAs/creds/username:). ` +
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

  it("a spec-owned draft sweep belongs to the only spec that signs into its owner login", () => {
    const files = specFiles().filter((f) => f.name.endsWith(".spec.ts"));
    const declarations: Array<{ file: string; login: string }> = [];
    const rawDeclarations: string[] = [];

    for (const file of files) {
      if (!file.text.includes("spec-owned")) continue;
      const code = codeFor(file);
      rawDeclarations.push(
        ...(code.match(/kind:\s*["']spec-owned["']/g) ?? [])
      );
      for (const match of code.matchAll(SPEC_OWNED_DRAFT_SCOPE_RE))
        declarations.push({ file: file.name, login: match[1] });
    }

    expect(declarations.length).toBe(rawDeclarations.length);
    expect(declarations.length).toBeGreaterThan(0);
    for (const declaration of declarations) {
      const signInFiles = files
        .filter(
          (file) =>
            file.text.includes(declaration.login) &&
            [...codeFor(file).matchAll(SIGNIN_WINDOW_RE)].some((window) =>
              new Set<string>(window[0].match(LOGIN_CONST_NAME_RE) ?? []).has(
                declaration.login
              )
            )
        )
        .map((file) => file.name);
      expect(
        signInFiles,
        `${declaration.login} is declared as a spec-owned draft profile by ` +
          `${declaration.file}, but is signed into by ${signInFiles.join(", ") || "no spec"}. ` +
          `A destructive sweep is safe only when that login belongs to this one spec.`
      ).toEqual([declaration.file]);
    }
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

  it("no NEW inline shared-profile activity delete in an e2e/*.spec.ts (use deleteActivitiesTitled)", () => {
    const violations: string[] = [];
    for (const { name, text } of specFiles()) {
      // SPECS ONLY. A seed and a fixture module delete-then-insert to stay idempotent
      // over an existing database, which is their job and not a spec's cleanup —
      // e2e/seed/merge.ts alone does it four times, correctly.
      if (!name.endsWith(".spec.ts")) continue;
      if (!/DELETE\s+FROM\s+activities/i.test(text)) continue;
      const count = countMatches(
        hygieneScanText(text),
        SHARED_ACTIVITY_DELETE_RE
      );
      if (count > 0)
        violations.push(
          `${name}: ${count} inline shared-profile activity delete(s). Seven specs ` +
            `kept this cleanup by hand and the eighth did not, which is how ` +
            `ride-detail's Cycling quick link became a ~50% flake (#3930/#3946). ` +
            `Call deleteActivitiesTitled(...) from e2e/shared-profile-guard.ts — the ` +
            `one definition, profile-scoped, with the cascade turned on.`
        );
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  // A GREEN SWEEP OVER A COMPLYING TREE SAYS NOTHING ABOUT WHAT THE SWEEP CAN SEE.
  // Both halves matter: the spellings it must catch, and the neighbours it must stay
  // quiet on — a rule that fired on a spec-owned fixture delete or a seed's
  // re-seed would be deleted within a week, taking the real rule with it.
  it.each([
    ['db.prepare("DELETE FROM activities WHERE title = ?").run(t);', 1],
    [
      "db.prepare(`DELETE FROM activities WHERE profile_id = 1 AND title = 'X'`);",
      1,
    ],
    [
      "db.prepare(`DELETE FROM activities WHERE profile_id = 1 AND title IN (?, ?)`);",
      1,
    ],
    ["db.prepare(\n  `DELETE FROM activities\n     WHERE title = ?`\n);", 1],
    // Benign neighbours, every one of them shipped in the tree today:
    [
      'db.prepare("DELETE FROM activities WHERE profile_id = ? AND title = ?");',
      0,
    ],
    [
      'db.prepare("DELETE FROM activities WHERE title LIKE ?").run(`${M}%`);',
      0,
    ],
    ['db.prepare("DELETE FROM activities WHERE profile_id = ?").run(id);', 0],
    [
      'db.prepare("DELETE FROM activities WHERE profile_id = 1 AND id > ?");',
      0,
    ],
    ['db.prepare("DELETE FROM activities WHERE id = ?").run(createdId);', 0],
    [
      "db.prepare(\"DELETE FROM activities WHERE profile_id = ? AND external_id = 'e2e:x'\");",
      0,
    ],
    // Prose explaining the rule is not an offender (#3621).
    ["// never write DELETE FROM activities WHERE title = ? inline\n", 0],
  ])(
    "the shared-activity-delete pattern reads %j as %i",
    (source, expected) => {
      expect(
        countMatches(hygieneScanText(source), SHARED_ACTIVITY_DELETE_RE)
      ).toBe(expected);
    }
  );

  it("the blessed shared-profile cleanup exists and is profile-scoped", () => {
    const mod = fs.readFileSync(
      path.join(E2E_DIR, "shared-profile-guard.ts"),
      "utf8"
    );
    expect(mod).toMatch(/export function deleteActivitiesTitled\b/);
    // Profile-scoped and cascading, or it is not a replacement for what it replaced.
    expect(mod).toMatch(
      /DELETE FROM activities WHERE profile_id = \? AND title = \?/
    );
    expect(mod).toMatch(/foreign_keys = ON/);
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

  it("no bare calendar year in an e2e text assertion", () => {
    checkPattern(
      "bare-year text assertion",
      BARE_YEAR_ASSERTION_RE,
      BARE_YEAR_ASSERTION_ALLOW,
      {
        hint:
          `A bare fixed year is not a date contract: relative fixtures eventually ` +
          `leave it, and a negated assertion can then pass vacuously (#4369). Assert ` +
          `the fixture-derived display date, or use a year-shape regex when proving ` +
          `that a row renders no date; see docs/internals/e2e-hygiene.md.`,
      }
    );
  });

  it("no offline NAVIGATION in an e2e/*.ts without a cache-warm precondition (use readyForOffline)", () => {
    const violations: string[] = [];
    for (const { name, text } of specFiles()) {
      if (name === OFFLINE_HELPERS_FILE) continue;
      const lines = text.split("\n");
      // Strip line comments and block-comment continuations before looking for the
      // window's boundaries and its navigation: this rule's own explanatory prose
      // SPELLS OUT `setOffline(true)` and `page.goto`, and the CI-branch rule above
      // learned the same lesson — read code, not the note beside it. The markers are
      // matched against the RAW lines, since a marker lives in a comment by design.
      const code = lines.map((l) =>
        l.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "")
      );
      code.forEach((line, i) => {
        if (!SET_OFFLINE_TRUE_RE.test(line)) return;
        // The offline WINDOW: from here to the matching setOffline(false), or to the
        // end of the file when the spec never comes back online.
        let end = lines.length;
        for (let j = i + 1; j < code.length; j += 1) {
          if (SET_OFFLINE_FALSE_RE.test(code[j])) {
            end = j;
            break;
          }
        }
        if (!code.slice(i, end).some((l) => OFFLINE_NAVIGATION_RE.test(l))) {
          return;
        }
        if (
          lines.slice(i, end).some((l) => l.includes(OFFLINE_NAV_OK_MARKER))
        ) {
          return;
        }
        // The precondition is asserted BEFORE the network goes away, so it may sit
        // anywhere above this line — including inside a helper this file defines.
        if (code.slice(0, i).some((l) => OFFLINE_READY_RE.test(l))) return;
        violations.push(
          `${name}:${i + 1}: navigates while offline with no cache-warm ` +
            `precondition. Playwright's offline emulation is per-browser-context and ` +
            `does not cover SERVICE-WORKER fetches, so cacheFirst (public/sw.js) can ` +
            `pull the shell's chunks over the network DURING this navigation and the ` +
            `assertion passes on assets a real device would not have (#3002). Do NOT ` +
            `delete the block — call \`readyForOffline(page)\` from e2e/helpers.ts ` +
            `before setOffline(true), which asserts a live controlling worker and the ` +
            `/offline document's own chunks already cached. If this block asserts ` +
            `something the bypass cannot fake and needs no shell, add an ` +
            `\`offline-nav-ok: <why>\` comment inside the offline window; see ` +
            `docs/internals/e2e-hygiene.md.`
        );
      });
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("the offline-navigation rule sees a navigation and ignores a queue-only block", () => {
    const navigates = [
      "await context.setOffline(true);",
      "await page.goto('/profile');",
      "await context.setOffline(false);",
    ];
    const queueOnly = [
      "await context.setOffline(true);",
      "await page.getByTestId('log-x').click();",
      "await context.setOffline(false);",
    ];
    const inWindow = (lines: string[]) => {
      const start = lines.findIndex((l) => SET_OFFLINE_TRUE_RE.test(l));
      const rest = lines.slice(start + 1);
      const stop = rest.findIndex((l) => SET_OFFLINE_FALSE_RE.test(l));
      return rest
        .slice(0, stop === -1 ? rest.length : stop)
        .some((l) => OFFLINE_NAVIGATION_RE.test(l));
    };
    expect(inWindow(navigates)).toBe(true);
    expect(inWindow(queueOnly)).toBe(false);
  });

  it("the blessed offline precondition exists and asserts the cache, not a render", () => {
    const helpers = fs.readFileSync(path.join(E2E_DIR, "helpers.ts"), "utf8");
    expect(helpers).toContain("export async function offlineChunksWarm");
    expect(helpers).toContain("export async function readyForOffline");
    // It reads the cache — a render assertion is exactly what cannot see the bypass.
    expect(helpers).toContain("caches.match(");
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

  it("no NEW unscoped page.getByTestId in an e2e/*.ts (scope it, or mark testid-scope-ok)", () => {
    checkPattern(
      "unscoped page.getByTestId(",
      (scanned, file) => countUnscopedTestIds(scanned, codeFor(file)),
      BARE_TESTID_ALLOW,
      {
        corpus: allE2eFiles(),
        excludeLineMarker: BARE_TESTID_OK_MARKER,
        allowFile: BARE_TESTID_ALLOW_FILE,
        hint:
          `A global getByTestId matches the STAGED copy too while a streamed Suspense ` +
          `boundary is relocating (#4890) — scope it: appContent(page).getByTestId(...), ` +
          `a row/card/dialog you already hold, or page.getByTestId("${TESTID_SCOPE_ROOTS[0]}"). ` +
          `A marker that provably cannot sit inside a streamed boundary takes a same-line ` +
          `\`testid-scope-ok: <why>\` comment; see docs/internals/e2e-hygiene.md.`,
      }
    );
  });

  it("the blessed testid scope roots are real markers that sit above the boundary", () => {
    const shell = fs.readFileSync(
      path.join(REPO, "app/(app)/layout.tsx"),
      "utf8"
    );
    // The universal root wraps {children} in the (app) shell, so it is one per
    // document and above every page's own boundary.
    expect(shell).toContain('data-testid="app-content-container"');
    const training = fs.readFileSync(
      path.join(REPO, "app/(app)/training/page.tsx"),
      "utf8"
    );
    expect(training).toContain('testId="training-page"');
    // A root inside a streamed section would bless the duplicate rather than
    // exclude it: the hub header renders ABOVE the <Suspense>, not under it.
    expect(training.indexOf('testId="training-page"')).toBeLessThan(
      training.indexOf("<Suspense")
    );
    const helpers = fs.readFileSync(path.join(E2E_DIR, "helpers.ts"), "utf8");
    expect(helpers).toMatch(/export function appContent\b/);
    expect(helpers).toContain('page.getByTestId("app-content-container")');
  });

  it("every Suspense boundary in the app tree is registered, and no loading.tsx is back", () => {
    const found: string[] = [];
    const streamed: string[] = [];
    const loaders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        const rel = path.relative(REPO, full).split(path.sep).join("/");
        if (entry.name === "loading.tsx") loaders.push(rel);
        if (!entry.name.endsWith(".tsx")) continue;
        const code = cachedStripComments(fs.readFileSync(full, "utf8"));
        if (/<Suspense\b/.test(code)) found.push(rel);
        if (/<StreamedSection\b/.test(code)) streamed.push(rel);
      }
    };
    walk(path.join(REPO, "app"));
    walk(path.join(REPO, "components"));
    expect(
      loaders,
      `A route-segment loading.tsx opts its page into streamed rendering, which is ` +
        `the #530 / #4890 staged-duplicate race. app/(app)/layout.tsx refuses it in ` +
        `prose; this is the tooling half.`
    ).toEqual([]);
    expect(
      streamed.sort(),
      `StreamedSection is what actually stages a <div hidden> copy. A NEW call site ` +
        `means a new page where every unscoped page.getByTestId can resolve to 2 ` +
        `elements — re-read the specs that assert against that route, then add it to ` +
        `STREAMED_SECTION_FILES.`
    ).toEqual([...STREAMED_SECTION_FILES].sort());
    expect(
      found.sort(),
      `A new <Suspense> in app/ or components/ is a new candidate streaming ` +
        `surface (#4890). ` +
        `Say whether it stages server content, then add it to SUSPENSE_BOUNDARY_FILES.`
    ).toEqual([...SUSPENSE_BOUNDARY_FILES].sort());
  });

  it("the family helper module exists and exports the three create/grant drivers", () => {
    const fam = fs.readFileSync(path.join(E2E_DIR, FAMILY_HELPERS), "utf8");
    expect(fam).toMatch(/export async function createLoginViaFamily\b/);
    expect(fam).toMatch(/export async function createProfileViaFamily\b/);
    expect(fam).toMatch(/export async function setGrantsViaFamily\b/);
  });
});
