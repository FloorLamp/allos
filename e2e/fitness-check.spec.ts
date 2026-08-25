import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import {
  expectNoClippedContent,
  expectPhoneTapTargets,
  settledClick,
} from "./helpers";
import {
  E2E_LOGIN_FITNESS,
  E2E_LOGIN_FITNESS_SENIOR,
  FITNESS_PROFILE,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

const DB_PATH = workerDbPath();

function withDb<T>(fn: (db: InstanceType<typeof Database>) => T): T {
  const db = new Database(DB_PATH);
  try {
    db.pragma("busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

function fitnessProfileId(db: InstanceType<typeof Database>): number {
  const row = db
    .prepare("SELECT id FROM profiles WHERE name = ?")
    .get(FITNESS_PROFILE) as { id: number } | undefined;
  if (!row) throw new Error(`no seeded profile "${FITNESS_PROFILE}"`);
  return row.id;
}

// Reset the FITNESS profile to its "retest is overdue" baseline (#1305): drop every
// RECENT fitness-check session (keeping the seeded ~100-day-old grip check), so the next
// recorded test flips the battery-level retest finding and the closure toast fires
// deterministically under --repeat-each. BLAST RADIUS: only this spec-owned profile's
// recent fitness_assessments (+ their entries). The seeded old check (the delta anchor)
// and the natural-store readings are untouched.
function resetRecentChecks(): void {
  withDb((db) => {
    const pid = fitnessProfileId(db);
    db.prepare(
      `DELETE FROM fitness_assessment_entries
        WHERE assessment_id IN (
          SELECT id FROM fitness_assessments
           WHERE profile_id = ? AND date >= date('now','-30 days'))`
    ).run(pid);
    db.prepare(
      `DELETE FROM fitness_assessments
        WHERE profile_id = ? AND date >= date('now','-30 days')`
    ).run(pid);
  });
}

// Every adult-battery test key (kept literal — specs don't share the app's module graph).
const ADULT_BATTERY = [
  "vo2max",
  "hrr",
  "grip",
  "pushups",
  "chairstand",
  "biglift",
  "balance",
  "sitreach",
  "srt",
  "deadhang",
  "plank",
  "bodyfat",
  "restinghr",
] as const;

// The store kind + tier per test, mirroring lib/fitness-battery (literal here). Only the
// shape the coverage ledger needs — enough to seed a measured entry.
const TEST_META: Record<string, { tier: string; store: string; unit: string }> =
  {
    vo2max: { tier: "norms", store: "vital", unit: "mL/kg/min" },
    hrr: { tier: "evidence", store: "vital", unit: "bpm" },
    grip: { tier: "norms", store: "vital", unit: "kg" },
    pushups: { tier: "norms", store: "set", unit: "reps" },
    chairstand: { tier: "norms", store: "vital", unit: "reps" },
    biglift: { tier: "standard", store: "set", unit: "kg" },
    balance: { tier: "norms", store: "vital", unit: "seconds" },
    sitreach: { tier: "norms", store: "vital", unit: "cm" },
    srt: { tier: "evidence", store: "vital", unit: "score" },
    deadhang: { tier: "self-norm", store: "set", unit: "seconds" },
    plank: { tier: "self-norm", store: "set", unit: "seconds" },
    bodyfat: { tier: "body", store: "body", unit: "%" },
    restinghr: { tier: "body", store: "body", unit: "bpm" },
  };

// Seed the FITNESS battery to "all fresh EXCEPT `exceptKey`" (#1307): a today coverage-
// ledger session with an entry for every test but one, so recording that last test in the
// browser FLIPS the battery to complete and the finale summary renders. Spec-owned + reset
// each run (drops recent sessions first). The entry snapshot alone marks a test measured;
// the completion decision only needs a fresh value per test.
function seedNearComplete(exceptKey: string): void {
  resetRecentChecks();
  withDb((db) => {
    const pid = fitnessProfileId(db);
    // Clear the exceptKey's AMBIENT natural-store reading too, so it stays genuinely
    // outstanding across repeats — a prior repeat's recording of it (e.g. a "Push Up"
    // set) would otherwise auto-count it and the battery would already be complete.
    if (exceptKey === "pushups") {
      db.prepare(
        `DELETE FROM exercise_sets WHERE exercise = 'Push Up'
           AND activity_id IN (SELECT id FROM activities WHERE profile_id = ?)`
      ).run(pid);
    }
    const assessmentId = Number(
      db
        .prepare(
          "INSERT INTO fitness_assessments (profile_id, date) VALUES (?, date('now'))"
        )
        .run(pid).lastInsertRowid
    );
    const ins = db.prepare(
      `INSERT INTO fitness_assessment_entries
         (assessment_id, test_key, tier, store, value, unit, raw_input)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`
    );
    for (const key of ADULT_BATTERY) {
      if (key === exceptKey) continue;
      const m = TEST_META[key];
      ins.run(assessmentId, key, m.tier, m.store, 40, m.unit);
    }
  });
}

// Guided Fitness check — the #1132 heat-grid redesign over the #1129 auto-count data + the
// #1135 rough hold band. Drives dedicated fixture profiles (isolated member logins) so
// recording tests never perturbs a shared-seed profile under --repeat-each. The FITNESS
// profile carries a PRIOR grip check (so a re-record shows a delta) AND seeded natural-store
// readings the check never recorded (a synced VO2, a scale body-fat/RHR, a logged squat +
// plank) so the grid lights up auto-counted tiles. The SENIOR profile (age 72) renders the
// older-adult variant.
// The board's desktop column count (`lg:grid-cols-4` on the grid in
// FitnessCheckView). Named so the "enough tiles to have a fourth column"
// precondition below says what it is checking rather than carrying a bare 4.
const GRID_COLUMNS_DESKTOP = 4;

// The narrowest a tile may be at the 1280px project viewport, in CSS px. This is
// a FLOOR on the page's width policy, not a pin on a tile. Both sides were
// measured with the probe below at the 1280px project viewport: the nested
// containers put the 4-col board inside a 768px `reading` measure and produced
// 183px tiles, with 11 of the 13 titles overlapping their chip; one container
// produces 241px and zero overlaps. 210 sits between the two with ~27px of room
// on each side, so a padding or gap revision does not fail it and a re-nested
// container cannot pass it.
const DESKTOP_TILE_FLOOR = 210;

test.describe("Fitness check grid (#1129/#1132/#1135)", () => {
  test("renders the heat grid, auto-counts synced/logged values, records a test, shows a delta", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_FITNESS,
      password: E2E_MEMBER_PASSWORD,
    });
    test.slow(); // local next dev compiles the training route on first hit

    await page.goto("/training/fitness-check");

    const surface = page.getByTestId("fitness-check");
    await expect(surface).toBeVisible();
    await expect(page.getByTestId("fitness-completion")).toBeVisible();

    // The grid renders one square per battery test.
    const grid = page.getByTestId("fitness-grid");
    await expect(grid).toBeVisible();
    await expect(page.getByTestId("fitness-tile-grip")).toBeVisible();
    await expect(page.getByTestId("fitness-tile-vo2max")).toBeVisible();
    await expect(page.getByTestId("fitness-tile-plank")).toBeVisible();

    // #1129: the seeded SYNCED VO2 auto-counts — its tile is colored (not the grey
    // "neutral" unmeasured tone) and shows a "from Oura" provenance chip.
    const vo2Tile = page.getByTestId("fitness-tile-vo2max");
    await expect(vo2Tile).not.toHaveAttribute("data-tone", "neutral");
    await expect(page.getByTestId("fitness-provenance-vo2max")).toContainText(
      "Oura"
    );

    // #1135: the seeded logged Plank auto-counts onto the rough band ladder — its tile
    // shows the "rough guide" disclosure tag (not a percentile).
    await expect(page.getByTestId("fitness-rough-plank")).toContainText(
      "rough guide"
    );

    // #1253: every tile leads with its decorative pictogram — aria-hidden, with the
    // text label/overlay still present (never icon-only), and the domain chip/bars
    // carry their glyphs (scoped lookups: the glyph testid repeats across tiles).
    const gripTileEl = page.getByTestId("fitness-tile-grip");
    const gripPicto = gripTileEl.getByTestId("fitness-pictogram-grip");
    await expect(gripPicto).toBeVisible();
    await expect(gripPicto).toHaveAttribute("aria-hidden", "true");
    await expect(gripPicto).toHaveAttribute("data-pictogram", "grip");
    await expect(gripTileEl).toContainText("Grip strength");
    await expect(
      gripTileEl.getByTestId("fitness-domain-glyph-strength")
    ).toBeVisible();
    await expect(
      page
        .getByTestId("fitness-domain-strength")
        .getByTestId("fitness-domain-glyph-strength")
    ).toBeVisible();

    // Tap the grip tile → the entry modal opens → record a NEW grip value (prior seeded
    // check was 44) → the in-place OUTCOME moment (#1307) renders before the modal closes,
    // then the tile updates and shows a +6 improvement delta.
    await page.getByTestId("fitness-tile-grip").click();
    const gripModal = page.getByTestId("fitness-entry-grip");
    await expect(gripModal).toBeVisible();
    // The modal header reuses the same figure — one keyed lookup, no second mapping.
    await expect(gripModal.getByTestId("fitness-pictogram-grip")).toBeVisible();
    await gripModal.getByTestId("fitness-value-grip").fill("50");
    await settledClick(page, gripModal.getByTestId("fitness-submit-grip"));

    // #1307: the outcome panel appears IN the modal (percentile + delta) before it closes.
    await expect(page.getByTestId("fitness-outcome-grip")).toBeVisible();
    await expect(page.getByTestId("fitness-outcome-marker-grip")).toContainText(
      "percentile"
    );
    await expect(page.getByTestId("fitness-outcome-delta-grip")).toContainText(
      "+6"
    );

    // Done closes the modal and refreshes the board.
    await page.getByTestId("fitness-outcome-done-grip").click();
    await expect(gripModal).toBeHidden();
    const gripTile = page.getByTestId("fitness-tile-grip");
    await expect(gripTile).toContainText("50");
    await expect(page.getByTestId("fitness-delta-grip")).toContainText("+6");
    // Percentiles resolve (the profile has sex + birthdate).
    await expect(gripTile).toContainText("percentile");
    // #1307: the just-saved tile carries the landing-sweep marker (motion allowed here).
    await expect(gripTile).toHaveAttribute("data-landing", "true");

    await page.close();
  });

  test("the rough-guide disclosure and provenance render in the entry modal", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_FITNESS,
      password: E2E_MEMBER_PASSWORD,
    });
    test.slow();

    await page.goto("/training/fitness-check");
    await expect(page.getByTestId("fitness-check")).toBeVisible();

    // Open the plank tile → its modal discloses "rough guide only — no validated norms".
    await page.getByTestId("fitness-tile-plank").click();
    const modal = page.getByTestId("fitness-entry-plank");
    await expect(modal).toBeVisible();
    await expect(page.getByTestId("fitness-rough-note-plank")).toContainText(
      /rough guide only/i
    );

    await page.close();
  });

  test("the grid is single-scroll on mobile with no horizontal overflow (#1063)", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_FITNESS,
      password: E2E_MEMBER_PASSWORD,
    });
    test.slow();
    await page.setViewportSize({ width: 390, height: 844 });

    await page.goto("/training/fitness-check");
    await expect(page.getByTestId("fitness-grid")).toBeVisible();
    // No horizontal overflow, measured per element (#1543): the app shell clips
    // the overflow away, so comparing the document's width to the viewport's is
    // true no matter how far a tile spills past the edge.
    await expectNoClippedContent(page);

    await page.close();
  });

  // #3234 — the page's width, measured rather than asserted as a class.
  //
  // The route move (#2894) left TWO width containers on this page: the route's own
  // `PageContainer width="reading"` (max-w-3xl) with the view's `width="full"`
  // nested inside it, which the inner one cannot undo. A `lg:grid-cols-4` board
  // inside a 768px measure is a ~170px tile, and at that width the title span ran
  // straight under the `shrink-0` domain chip beside it — "VO2" printed through
  // ENDURANCE in about eight of the thirteen tiles.
  //
  // A CLASS ASSERTION CANNOT SEE THIS. Every class in that tree was the intended
  // one; what was wrong was two of them being applied at once, one file apart. So
  // this reads boxes — the title's and the chip's — in ONE browser-side layout
  // pass, at both widths the 2026-08-19 census shot.
  async function tileHeaderGeometry(page: Page) {
    return page.evaluate(() => {
      // `button[...]`, not a bare prefix match: the tile's own header spans are
      // `fitness-tile-title` / `fitness-tile-domain`, which share the prefix. The
      // tile is the only BUTTON in that namespace.
      const tiles = Array.from(
        document.querySelectorAll('button[data-testid^="fitness-tile-"]')
      );
      const collisions: string[] = [];
      let narrowest = Infinity;
      for (const tile of tiles) {
        const title = tile.querySelector('[data-testid="fitness-tile-title"]');
        const chip = tile.querySelector('[data-testid="fitness-tile-domain"]');
        if (!title || !chip) continue;
        const t = title.getBoundingClientRect();
        const c = chip.getBoundingClientRect();
        narrowest = Math.min(narrowest, tile.getBoundingClientRect().width);
        // An INTERSECTION is overlap on BOTH axes. Comparing only the x edges
        // would call a title that wraps below the chip a collision, and comparing
        // only y would call every same-row pair one.
        const overlapX = Math.min(t.right, c.right) - Math.max(t.left, c.left);
        const overlapY = Math.min(t.bottom, c.bottom) - Math.max(t.top, c.top);
        if (overlapX > 0 && overlapY > 0) {
          collisions.push(
            `${tile.getAttribute("data-testid")}: "${(title.textContent ?? "").trim()}" ` +
              `[${Math.round(t.left)}–${Math.round(t.right)}] overlaps its chip ` +
              `[${Math.round(c.left)}–${Math.round(c.right)}] by ` +
              `${Math.round(overlapX)}×${Math.round(overlapY)}px`
          );
        }
      }
      return { collisions, narrowest, tiles: tiles.length };
    });
  }

  test("one container owns the page width, so no tile title paints through its chip (#3234)", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_FITNESS,
      password: E2E_MEMBER_PASSWORD,
    });
    test.slow();

    await page.goto("/training/fitness-check");
    // Wait for the CONTENT the measurement is about, not the container: a grid
    // with no tiles in it fits any width and would pass for the wrong reason
    // (#3384).
    const grid = page.getByTestId("fitness-grid");
    await expect(grid).toBeVisible();
    const titles = page.getByTestId("fitness-tile-title");
    const tileCount = await titles.count();
    // The battery's length is not this spec's business; that a 4-column board has
    // enough tiles to HAVE a fourth column is.
    expect(tileCount).toBeGreaterThan(GRID_COLUMNS_DESKTOP);
    await expect(titles.nth(tileCount - 1)).toBeVisible();

    // The page's one h1, from the shared PageHeader — the route used to render no
    // page heading at all, only a back link, with "Fitness check" living as an h2
    // inside a card (#1449: a page's identity does not sit inside a content
    // container).
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toHaveCount(1);
    await expect(h1).toHaveText("Fitness check");

    const desktop = await tileHeaderGeometry(page);
    expect(desktop.tiles).toBe(tileCount);
    expect(desktop.collisions, desktop.collisions.join("\n")).toEqual([]);
    // The width the un-nesting bought — see DESKTOP_TILE_FLOOR for both measured
    // sides. This asks "is this the 4-col board or the squeezed one", and does not
    // pin a pixel.
    expect(desktop.narrowest).toBeGreaterThan(DESKTOP_TILE_FLOOR);

    // …and the phone, the census's other width. Two columns here, and the chip
    // drops its text to a glyph below `sm`, so this is the case the tile header's
    // own comment was written for — it must stay true.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(titles.nth(tileCount - 1)).toBeVisible();
    const phone = await tileHeaderGeometry(page);
    expect(phone.collisions, phone.collisions.join("\n")).toEqual([]);

    await page.close();
  });

  // #1275: the large-format timer. A count-UP test (plank) times a hold and Finish fills
  // the seconds input; a fixed-window countdown test (chair stand) reaches its result input.
  // The timer runs on real Date.now/rAF — no waitForTimeout (#868): the count-up wait is a
  // retrying expect on the readout advancing past 0:00, and the countdown reaches its result
  // via Finish-early (deterministic, no 30s wall wait). The FITNESS profile is a dedicated
  // isolated fixture, so recording a small plank/chair-stand value under --repeat-each is
  // last-write-wins and never exact-count-asserted.
  test("count-up timer times a hold and Finish fills the seconds input", async ({
    browser,
  }) => {
    const page = await loginAs(
      browser,
      {
        username: E2E_LOGIN_FITNESS,
        password: E2E_MEMBER_PASSWORD,
      },
      {
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      }
    );
    test.slow();

    await page.goto("/training/fitness-check");
    await expect(page.getByTestId("fitness-check")).toBeVisible();

    // Open the plank tile → its modal carries the large-timer launcher.
    await page.getByTestId("fitness-tile-plank").click();
    const modal = page.getByTestId("fitness-entry-plank");
    await expect(modal).toBeVisible();

    // Launch the takeover, start the count-up clock.
    await page.getByTestId("fitness-timer-plank-launch").click();
    await expect(page.getByTestId("fitness-timer-plank-panel")).toBeVisible();
    const collapse = page.getByTestId("fitness-timer-plank-collapse");
    await expect(collapse).toHaveAttribute("data-icon-button", "");
    await expectPhoneTapTargets(page, "fitness timer collapse", [collapse]);
    await page.getByTestId("fitness-timer-plank-start").click();

    // Real wait via a retrying expect: the readout advances past 0:00 (≥ 1 whole second
    // elapsed), so Finish stamps a non-zero value. No waitForTimeout.
    await expect(
      page.getByTestId("fitness-timer-plank-readout")
    ).not.toHaveText("0:00");

    // Finish → the takeover collapses and the seconds input is filled.
    await page.getByTestId("fitness-timer-plank-finish").click();
    await expect(page.getByTestId("fitness-timer-plank-panel")).toBeHidden();
    const valueInput = page.getByTestId("fitness-value-plank");
    await expect(valueInput).not.toHaveValue("");
    const filled = await valueInput.inputValue();
    expect(Number(filled)).toBeGreaterThanOrEqual(1);

    // Explicit submit (#794) records it through the same path manual entry uses; the
    // in-place outcome moment (#1307) shows before Done closes the modal.
    await settledClick(page, modal.getByTestId("fitness-submit-plank"));
    await expect(page.getByTestId("fitness-outcome-plank")).toBeVisible();
    await page.getByTestId("fitness-outcome-done-plank").click();
    await expect(modal).toBeHidden();
    await expect(page.getByTestId("fitness-tile-plank")).toContainText(filled);

    await page.close();
  });

  test("fixed-window countdown timer reaches the result input (Finish-early)", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_FITNESS,
      password: E2E_MEMBER_PASSWORD,
    });
    test.slow();

    await page.goto("/training/fitness-check");
    await expect(page.getByTestId("fitness-check")).toBeVisible();

    // Chair stand is a 30-second fixed-window test → the timer counts DOWN.
    await page.getByTestId("fitness-tile-chairstand").click();
    const modal = page.getByTestId("fitness-entry-chairstand");
    await expect(modal).toBeVisible();

    await page.getByTestId("fitness-timer-chairstand-launch").click();
    const panel = page.getByTestId("fitness-timer-chairstand-panel");
    await expect(panel).toBeVisible();
    // Countdown seeds at the full window.
    await expect(
      page.getByTestId("fitness-timer-chairstand-readout")
    ).toHaveText("0:30");

    await page.getByTestId("fitness-timer-chairstand-start").click();
    // Finish-early — a stopped run is still a result; the takeover collapses back to the
    // sheet and focus flips to the reps input.
    await page.getByTestId("fitness-timer-chairstand-finish").click();
    await expect(panel).toBeHidden();

    const reps = page.getByTestId("fitness-value-chairstand");
    await expect(reps).toBeVisible();
    await reps.fill("18");
    await settledClick(page, modal.getByTestId("fitness-submit-chairstand"));
    // The outcome moment (#1307) shows before Done closes the modal.
    await expect(page.getByTestId("fitness-outcome-chairstand")).toBeVisible();
    await page.getByTestId("fitness-outcome-done-chairstand").click();
    await expect(modal).toBeHidden();
    await expect(page.getByTestId("fitness-tile-chairstand")).toContainText(
      "18"
    );

    await page.close();
  });

  test("shows the older-adult battery variant for a senior profile", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_FITNESS_SENIOR,
      password: E2E_MEMBER_PASSWORD,
    });
    test.slow();

    await page.goto("/training/fitness-check");
    await expect(page.getByTestId("fitness-check")).toBeVisible();

    // Senior-variant items are present; the maximal adult items (push-ups, dead hang)
    // are NOT — never hand a 72-year-old a Cooper run and a dead hang.
    await expect(page.getByTestId("fitness-tile-tug")).toBeVisible();
    await expect(page.getByTestId("fitness-tile-armcurl")).toBeVisible();
    await expect(page.getByTestId("fitness-tile-fourstage")).toBeVisible();
    await expect(page.getByTestId("fitness-tile-pushups")).toHaveCount(0);
    await expect(page.getByTestId("fitness-tile-deadhang")).toHaveCount(0);

    await page.close();
  });

  // #1305 — the closure toast. The FITNESS profile's only seeded check is ~100 days old,
  // so the battery-level retest finding is overdue; the FIRST save of a new check flips it
  // (toast once), a SECOND save the same check finds nothing active (silent). resetRecent-
  // Checks makes the "overdue" precondition deterministic under --repeat-each.
  test("first save toasts the retest refresh; a second save toasts nothing", async ({
    browser,
  }) => {
    resetRecentChecks();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_FITNESS,
      password: E2E_MEMBER_PASSWORD,
    });
    test.slow();
    await page.goto("/training/fitness-check");
    await expect(page.getByTestId("fitness-check")).toBeVisible();

    // First save (grip) clears the overdue retest finding → the refresh toast.
    await page.getByTestId("fitness-tile-grip").click();
    await page
      .getByTestId("fitness-entry-grip")
      .getByTestId("fitness-value-grip")
      .fill("50");
    await settledClick(page, page.getByTestId("fitness-submit-grip"));
    await expect(
      page.getByTestId("toast").filter({ hasText: /retest clock restarts/i })
    ).toBeVisible();
    await page.getByTestId("fitness-outcome-done-grip").click();

    // Reload to clear the live toast, so the "no new closure toast" check below can't see
    // a lingering one. The retest finding is already cleared (grip recorded today).
    await page.reload();
    await expect(page.getByTestId("fitness-check")).toBeVisible();

    // Second save (balance), same check → no retest finding active → no closure toast.
    await page.getByTestId("fitness-tile-balance").click();
    await page
      .getByTestId("fitness-entry-balance")
      .getByTestId("fitness-value-balance")
      .fill("25");
    await settledClick(page, page.getByTestId("fitness-submit-balance"));
    await expect(page.getByTestId("fitness-outcome-balance")).toBeVisible();
    await expect(
      page.getByTestId("toast").filter({ hasText: /retest clock restarts/i })
    ).toHaveCount(0);

    await page.close();
  });

  // #1307 — the battery-completion finale. Seed the whole battery fresh EXCEPT push-ups
  // (the one test with no seeded ambient reading on this fixture, so it's genuinely
  // outstanding), so recording it in the browser lands the LAST outstanding test and flips
  // the battery to complete → the completion summary card renders.
  test("completing the last outstanding test renders the completion summary", async ({
    browser,
  }) => {
    seedNearComplete("pushups");
    const page = await loginAs(browser, {
      username: E2E_LOGIN_FITNESS,
      password: E2E_MEMBER_PASSWORD,
    });
    test.slow();
    await page.goto("/training/fitness-check");
    await expect(page.getByTestId("fitness-check")).toBeVisible();

    // Not complete yet — the finale is absent before the last test lands.
    await expect(page.getByTestId("fitness-completion-summary")).toHaveCount(0);

    await page.getByTestId("fitness-tile-pushups").click();
    await page
      .getByTestId("fitness-entry-pushups")
      .getByTestId("fitness-value-pushups")
      .fill("30");
    await settledClick(page, page.getByTestId("fitness-submit-pushups"));
    await expect(page.getByTestId("fitness-outcome-pushups")).toBeVisible();
    await page.getByTestId("fitness-outcome-done-pushups").click();

    const summary = page.getByTestId("fitness-completion-summary");
    await expect(summary).toBeVisible();
    await expect(summary).toContainText(/Check complete/i);

    await page.close();
  });

  // #1307 — prefers-reduced-motion suppresses the landing sweep. Same save path, but the
  // just-saved tile must NOT carry the landing marker (instant fill, no sweep).
  test("honors prefers-reduced-motion (no landing sweep)", async ({
    browser,
  }) => {
    resetRecentChecks();
    const page = await loginAs(
      browser,
      { username: E2E_LOGIN_FITNESS, password: E2E_MEMBER_PASSWORD },
      { reducedMotion: "reduce" }
    );
    test.slow();
    await page.goto("/training/fitness-check");
    await expect(page.getByTestId("fitness-check")).toBeVisible();

    await page.getByTestId("fitness-tile-grip").click();
    await page
      .getByTestId("fitness-entry-grip")
      .getByTestId("fitness-value-grip")
      .fill("50");
    await settledClick(page, page.getByTestId("fitness-submit-grip"));
    await expect(page.getByTestId("fitness-outcome-grip")).toBeVisible();
    await page.getByTestId("fitness-outcome-done-grip").click();

    const gripTile = page.getByTestId("fitness-tile-grip");
    await expect(gripTile).toContainText("50");
    // The landing marker is suppressed under reduced motion.
    await expect(gripTile).not.toHaveAttribute("data-landing", "true");

    await page.close();
  });
});

// Issue #2025 — the check's summaries are honest about stale and best-of data. Read-only
// against the FITNESS fixture profile (which owns a ~100-day-old grip check plus seeded
// natural-store readings), so it is repeat-safe and never perturbs a neighbour.
test.describe("Fitness check honesty: freshness + domain rollup (#2025)", () => {
  test("completion counts CURRENT values and names the stale remainder", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_FITNESS,
      password: E2E_MEMBER_PASSWORD,
    });
    test.slow();
    await page.goto("/training/fitness-check");
    await expect(page.getByTestId("fitness-check")).toBeVisible();

    // "has a current value" — not "has any value", which is what the old copy called
    // "recent" while counting readings of any age.
    const completion = page.getByTestId("fitness-completion");
    await expect(completion).toContainText("with a current value");

    // A stale reading is still MEASURED and still shows its provenance — the fix is what
    // the aggregate claims, never what it hides. The seeded grip check is ~100 days old,
    // past the fixture profile's cadence, so it is present and marked rather than gone.
    await expect(page.getByTestId("fitness-tile-grip")).toContainText("Grip");

    await page.close();
  });

  test("the domain strip says it is the BEST norms result, not the domain", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_FITNESS,
      password: E2E_MEMBER_PASSWORD,
    });
    test.slow();
    await page.goto("/training/fitness-check");
    await expect(page.getByTestId("fitness-check")).toBeVisible();

    // The seeded synced VO2 gives the endurance domain a norms-backed result.
    const endurance = page.getByTestId("fitness-domain-endurance");
    await expect(endurance).toBeVisible();
    await expect(endurance).toContainText("best");

    // The shared component captions what the bar is — so both consuming surfaces say it.
    const caption = page.getByTestId("fitness-domain-caption");
    await expect(caption).toContainText("best result against published norms");
    await expect(caption).toContainText("not");

    await page.close();
  });

  test("the retired ?tab=fitness deep link redirects to the route (#2894)", async ({
    page,
  }) => {
    // Telegram history and old bookmarks can never be rewritten: the training
    // page matches the retired tab name and redirects to the battery's route.
    await page.goto("/training?tab=fitness");
    await expect(page).toHaveURL(/\/training\/fitness-check/);
    await expect(page.getByTestId("fitness-check")).toBeVisible();
  });
});
