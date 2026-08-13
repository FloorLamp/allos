import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { hydratedClick, settledClick } from "./helpers";
import { medicationsToday, scheduledTodayItem } from "./med-card-helpers";
import {
  E2E_LOGIN_PROTEIN,
  E2E_LOGIN_SUPPRESSED,
  E2E_MEMBER_PASSWORD,
  SUPPRESSED_PROFILE,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// Micro-motion (#2654): the four moves that carry information — a confirm settling
// into its done state, a counter rolling to its new quantity, a dismissed finding
// travelling toward the fold that catches it, and that fold answering.
//
// HOW THIS IS ASSERTED, and why it is not a timing test. The frozen-clock harness
// dislikes animation timing, and "the thing was mid-animation when I looked" is the
// flakiest assertion in the suite. So the spec never measures a duration. It installs
// a document-level `animationstart` / `animationiteration` probe BEFORE the gesture
// and then asserts three things that are true whenever the browser has finished
// settling: the keyframe ran EXACTLY ONCE, it never iterated (the "nothing loops"
// guardrail, mechanically), and the END STATE — the number, the `aria-pressed`, the
// accessible name — is correct. Every one of those is a stable post-condition that
// `expect.poll`/`toHaveText` can wait on honestly.
//
// The reduced-motion half is a peer, not an afterthought: the SAME gestures with
// `reducedMotion: "reduce"` must reach the SAME end states with the keyframe count at
// zero. That is the whole design claim — reduced motion is the information arriving
// instantly, not the information going missing — and an untested reduced path is
// where this class of feature rots.

interface MotionProbe {
  __motionRuns?: Record<string, number>;
  __motionLoops?: number;
}

// Count every CSS animation the page starts, by keyframe name, plus any iteration
// past the first. Capture-phase listeners on the document, installed before the
// gesture, so nothing has to be observed while it is happening.
async function installMotionProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as MotionProbe;
    w.__motionRuns = {};
    w.__motionLoops = 0;
    document.addEventListener(
      "animationstart",
      (event) => {
        const name = (event as AnimationEvent).animationName;
        const runs = (window as unknown as MotionProbe).__motionRuns;
        if (runs) runs[name] = (runs[name] ?? 0) + 1;
      },
      true
    );
    document.addEventListener(
      "animationiteration",
      () => {
        const probe = window as unknown as MotionProbe;
        probe.__motionLoops = (probe.__motionLoops ?? 0) + 1;
      },
      true
    );
  });
}

function motionRuns(page: Page, keyframe: string): Promise<number> {
  return page.evaluate(
    (name) => (window as unknown as MotionProbe).__motionRuns?.[name] ?? 0,
    keyframe
  );
}

function motionLoops(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as MotionProbe).__motionLoops ?? 0
  );
}

// ── Motion 1: a confirm settles ──────────────────────────────────────────────
//
// The shared "Adherence Refill Med (e2e)" scheduled dose, taken and then un-taken so
// the spec leaves the profile exactly as it found it — the same discipline (and the
// same row) as e2e/medications-page.spec.ts. The un-taken precondition is asserted
// rather than assumed, so a neighbour that left the dose confirmed fails this spec
// loudly instead of quietly changing what it proves.

test("a dose confirm settles once into its done state, and never loops (#2654)", async ({
  page,
}) => {
  await page.goto("/medications");
  const today = medicationsToday(page);
  await expect(today).toBeVisible();

  const scheduled = scheduledTodayItem(today, "Adherence Refill Med (e2e)");
  const control = scheduled.getByTestId("dose-status");
  const take = scheduled.getByTestId("dose-take");
  await expect(take).toHaveAttribute("aria-pressed", "false");
  // The motion branch this run took, published on the control so the two halves of
  // this spec are distinguishable from the DOM rather than from the test's own name.
  await expect(control).toHaveAttribute("data-reduced-motion", "false");
  await expect(take).toHaveAttribute("data-settling", "false");

  await installMotionProbe(page);
  await settledClick(page, take);

  // The END STATE first: it is what the user is owed, and it is what carries "taken"
  // for a reader who sees no motion at all.
  await expect(take).toHaveAttribute("aria-pressed", "true");
  await expect(take).toHaveAccessibleName("Mark not taken");

  // The settle ran exactly once and the class came back off, so nothing is left
  // animating or stuck mid-keyframe on the button the user may tap again.
  await expect.poll(() => motionRuns(page, "micro-settle")).toBe(1);
  await expect(take).toHaveAttribute("data-settling", "false");
  await expect(take).not.toHaveClass(/motion-settle/);
  expect(await motionLoops(page)).toBe(0);

  // Un-taking is a CORRECTION, not a confirm, so it does not settle — the count
  // stays at one across a second, opposite tap.
  await settledClick(page, take);
  await expect(take).toHaveAttribute("aria-pressed", "false");
  expect(await motionRuns(page, "micro-settle")).toBe(1);
  expect(await motionLoops(page)).toBe(0);
});

test.describe("confirm settle under reduced motion (#2654)", () => {
  // PW exposes the emulation through contextOptions (there is no top-level
  // `reducedMotion` test option), matching e2e/shell.mobile.spec.ts's shape.
  test.use({ contextOptions: { reducedMotion: "reduce" } });

  test("the dose still reaches its done state — it just lands", async ({
    page,
  }) => {
    await page.goto("/medications");
    const today = medicationsToday(page);
    await expect(today).toBeVisible();

    const scheduled = scheduledTodayItem(today, "Adherence Refill Med (e2e)");
    const control = scheduled.getByTestId("dose-status");
    const take = scheduled.getByTestId("dose-take");
    await expect(take).toHaveAttribute("aria-pressed", "false");
    await expect(control).toHaveAttribute("data-reduced-motion", "true");

    await installMotionProbe(page);
    await settledClick(page, take);

    // Identical end state, reached by awaiting the same post-conditions.
    await expect(take).toHaveAttribute("aria-pressed", "true");
    await expect(take).toHaveAccessibleName("Mark not taken");
    await expect(take).toHaveClass(/cursor-default/);

    // And no keyframe was ever scheduled. Read AFTER the end state settled, so this
    // is "the animation did not run", not "the animation had not run yet".
    await expect(take).toHaveAttribute("data-settling", "false");
    expect(await motionRuns(page, "micro-settle")).toBe(0);
    expect(await motionLoops(page)).toBe(0);

    await settledClick(page, take);
    await expect(take).toHaveAttribute("aria-pressed", "false");
  });
});

// ── Motion 3: a counter rolls ────────────────────────────────────────────────
//
// The protein quick-add's day total, on the DEDICATED protein fixture profile
// (E2E_LOGIN_PROTEIN, its own cookie context) that e2e/protein-quickadd.spec.ts also
// owns — add then undo, so the day's grams end where they started and that spec's
// "0g today" precondition survives. The starting total is READ rather than assumed
// for the same reason.

const GRAMS = 30;

async function proteinTotalNow(page: Page): Promise<number> {
  const text = await page.getByTestId("protein-quickadd-total").innerText();
  const digits = text.replace(/[^0-9]/g, "");
  return digits === "" ? 0 : Number(digits);
}

test("a day counter rolls to its new quantity, once, on the tap that changed it (#2654)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_PROTEIN,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    test.slow();
    await page.goto("/nutrition");
    const total = page.getByTestId("protein-quickadd-total");
    const grams = page.getByTestId("protein-quickadd-grams");
    await expect(total).toBeVisible();
    await expect(grams).toHaveAttribute("data-motion", "count");
    await expect(grams).toHaveAttribute("data-reduced-motion", "false");
    const before = await proteinTotalNow(page);

    // MOUNT NEVER ROLLS. The probe is installed on the loaded page and nothing has
    // been tapped, so a roll counted here would be the number animating at someone
    // who merely arrived.
    await installMotionProbe(page);
    await expect(grams).toHaveAttribute("data-rolling", "false");
    expect(await motionRuns(page, "micro-count")).toBe(0);

    await page.getByTestId("protein-quickadd-input").fill(String(GRAMS));
    await settledClick(page, page.getByTestId("protein-quickadd-add"));

    // The end state is the truth: the total is the new quantity, in text.
    await expect(total).toHaveText(`${before + GRAMS}g today`);
    // It got there by rolling — exactly one pulse, and no iteration.
    await expect.poll(() => motionRuns(page, "micro-count")).toBe(1);
    await expect(grams).toHaveAttribute("data-rolling", "false");
    await expect(grams).not.toHaveClass(/motion-count/);
    expect(await motionLoops(page)).toBe(0);

    // Leave the fixture as found; the removal is a quantity change too, so the roll
    // count moves to two rather than staying put.
    await settledClick(page, page.getByTestId("protein-quickadd-undo"));
    await expect(total).toHaveText(`${before}g today`);
    await expect.poll(() => motionRuns(page, "micro-count")).toBe(2);
    expect(await motionLoops(page)).toBe(0);
  } finally {
    await page.context().close();
  }
});

test("a day counter under reduced motion shows the new quantity instantly (#2654)", async ({
  browser,
}) => {
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_PROTEIN, password: E2E_MEMBER_PASSWORD },
    { reducedMotion: "reduce" }
  );
  try {
    test.slow();
    await page.goto("/nutrition");
    const total = page.getByTestId("protein-quickadd-total");
    const grams = page.getByTestId("protein-quickadd-grams");
    await expect(total).toBeVisible();
    await expect(grams).toHaveAttribute("data-reduced-motion", "true");
    const before = await proteinTotalNow(page);

    await installMotionProbe(page);
    await page.getByTestId("protein-quickadd-input").fill(String(GRAMS));
    await settledClick(page, page.getByTestId("protein-quickadd-add"));

    // Same number, same place, same text — the information arrived, it just did not
    // travel. The tween never started and the pulse class was never applied.
    await expect(total).toHaveText(`${before + GRAMS}g today`);
    await expect(grams).toHaveAttribute("data-rolling", "false");
    await expect(grams).not.toHaveClass(/motion-count/);
    expect(await motionRuns(page, "micro-count")).toBe(0);
    expect(await motionLoops(page)).toBe(0);

    await settledClick(page, page.getByTestId("protein-quickadd-undo"));
    await expect(total).toHaveText(`${before}g today`);
    expect(await motionRuns(page, "micro-count")).toBe(0);
  } finally {
    await page.context().close();
  }
});

// ── Motion 2: a dismissal travels, and the fold answers ──────────────────────
//
// TWO motions, asserted apart because they are two: the dismissed row's `micro-slide`
// (in-band, 300 ms) and the fold line's `micro-fold` pulse (500 ms, the one duration
// the owner ruling of 2026-08-13 exempted from the band). Folding them into one
// assertion would be the same conflation the ruling warns against.
//
// Fixture ownership (#868): the dedicated SUPPRESSED_PROFILE, whose fold already
// holds rows, plus its own "E2E Dismissable Appointment" — one live Upcoming row that
// exists to be dismissed. This spec owns BOTH sides of its precondition rather than
// trusting the seed: it clears that appointment's dismissal (so the row is on the
// list) and asserts its own anchor dismissal (so the FOLD EXISTS before the tap —
// the section only renders when it holds something, and a fold that appears cannot
// also be seen to increment). Blast radius: this fixture profile's
// upcoming_dismissals rows, none of which suppressed-center.spec.ts owns.

const DISMISSABLE_APPT = "E2E Dismissable Appointment";
// This spec's own fold row. Labelled from its key alone by lib/suppression-display.ts,
// so it needs no backing record — the same trick the suppressed-center fixture uses.
const FOLD_ANCHOR_KEY = "training-obs:plateau:e2e fold anchor";

function resetDismissFold(): void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const prof = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(SUPPRESSED_PROFILE) as { id: number } | undefined;
    if (!prof) throw new Error("micro-motion fold fixture profile missing");
    const appt = db
      .prepare("SELECT id FROM appointments WHERE profile_id = ? AND title = ?")
      .get(prof.id, DISMISSABLE_APPT) as { id: number } | undefined;
    if (!appt) throw new Error("micro-motion dismissable appointment missing");
    const del = db.prepare(
      "DELETE FROM upcoming_dismissals WHERE profile_id = ? AND signal_key = ?"
    );
    // The row must be ON the list, whatever a previous run left behind.
    del.run(prof.id, `appointment:${appt.id}`);
    // …and the fold must already exist, so the count can be watched going UP.
    del.run(prof.id, FOLD_ANCHOR_KEY);
    db.prepare(
      `INSERT INTO upcoming_dismissals (profile_id, signal_key, dismissed_at)
       VALUES (?, ?, datetime('now'))`
    ).run(prof.id, FOLD_ANCHOR_KEY);
  } finally {
    db.close();
  }
}

async function foldCount(page: Page): Promise<number> {
  const text = await page.getByTestId("suppressed-count").innerText();
  return Number(text.replace(/[^0-9]/g, ""));
}

function dismissableRow(page: Page) {
  return page
    .locator("[data-dismiss-row]")
    .filter({ hasText: DISMISSABLE_APPT });
}

// Opening the kebab is a pure client toggle (no POST); the Dismiss item behind it is
// the Server Action. Two different helpers, deliberately.
async function dismissFromMenu(page: Page): Promise<void> {
  await hydratedClick(
    page,
    dismissableRow(page).getByTestId("overflow-menu-trigger")
  );
  await settledClick(page, page.getByRole("menuitem", { name: "Dismiss" }));
}

// The revalidated tree can lag the action's own resolution by seconds under load
// (#1964), and every assertion here is about what the tree says AFTER the apply.
const APPLIED = 20_000;

test("a dismissal slides toward the fold, which pulses once as it catches it (#2654)", async ({
  browser,
}) => {
  resetDismissFold();
  const page = await loginAs(browser, {
    username: E2E_LOGIN_SUPPRESSED,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    test.slow();
    await page.goto("/upcoming");
    const summary = page.getByTestId("suppressed-summary");
    await expect(summary).toBeVisible();
    await expect(summary).toHaveAttribute("data-reduced-motion", "false");
    await expect(dismissableRow(page)).toBeVisible();
    const before = await foldCount(page);

    // ARRIVAL NEVER PULSES. The probe is installed on the loaded page with nothing
    // tapped, so a run counted here would be the fold making an attention claim at
    // someone who merely opened Upcoming — the line a finding may not cross.
    await installMotionProbe(page);
    await expect(summary).toHaveAttribute("data-pulsing", "false");
    expect(await motionRuns(page, "micro-fold")).toBe(0);
    expect(await motionRuns(page, "micro-slide")).toBe(0);

    await dismissFromMenu(page);

    // THE END STATE FIRST, because it is what the user is owed and what carries the
    // whole fact without any motion: the row has left the list, and the fold's own
    // text says it now holds one more.
    await expect(dismissableRow(page)).toHaveCount(0, { timeout: APPLIED });
    await expect(page.getByTestId("suppressed-count")).toHaveText(
      `(${before + 1})`,
      { timeout: APPLIED }
    );

    // It TRAVELLED, and the fold ANSWERED — once each, and neither iterated.
    await expect.poll(() => motionRuns(page, "micro-slide")).toBe(1);
    await expect.poll(() => motionRuns(page, "micro-fold")).toBe(1);
    await expect(summary).toHaveAttribute("data-pulsing", "false");
    await expect(summary).not.toHaveClass(/motion-fold/);
    expect(await motionLoops(page)).toBe(0);

    // The lesson the travel teaches, verified: the finding is REACHABLE inside the
    // fold it went to, with its own Restore (#2386's doctrine, animated).
    await hydratedClick(page, summary);
    const foldRow = page
      .getByTestId("suppressed-row")
      .filter({ hasText: DISMISSABLE_APPT });
    await expect(foldRow).toBeVisible();

    // And restoring it — the fold LOSING a row — says nothing, so it does not pulse.
    // A pulse there would celebrate the opposite fact. Leaves the fixture as found.
    await settledClick(page, foldRow.getByRole("button", { name: "Restore" }));
    await expect(page.getByTestId("suppressed-count")).toHaveText(
      `(${before})`,
      {
        timeout: APPLIED,
      }
    );
    await expect(dismissableRow(page)).toBeVisible({ timeout: APPLIED });
    expect(await motionRuns(page, "micro-fold")).toBe(1);
    expect(await motionLoops(page)).toBe(0);
  } finally {
    await page.context().close();
  }
});

test("a dismissal under reduced motion just lands in the fold (#2654)", async ({
  browser,
}) => {
  resetDismissFold();
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_SUPPRESSED, password: E2E_MEMBER_PASSWORD },
    { reducedMotion: "reduce" }
  );
  try {
    test.slow();
    await page.goto("/upcoming");
    const summary = page.getByTestId("suppressed-summary");
    await expect(summary).toBeVisible();
    await expect(summary).toHaveAttribute("data-reduced-motion", "true");
    await expect(dismissableRow(page)).toBeVisible();
    const before = await foldCount(page);

    await installMotionProbe(page);
    await dismissFromMenu(page);

    // The SAME end state, reached by awaiting the same post-conditions — the
    // information arrived, it just did not travel to get here.
    await expect(dismissableRow(page)).toHaveCount(0, { timeout: APPLIED });
    await expect(page.getByTestId("suppressed-count")).toHaveText(
      `(${before + 1})`,
      { timeout: APPLIED }
    );
    await expect(summary).toHaveAttribute("data-pulsing", "false");
    await expect(summary).not.toHaveClass(/motion-fold/);
    // Read AFTER the end state settled, so this is "no keyframe ran", not "no
    // keyframe had run yet".
    expect(await motionRuns(page, "micro-slide")).toBe(0);
    expect(await motionRuns(page, "micro-fold")).toBe(0);
    expect(await motionLoops(page)).toBe(0);

    await hydratedClick(page, summary);
    const foldRow = page
      .getByTestId("suppressed-row")
      .filter({ hasText: DISMISSABLE_APPT });
    await settledClick(page, foldRow.getByRole("button", { name: "Restore" }));
    await expect(page.getByTestId("suppressed-count")).toHaveText(
      `(${before})`,
      {
        timeout: APPLIED,
      }
    );
  } finally {
    await page.context().close();
  }
});
