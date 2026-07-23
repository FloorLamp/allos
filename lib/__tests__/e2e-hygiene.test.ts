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
//        sequences. Those controls are onClick+router.refresh() handlers (NOT form
//        submits), so an inline goto→fill→click flakes on the hydration swallow /
//        toaster false-settle (#830/#1111) — nine near-identical copies had grown
//        across the dynamic specs. They now live in the ONE blessed home
//        e2e/family-helpers.ts (createLoginViaFamily / createProfileViaFamily /
//        setGrantsViaFamily); the three inline markers (`getByPlaceholder("Username")`,
//        `"Add a profile"`, `"Save access"`) are frozen at ZERO in every OTHER file,
//        so a NEW inline sequence fails. The helper module is SKIPPED (not
//        allowlisted) for these three — it OWNS the markers by design.
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
// Settings → Family create/grant controls are onClick+router.refresh() handlers, NOT
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
// journal-provenance 700ms-autosave-must-not-fire probes and the profile-switch-toasts
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

function specFiles(): { name: string; text: string }[] {
  return fs
    .readdirSync(E2E_DIR)
    .filter((f) => f.endsWith(".ts") && !SCAN_EXCLUDE.has(f))
    .map((name) => ({
      name,
      text: fs.readFileSync(path.join(E2E_DIR, name), "utf8"),
    }));
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
