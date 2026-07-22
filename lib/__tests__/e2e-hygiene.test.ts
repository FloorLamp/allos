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
  "activity-equipment.spec.ts": 5,
  "ai-settings.spec.ts": 4,
  "allergen-cross-reactivity.spec.ts": 1,
  "audit-log.spec.ts": 2,
  "care-plan-appointment-offer.spec.ts": 1,
  "condition-suggestion.spec.ts": 1,
  "contrast-safety.spec.ts": 1,
  "crisis-mental-health-visit.spec.ts": 4,
  "cycle.spec.ts": 2,
  "dashboard.spec.ts": 5,
  "date-time-format-prefs.spec.ts": 10,
  "dental.spec.ts": 2,
  "dose-history.spec.ts": 9,
  "drug-allergy.spec.ts": 3,
  "drug-interactions.spec.ts": 4,
  "edit-lock-badge.spec.ts": 2,
  "emergency-card.spec.ts": 3,
  "encounters.spec.ts": 2,
  "endurance-plans.spec.ts": 2,
  "entry-ergonomics.spec.ts": 24,
  "episode-med-reconcile.spec.ts": 2,
  "equipment-manager.spec.ts": 1,
  "equipment-registry.spec.ts": 1,
  "exercise-guide.spec.ts": 4,
  "food-slot-ranking.spec.ts": 4,
  "form-fill-paths.spec.ts": 2,
  "goal-metric-switch.spec.ts": 2,
  "hearing.spec.ts": 2,
  "home-location.spec.ts": 3,
  "household-history.spec.ts": 4,
  "illness-care.spec.ts": 1,
  "illness-episode-followups.spec.ts": 27,
  "illness-episode.spec.ts": 5,
  "illness-front-door.spec.ts": 1,
  "illness-round3.spec.ts": 6,
  "immunizations.spec.ts": 2,
  "import-dedup.spec.ts": 3,
  "import-records-browser.spec.ts": 1,
  "imported-temp-unit.spec.ts": 1,
  "integrations-health-connect.spec.ts": 3,
  "journal-provenance.spec.ts": 7,
  "kids-growth.spec.ts": 2,
  "live-workout.spec.ts": 1,
  "longevity.spec.ts": 1,
  "manual-temperature.spec.ts": 2,
  "maps-links.spec.ts": 1,
  "medication-monitoring.spec.ts": 1,
  "medication-prefill.spec.ts": 8,
  "medications-followups.spec.ts": 6,
  // dose-history-row .first() (newest seeded dose) deferred to a dedicated-fixture
  // pass — its safety rests on every OTHER spec only backdating writes to this
  // SHARED med, which is too fragile to bless with a marker.
  "medications-page.spec.ts": 1,
  "medications-ux-r2.spec.ts": 4,
  "mobile-ui-polish.spec.ts": 8,
  "mobility.spec.ts": 2,
  "muscle-anatomy.spec.ts": 4,
  "muscle-coverage.spec.ts": 2,
  "muscle-volume-bands.spec.ts": 1,
  "needs-attention-menu.spec.ts": 2,
  "offsite-backup.spec.ts": 1,
  "onboarding.spec.ts": 2,
  "pace-tone.spec.ts": 1,
  "palette-actions.spec.ts": 3,
  "pgx-crosscheck.spec.ts": 1,
  "preventive-nudge.spec.ts": 2,
  "prn-family.spec.ts": 1,
  "records-page.spec.ts": 1,
  "results-page.spec.ts": 2,
  "review-inbox.spec.ts": 3,
  "risk-factors.spec.ts": 2,
  "routine-builder.spec.ts": 1,
  "routine-deload.spec.ts": 1,
  "routine-recommendation.spec.ts": 2,
  "rpe-logging.spec.ts": 1,
  "session-recap.spec.ts": 6,
  "settings-ia.spec.ts": 1,
  "share-link.spec.ts": 1,
  "situations.spec.ts": 1,
  "skin.spec.ts": 4,
  "smoke.spec.ts": 7,
  "smoking-history.spec.ts": 4,
  "strength-standards.spec.ts": 3,
  "supplement-add-reset.spec.ts": 1,
  "symptom-helpers.ts": 2,
  "symptom-log.spec.ts": 6,
  "symptom-text-intake.spec.ts": 1,
  "temperature-unit.spec.ts": 3,
  "timeline-linked-context.spec.ts": 1,
  "training-restriction.spec.ts": 1,
  "training-zones.spec.ts": 1,
  "trends-per-tab.spec.ts": 1,
  "two-factor.spec.ts": 2,
  "unit-mislabel-review.spec.ts": 1,
  "view-only-access.spec.ts": 1,
  "vision.spec.ts": 3,
  "visits-lifecycle.spec.ts": 3,
  "weekly-recap.spec.ts": 2,
  "weight-quick-add.spec.ts": 1,
  "workout-heatmap.spec.ts": 1,
  "workout-presence.spec.ts": 1,
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
  "audit-log.spec.ts": 1,
  "entry-ergonomics.spec.ts": 1,
  "episode-med-reconcile.spec.ts": 1,
  "household-rollup.spec.ts": 1,
  "illness-episode.spec.ts": 2,
  "illness-front-door.spec.ts": 1,
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
  "rpe-logging.spec.ts": 2,
  "settings-ia.spec.ts": 1,
  "symptom-helpers.ts": 7,
  "symptom-log.spec.ts": 1,
  "two-factor.spec.ts": 3,
  "unit-mislabel-review.spec.ts": 2,
  "view-only-access.spec.ts": 1,
  "wake-aware-mornings.spec.ts": 2,
  "weight-quick-add.spec.ts": 1,
  "wellbeing-check.spec.ts": 3,
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
  }
) {
  const files = specFiles();
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

  it("the blessed interaction module exists and exports settledClick + followLink", () => {
    const helpers = fs.readFileSync(path.join(E2E_DIR, "helpers.ts"), "utf8");
    expect(helpers).toMatch(/export async function settledClick\b/);
    expect(helpers).toMatch(/export async function followLink\b/);
  });
});
