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
//        too short (flakes under CI contention) or too long (slows the suite).
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

const WAITFORTIMEOUT_ALLOW: Record<string, number> = {
  // IRREDUCIBLE bounded absence-of-effect proofs — the ONE sanctioned waitForTimeout
  // (docs/internals/e2e-hygiene.md, "Bounded absence-of-effect wait"). Each probes a
  // KNOWN product time window and asserts that within it NOTHING happened; there is
  // no positive event to await instead, because the thing being proven is the
  // NON-occurrence of a timer-driven effect.
  //   • journal-provenance (2): opening an imported/manual activity row must NOT
  //     auto-fill calories, dirty the form, and trip the 700ms autosave/edit-lock.
  //     The wait lets a REGRESSED build's autosave fire before we assert not-"edited";
  //     close too early and a real bug passes green. No awaitable event substitutes
  //     for "the 700ms debounce elapsed with no POST."
  //   • profile-switch-toasts (3): after a profile switch, the ExtractionToaster/
  //     ImportJobsToaster must NOT replay the new profile's terminal history as ghost
  //     toasts. The wait spans the toasters' 6s idle poll cadence (+margin) so a
  //     regressed build WOULD have toasted. The poll is a Server Action POST (posts to
  //     the current route, indistinguishable from any other POST), so a waitForResponse
  //     gate can't reliably pick out "the toaster polled" — matching a generic POST
  //     would reintroduce the very race the wait rules out. Frozen at the poll cadence.
  "journal-provenance.spec.ts": 2,
  "profile-switch-toasts.spec.ts": 3,
};

// Frozen .first() offenders (per-file counts, `first-ok`-marked lines excluded)
// as of the flaky-e2e hardening pass. Same immutable-downward discipline as the
// two lists above: migrate a spec onto an exact locator / dedicated fixture and
// LOWER its number in the same PR; a NEW unmarked .first() (or a new file) fails.
const FIRST_ALLOW: Record<string, number> = {
  // edit-lock-badge carries a latent class-1 flake (a batch sibling mutates
  // profile 1's body metrics that /trends?tab=body reads; exposed only when
  // co-located at --repeat-each). Its two .first() stay frozen until a focused fix.
  "edit-lock-badge.spec.ts": 2,
  // illness-care carries a latent class-1 flake (a sibling mutates profile 1's
  // seeded illness state; exposed only when co-located at --repeat-each). Its lone
  // .first() stays frozen here until that flake is fixed in a focused follow-up.
  "illness-care.spec.ts": 1,
  // import-dedup merges (consumes) its seeded dup pair on the first run and never
  // recreates it, so a --repeat-each iteration finds the badge already at 2 (not 3).
  // Its 3 .first() stay frozen until the spec resets its dup-pair fixture per test.
  "import-dedup.spec.ts": 3,
  // dose-history-row .first() (newest seeded dose) deferred to a dedicated-fixture
  // pass — its safety rests on every OTHER spec only backdating writes to this
  // SHARED med, which is too fragile to bless with a marker.
  "medications-page.spec.ts": 1,
  // two-factor / view-only-access each shed one grant-checkbox .first() when their
  // create+grant dance moved into e2e/family-helpers.ts (which scopes the checkbox by
  // the grant-cell testid, no .first()); two-factor keeps its recovery-code li .first().
};

// Frozen .toPass( offenders (per-file counts, `topass-ok`-marked lines excluded)
// as of the post-burn-down hardening pass (#1160 follow-up). Same
// immutable-downward discipline: replace a retry loop with a settled interaction
// (settledClick/followLink/a plain retrying expect on ONE locator) and LOWER its
// number in the same PR; a NEW unmarked .toPass( (or a new file) fails. The
// symptom-helpers.ts entries are the drivers' internal tap-retry loops — already
// paired with settledTap arming the right wait; migrating them means a driver
// redesign, so they're grandfathered like any other offender, not blessed.
const TOPASS_ALLOW: Record<string, number> = {
  "entry-ergonomics.spec.ts": 1,
  // episode-med-reconcile / illness-front-door / view-only-access dropped their
  // remaining .toPass( when their family-create/switch dances moved into
  // e2e/family-helpers.ts (phase-2 create-member hardening), so they're off the list.
  "illness-episode.spec.ts": 2,
  "illness-hero.spec.ts": 1,
  "illness-round3.spec.ts": 1,
  "kids-growth.spec.ts": 1,
  "medications-page.spec.ts": 2,
  "medications-ux-r2.spec.ts": 1,
  "mobility.spec.ts": 1,
  "nav-consolidation.spec.ts": 1,
  "nav.ts": 1,
  "nutrition-trio.spec.ts": 1,
  "review-inbox.spec.ts": 1,
  "rpe-logging.spec.ts": 1,
  "settings-ia.spec.ts": 1,
  "symptom-helpers.ts": 7,
  "symptom-log.spec.ts": 1,
  // two-factor kept its two TOTP retry loops; its create-login loop moved to the helper.
  "two-factor.spec.ts": 2,
  "unit-mislabel-review.spec.ts": 2,
  "wake-aware-mornings.spec.ts": 2,
  "weight-quick-add.spec.ts": 1,
  // wellbeing-check kept its tapMood retry; its switch/create dances moved to the helper.
  "wellbeing-check.spec.ts": 1,
};

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

  it("no NEW waitForTimeout(...) in an e2e/*.ts (use e2e/helpers.ts or a real expect)", () => {
    checkPattern(
      "waitForTimeout(...)",
      WAITFORTIMEOUT_RE,
      WAITFORTIMEOUT_ALLOW
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
