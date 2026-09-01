import type { Locator, Page, Response } from "@playwright/test";
import Database from "better-sqlite3";
import { test, expect } from "./fixtures";
import { openLogSheet } from "./log-sheet-helpers";
import {
  E2E_LOGIN_SHELL,
  SHELL_DOSE_ITEM,
  SHELL_PROFILE,
} from "./logins/metrics";
import { E2E_LOGIN_LOGSHEET_RESERVE } from "./logins/nutrition";
import { E2E_MEMBER_PASSWORD } from "./logins/shared";
import { settledAfterAnimation, settledBoxes } from "./helpers";
import { loginAs } from "./nav";
import { frozenNow, workerDbPath } from "./worker-env";
import {
  LOG_SHEET_CONTEXT_RESERVE_PX,
  LOG_SHEET_ROW_BLOCK_PX,
} from "@/lib/log-sheet";
import { CONTROL_BOX_PX, TAP_FLOOR_PX } from "@/lib/tap-floor-tokens";

const PHONE_430 = { viewport: { width: 430, height: 932 }, hasTouch: true };
const PHONE_390 = { viewport: { width: 390, height: 844 }, hasTouch: true };
const PX_EPSILON = 1;

type Box = NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>;

async function box(locator: Locator, name: string): Promise<Box> {
  await expect(locator, name).toBeVisible();
  const measured = await locator.boundingBox();
  expect(measured, name).not.toBeNull();
  return measured!;
}

async function sheetGeometry(sheet: Locator) {
  const panelLocator = sheet.locator("[data-sheet-panel]");
  const segmentsLocator = sheet.getByTestId("log-sheet-segments");
  await expect(panelLocator, "sheet panel").toBeVisible();
  await expect(segmentsLocator, "segment strip").toBeVisible();
  // `usePresence` exposes only `enter` / `exit`: while a sheet is open its
  // `data-phase` remains `enter` by design, so waiting for a fictional `rest`
  // state can never settle. Ask the rendered panel's animation instead, then
  // take one atomic, two-consecutive-read geometry snapshot. This is a positive
  // stable-state signal and resolves immediately under reduced motion.
  await settledAfterAnimation(panelLocator);
  const [panel, segments] = await settledBoxes([panelLocator, segmentsLocator]);
  return { panelHeight: panel.height, segmentTop: segments.y };
}

// THE PANEL IS WHAT MUST BE CONSTANT (#3736). Since the sheet holds ONE reserve
// at the panel instead of one per region, the regions inside it move: a gather
// that resolves grows the context region and shrinks the trailing spacer by the
// same amount, so the segment track legitimately sits lower afterwards. The
// panel's height is the invariant, and it is asserted on its own wherever the
// straddled event changes what the regions hold.
function expectSamePanelHeight(
  actual: Awaited<ReturnType<typeof sheetGeometry>>,
  expected: Awaited<ReturnType<typeof sheetGeometry>>
) {
  expect(
    Math.abs(actual.panelHeight - expected.panelHeight)
  ).toBeLessThanOrEqual(PX_EPSILON);
}

// Switching segments changes only the row count, which the spacer absorbs, so
// the track cannot move either.
function expectSameGeometry(
  actual: Awaited<ReturnType<typeof sheetGeometry>>,
  expected: Awaited<ReturnType<typeof sheetGeometry>>
) {
  expectSamePanelHeight(actual, expected);
  expect(Math.abs(actual.segmentTop - expected.segmentTop)).toBeLessThanOrEqual(
    PX_EPSILON
  );
}

async function nextActionResponse(page: Page): Promise<Response> {
  return page.waitForResponse((response) => {
    const request = response.request();
    return (
      request.method() === "POST" && Boolean(request.headers()["next-action"])
    );
  });
}

function setShellDoseResolved(present: boolean): void {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  try {
    const ids = db
      .prepare(
        `SELECT d.id AS doseId, i.id AS itemId
           FROM intake_item_doses d
           JOIN intake_items i ON i.id = d.item_id
          WHERE i.profile_id = (SELECT id FROM profiles WHERE name = ?)
            AND i.name = ?`
      )
      .get(SHELL_PROFILE, SHELL_DOSE_ITEM) as {
      doseId: number;
      itemId: number;
    };
    const date = frozenNow().toISOString().slice(0, 10);
    db.prepare(
      "DELETE FROM intake_item_logs WHERE dose_id = ? AND item_id = ? AND date = ?"
    ).run(ids.doseId, ids.itemId, date);
    if (present) {
      db.prepare(
        "INSERT INTO intake_item_logs (dose_id, item_id, date) VALUES (?, ?, ?)"
      ).run(ids.doseId, ids.itemId, date);
    }
  } finally {
    db.close();
  }
}

test("every segment keeps the sheet still and fills the phone width (#3675)", async ({
  browser,
}) => {
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_SHELL, password: E2E_MEMBER_PASSWORD },
    PHONE_430
  );
  try {
    await page.goto("/");
    const sheet = await openLogSheet(page);
    await expect(sheet.getByTestId("log-sheet-context")).toBeVisible();

    const track = sheet.getByTestId("log-sheet-segments");
    const options = track.locator("[data-segmented-option]");
    await expect(options).toHaveCount(4);
    await expect(options.nth(1)).toHaveText("Consume");

    const trackBox = await box(track, "filled track");
    const listBox = await box(
      sheet.getByTestId("log-sheet-items"),
      "fixed list"
    );
    expect(Math.abs(trackBox.x - listBox.x)).toBeLessThanOrEqual(PX_EPSILON);
    expect(
      Math.abs(trackBox.x + trackBox.width - (listBox.x + listBox.width))
    ).toBeLessThanOrEqual(PX_EPSILON);

    const widths: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      widths.push((await box(options.nth(index), `segment ${index}`)).width);
    }
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(
      PX_EPSILON
    );

    const baseline = await sheetGeometry(sheet);
    for (let index = 0; index < 4; index += 1) {
      const option = options.nth(index);
      await option.click();
      await expect(option).toHaveAttribute("aria-pressed", "true");
      expectSameGeometry(await sheetGeometry(sheet), baseline);
    }

    await page.setViewportSize(PHONE_390.viewport);
    const baseline390 = await sheetGeometry(sheet);
    // THE BOX, THEN THE FLOOR IT MEETS EFFECTIVELY (#3938, extended to segments
    // by #3954). This asserted a RENDERED 44 and went red when the segments
    // joined the control box — correctly, because 44 is the number that moved.
    // What replaces it is stronger rather than weaker: the rendered height is
    // `--control-box` as an EQUALITY, so a segment that grows one reds too, and
    // the 44 is met by the reach a coarse pointer gets around that box.
    //
    // ONLY THE BLOCK INSET COUNTS, AND THAT IS PART OF THE CLAIM. A segmented
    // track's options tile their line with no gap, so they take no INLINE reach —
    // one taken from the neighbour would move the boundary between two segments
    // rather than enlarge either. Adding `top`'s inset on both axes would credit
    // this track with 12px of inline target it does not have, so the inset is
    // read per axis and the inline one is asserted to be zero.
    const heights390: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const option = options.nth(index);
      await option.click();
      await expect(option).toHaveAttribute("aria-pressed", "true");
      // Read back from the render, not from a class list: `@media (pointer:
      // coarse)` is a real condition and this project's history is a floor that
      // read correctly in the stylesheet and never reached the element (#3514).
      const measured = await option.evaluate((el) => {
        const after = getComputedStyle(el, "::after");
        const side = (raw: string) => {
          const inset = Math.abs(Number.parseFloat(raw));
          return after.content === "none" || !Number.isFinite(inset)
            ? 0
            : inset;
        };
        return {
          height: el.getBoundingClientRect().height,
          block: side(after.top),
          inline: side(after.left),
        };
      });
      heights390.push(measured.height);
      expect(
        measured.inline,
        `390px segment ${index} reaches sideways into the segment beside it; a tiled track has no gap to spend`
      ).toBe(0);
      expect(
        measured.height + 2 * measured.block + PX_EPSILON,
        `390px segment ${index}: ${measured.height}px rendered + 2x${measured.block}px block reach`
      ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
      // The AC's own measurement: byte-identical panel height on all four
      // segments at 390px, Train (two rows) included (#3736).
      expectSameGeometry(await sheetGeometry(sheet), baseline390);
    }
    // One box across the strip, not four that each happen to clear a floor. The
    // four labels are a fixed vocabulary (`SEGMENT_LABELS` in lib/log-sheet.ts),
    // so none of them wraps at a quarter of 390 and the equality is exact.
    expect(
      [...new Set(heights390.map((height) => Math.round(height)))],
      `the 390px track renders more than one segment height: ${heights390.join(", ")}`
    ).toEqual([CONTROL_BOX_PX]);

    // ...and the slack is all in ONE place. On Train — the fewest rows, so the
    // segment carrying the most of it — nothing sits between the last row and
    // the next thing down, and nothing between the last offer and the rule.
    await sheet.getByTestId("log-sheet-segment-train").click();
    const list = sheet.getByTestId("log-sheet-items");
    const rows = list.locator("> li");
    const drawn = await rows.count();
    // Train is the short segment for every profile — two entries where Consume and
    // Body have three and Care, since #4064's symptom row, has four — so it is where
    // the old per-segment reserve showed as a hole, and by the widest margin the
    // sheet has held. Read against the sheet's own reserve rather than a pinned
    // count: this persona's training gates leave it one row, not two.
    const reserved = Number(await list.getAttribute("data-max-rows"));
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(reserved);
    const lastRow = await box(rows.last(), "Train's last row");
    const spacer = await sheet.getByTestId("log-sheet-spacer").boundingBox();
    expect(spacer, "trailing spacer").not.toBeNull();
    // The list's own `pb-1` is the 4px the row block already counts.
    expect(spacer!.y - (lastRow.y + lastRow.height)).toBeLessThanOrEqual(
      4 + PX_EPSILON
    );
    // Whatever rows Train is short of the reserve, the SPACER is holding them
    // and the list is not — derived from the two counts rather than pinned, so
    // it stays true for a persona whose training gates leave a different number.
    expect(spacer!.height + PX_EPSILON).toBeGreaterThanOrEqual(
      (reserved - drawn) * LOG_SHEET_ROW_BLOCK_PX
    );

    const section = await box(
      sheet.getByTestId("log-sheet-context"),
      "context section"
    );
    const lastOffer = await box(
      sheet.getByTestId("log-sheet-chip-doses"),
      "due-dose offer"
    );
    // `pb-3` (12px) plus the 1px rule is all that may separate the last offer
    // from the section's bottom border — the reserve is no longer pinned there.
    expect(
      section.y + section.height - (lastOffer.y + lastOffer.height)
    ).toBeLessThanOrEqual(13 + PX_EPSILON);
  } finally {
    await page.context().close();
  }
});

test("a delayed gather paints into the reserved slot without moving the sheet (#3675)", async ({
  browser,
}) => {
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_SHELL, password: E2E_MEMBER_PASSWORD },
    PHONE_430
  );
  try {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let answerReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      answerReady = resolve;
    });
    let intercepted = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (
        !intercepted &&
        request.method() === "POST" &&
        request.headers()["next-action"]
      ) {
        intercepted = true;
        const response = await route.fetch();
        answerReady();
        await held;
        await route.fulfill({ response });
        return;
      }
      await route.fallback();
    });

    await page.goto("/");
    const sheet = await openLogSheet(page);
    await ready;
    await expect(sheet.getByTestId("log-sheet-context")).toHaveCount(0);
    const before = await sheetGeometry(sheet);
    // Not `box`: with nothing gathered the slot is content-sized to nothing, and
    // a zero-height element is not "visible" (#3736).
    const reservedBefore = await sheet
      .getByTestId("log-sheet-context-slot")
      .boundingBox();
    expect(reservedBefore, "empty context slot").not.toBeNull();

    release();
    await expect(sheet.getByTestId("log-sheet-context")).toBeVisible();
    // THE #3736 MEASUREMENT, straddling the resolve: the panel does not move a
    // pixel, and the reason is no longer that the slot was padded to a worst
    // case. The slot itself GROWS into the offers it just received, and the
    // trailing spacer gives up exactly that much.
    expectSamePanelHeight(await sheetGeometry(sheet), before);
    const reservedAfter = await box(
      sheet.getByTestId("log-sheet-context-slot"),
      "filled context slot"
    );
    expect(reservedAfter.height).toBeGreaterThan(reservedBefore!.height);
    await expect(sheet.getByTestId("log-sheet-context-status")).toHaveText(
      "Due and usual options are ready."
    );
  } finally {
    await page.context().close();
  }
});

test("an empty gathered answer keeps the same reserved geometry and stays silent (#3675)", async ({
  browser,
}) => {
  setShellDoseResolved(true);
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_SHELL, password: E2E_MEMBER_PASSWORD },
    PHONE_430
  );
  try {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let answerReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      answerReady = resolve;
    });
    let intercepted = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (
        !intercepted &&
        request.method() === "POST" &&
        request.headers()["next-action"]
      ) {
        intercepted = true;
        const response = await route.fetch();
        answerReady();
        await held;
        await route.fulfill({ response });
        return;
      }
      await route.fallback();
    });

    await page.goto("/");
    const sheet = await openLogSheet(page);
    await ready;
    const before = await sheetGeometry(sheet);
    const reserve = sheet.getByTestId("log-sheet-context-slot");
    await expect(reserve).toHaveAttribute("data-context-state", "loading");

    release();
    await expect(reserve).toHaveAttribute("data-context-state", "ready");
    // Nothing to paint, so nothing moves at all — the panel-level reserve makes
    // the empty answer and the offered one the same height (#3736).
    expectSameGeometry(await sheetGeometry(sheet), before);
    await expect(sheet.getByTestId("log-sheet-context")).toHaveCount(0);
    await expect(sheet.getByTestId("log-sheet-context-status")).toHaveText("");
  } finally {
    setShellDoseResolved(false);
    await page.context().close();
  }
});

test("a failed gather stays silent and reduced motion schedules no arrive keyframe (#3675)", async ({
  browser,
}) => {
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_SHELL, password: E2E_MEMBER_PASSWORD },
    { ...PHONE_390, reducedMotion: "reduce" }
  );
  try {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requestReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      requestReady = resolve;
    });
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (request.method() === "POST" && request.headers()["next-action"]) {
        requestReady();
        await held;
        await route.fulfill({
          status: 502,
          contentType: "text/plain",
          body: "Gather unavailable",
        });
        return;
      }
      await route.fallback();
    });

    await page.goto("/");
    const response = nextActionResponse(page);
    const sheet = await openLogSheet(page);
    await ready;
    const reserve = sheet.getByTestId("log-sheet-context-slot");
    await expect(reserve).toHaveAttribute("data-context-state", "loading");
    const before = await sheetGeometry(sheet);
    release();
    await response;
    await expect(reserve).toHaveAttribute("data-context-state", "failed");

    expectSameGeometry(await sheetGeometry(sheet), before);
    await expect(sheet.getByTestId("log-sheet-context")).toHaveCount(0);
    await expect(sheet.getByTestId("log-sheet-context-status")).toHaveText("");

    // The positive reduced-motion arm is driven by letting a fresh gather resolve.
    await page.unrouteAll({ behavior: "wait" });
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await page.getByTestId("dock-log-puck").click();
    await expect(sheet.getByTestId("log-sheet-context")).toBeVisible();
    const section = sheet.getByTestId("log-sheet-context");
    await expect(section).not.toHaveClass(/motion-arrive/);
    const animation = await section.evaluate((node) => ({
      name: getComputedStyle(node).animationName,
      opacity: getComputedStyle(node).opacity,
      running: node.getAnimations().length,
    }));
    expect(animation).toEqual({ name: "none", opacity: "1", running: 0 });
  } finally {
    await page.context().close();
  }
});

// THE SUM, MEASURED (#3736). Every other test here runs on a persona whose context
// region holds ONE offer and no routine control, so the region's WORST case — the case
// LOG_SHEET_CONTEXT_RESERVE_PX is a bound on — was asserted only by its own arithmetic.
// Two constants shipped wrong that way. This persona renders all three parts at once:
// the composed routine control, the due-dose offer, and the resume-workout offer.
test("the context region at its tallest still fits the panel's one reserve (#3736)", async ({
  browser,
}) => {
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_LOGSHEET_RESERVE, password: E2E_MEMBER_PASSWORD },
    PHONE_390
  );
  try {
    await page.goto("/");
    const sheet = await openLogSheet(page);
    // Wait for the CONTENT, not the container: the region loads asynchronously and an
    // empty one fits any reserve, which is the reading that flatters us.
    await expect(sheet.getByTestId("log-sheet-context")).toBeVisible();
    await expect(sheet.getByTestId("routine-usual-offer")).toBeVisible();
    await expect(sheet.getByTestId("log-sheet-chip-doses")).toBeVisible();
    await expect(sheet.getByTestId("log-sheet-chip-session")).toBeVisible();

    const doseOffer = await box(
      sheet.getByTestId("log-sheet-chip-doses"),
      "the clamped due-dose offer"
    );
    const sessionOffer = await box(
      sheet.getByTestId("log-sheet-chip-session"),
      "the one-line resume offer"
    );
    const rowHeights = [doseOffer.height, sessionOffer.height];

    // The region therefore fits INSIDE the number that stands for it — with the label
    // that, unbounded, would have burst it.
    const slot = await box(
      sheet.getByTestId("log-sheet-context-slot"),
      "context slot at its tallest"
    );
    expect(slot.height).toBeLessThanOrEqual(LOG_SHEET_CONTEXT_RESERVE_PX);

    // ...and with the region at its tallest the PANEL is still the same height on
    // every segment, which is the invariant the reserve exists for. If the sum were
    // short, the spacer would be gone and this is where the panel would start
    // tracking the row count again.
    const options = sheet
      .getByTestId("log-sheet-segments")
      .locator("[data-segmented-option]");
    const count = await options.count();
    expect(count).toBeGreaterThan(1);
    const baseline = await sheetGeometry(sheet);
    for (let index = 0; index < count; index += 1) {
      const option = options.nth(index);
      await option.click();
      await expect(option).toHaveAttribute("aria-pressed", "true");
      const subtitles = sheet.locator("[data-sheet-row-label] + span");
      expect(await subtitles.count()).toBe(0);
      const rows = sheet.getByTestId("log-sheet-items").locator("button");
      for (let row = 0; row < (await rows.count()); row += 1)
        rowHeights.push((await box(rows.nth(row), "segment row")).height);
      expectSameGeometry(await sheetGeometry(sheet), baseline);
    }
    expect([...new Set(rowHeights.map(Math.round))]).toEqual([46]);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator("aside").getByTestId("sidebar-log").click();
    const desktopDue = page
      .getByTestId("sidebar-log-panel")
      .getByTestId("log-sheet-chip-doses");
    expect((await box(desktopDue, "desktop due row")).height).toBe(46);
  } finally {
    await page.context().close();
  }
});
