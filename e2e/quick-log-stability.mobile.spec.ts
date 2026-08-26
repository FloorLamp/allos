import type { Locator, Page, Response } from "@playwright/test";
import Database from "better-sqlite3";
import { test, expect } from "./fixtures";
import { openLogSheet } from "./log-sheet-helpers";
import {
  E2E_LOGIN_SHELL,
  SHELL_DOSE_ITEM,
  SHELL_PROFILE,
} from "./logins/metrics";
import { E2E_MEMBER_PASSWORD } from "./logins/shared";
import { settledAfterAnimation, settledBoxes } from "./helpers";
import { loginAs } from "./nav";
import { frozenNow, workerDbPath } from "./worker-env";
import { TAP_FLOOR_PX } from "@/lib/tap-floor-tokens";

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

function expectSameGeometry(
  actual: Awaited<ReturnType<typeof sheetGeometry>>,
  expected: Awaited<ReturnType<typeof sheetGeometry>>
) {
  expect(
    Math.abs(actual.panelHeight - expected.panelHeight)
  ).toBeLessThanOrEqual(PX_EPSILON);
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
    for (let index = 0; index < 4; index += 1) {
      const optionBox = await box(options.nth(index), `390px segment ${index}`);
      expect(optionBox.height + PX_EPSILON).toBeGreaterThanOrEqual(
        TAP_FLOOR_PX
      );
    }
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
    const reservedBefore = await box(
      sheet.getByTestId("log-sheet-context-slot"),
      "reserved context slot"
    );

    release();
    await expect(sheet.getByTestId("log-sheet-context")).toBeVisible();
    expectSameGeometry(await sheetGeometry(sheet), before);
    const reservedAfter = await box(
      sheet.getByTestId("log-sheet-context-slot"),
      "filled context slot"
    );
    expect(
      Math.abs(reservedAfter.height - reservedBefore.height)
    ).toBeLessThanOrEqual(PX_EPSILON);
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
    const reservedBefore = await box(reserve, "empty context reserve");
    await expect(reserve).toHaveAttribute("data-context-state", "loading");

    release();
    await expect(reserve).toHaveAttribute("data-context-state", "ready");
    expectSameGeometry(await sheetGeometry(sheet), before);
    const reservedAfter = await box(reserve, "empty resolved context reserve");
    expect(
      Math.abs(reservedAfter.height - reservedBefore.height)
    ).toBeLessThanOrEqual(PX_EPSILON);
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
    const reservedBefore = await box(reserve, "failed context reserve");
    release();
    await response;
    await expect(reserve).toHaveAttribute("data-context-state", "failed");

    expectSameGeometry(await sheetGeometry(sheet), before);
    const reservedAfter = await box(
      reserve,
      "failed context reserve after response"
    );
    expect(
      Math.abs(reservedAfter.height - reservedBefore.height)
    ).toBeLessThanOrEqual(PX_EPSILON);
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
