import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { type Browser, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { hydratedClick, settledClick } from "./helpers";
import { workerDbPath } from "./worker-env";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_REORDER,
  REORDER_PROFILE,
} from "./fixture-logins";

// The phone dashboard reorder (issue #1891).
//
// The owner reported two things about reordering dashboard cards on a phone: the
// dragged card visibly DISTORTED, and the gesture was an expedition. The second is
// what this file covers, because it is the one a browser can see: below `lg`,
// Customize collapses each widget to a ~48px reorder row (grip, label, eye), so the
// list is short enough that a move is a flick rather than several screens of
// autoscroll. At `lg`+ the in-place cards stay — asserted in e2e/dashboard.spec.ts,
// which drives the same editor at the desktop viewport.
//
// The DISTORTION is deliberately NOT asserted here. It is a transform on an element
// that only exists mid-gesture, and every honest handle on it (sampling the computed
// transform during a synthetic drag) measures the harness more than the app. The
// decision that caused it — `CSS.Transform.toString` vs `CSS.Translate.toString` —
// is pinned in the source instead, by lib/__tests__/sortable-transform-scan.test.ts,
// which was verified to FAIL against the pre-fix consumers.
//
// Fixture hygiene (#868): a SPEC-OWNED login and profile (E2E_LOGIN_REORDER). This
// spec is the only one that writes that profile's dashboard_layout, and it clears
// the key before each test, so --repeat-each iterations start from the registry
// defaults and nothing here can perturb another spec's dashboard.
//
// Viewport note (the #1416 lesson): a context built by `loginAs` via
// `browser.newContext()` does NOT inherit the project's viewport, so the phone
// viewport + hasTouch are restated explicitly.

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };
const DB_PATH = workerDbPath();

function reorderProfileId(): number {
  const handle = new Database(DB_PATH);
  try {
    return (
      handle
        .prepare("SELECT id FROM profiles WHERE name = ?")
        .get(REORDER_PROFILE) as { id: number }
    ).id;
  } finally {
    handle.close();
  }
}

function clearSavedLayout(): void {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare(
        "DELETE FROM profile_settings WHERE profile_id = ? AND key = 'dashboard_layout'"
      )
      .run(reorderProfileId());
  } finally {
    handle.close();
  }
}

function savedLayout(): { order: string[]; hidden: string[] } | null {
  const handle = new Database(DB_PATH);
  try {
    const row = handle
      .prepare(
        "SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'dashboard_layout'"
      )
      .get(reorderProfileId()) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  } finally {
    handle.close();
  }
}

async function openDashboard(browser: Browser): Promise<Page> {
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_REORDER, password: E2E_MEMBER_PASSWORD },
    PHONE
  );
  await page.goto("/");
  return page;
}

async function enterCustomize(page: Page) {
  await hydratedClick(
    page,
    page.getByRole("main").getByRole("button", { name: "Edit dashboard" })
  );
  const editor = page.getByTestId("dashboard-customize");
  await expect(editor).toBeVisible();
  return editor;
}

async function openCustomize(browser: Browser): Promise<Page> {
  const page = await openDashboard(browser);
  await enterCustomize(page);
  return page;
}

// Save, and wait for the SAVE to land — not for the affordance that reappears
// afterwards.
//
// `settledClick`, not a bare click. Save is a Server Action that persists the
// layout and then `revalidatePath("/")`s the DASHBOARD, the heaviest page in the
// app; only once that response arrives does the transition end and the editor
// close. A bare click leaves the very next assertion racing that whole round trip,
// which on a loaded CI runner reliably outruns the default 5s expect timeout —
// while passing locally, where the same round trip takes ~160ms. That is the same
// race, on the same page, that the household-chip switch in e2e/dashboard.spec.ts
// already uses settledClick for. Awaiting the POST is the real signal; raising a
// ceiling would only have moved the failure.
async function saveLayout(page: Page) {
  await settledClick(
    page,
    page.getByRole("button", { name: "Save", exact: true })
  );
  await expect(
    page.getByRole("main").getByRole("button", { name: "Edit dashboard" })
  ).toBeVisible();
}

function widgetIds(testids: string[]): string[] {
  return testids.map((t) => t.replace("dashboard-widget-", ""));
}

test.beforeEach(() => {
  clearSavedLayout();
});

test("below lg, Customize collapses every widget to a compact reorder row", async ({
  browser,
}) => {
  const page = await openCustomize(browser);
  try {
    const editor = page.getByTestId("dashboard-customize");
    await expect(editor).toHaveAttribute("data-presentation", "rows");

    const rows = editor.locator("[data-testid^='dashboard-widget-']");
    const count = await rows.count();
    expect(count, "Customize should list several widgets").toBeGreaterThan(2);

    // Every row carries the three things an order decision needs and nothing
    // else: the grip that lifts it, the label that names it, the eye that hides
    // it. The live widget body is gone — that is the whole point of the row.
    const first = rows.first(); // first-ok: the leading row is the subject — it is the one the drag below lifts
    await expect(first.getByRole("button", { name: /^Drag / })).toBeVisible();
    await expect(
      first.getByRole("button", { name: /^(Hide|Show) / })
    ).toBeVisible();

    // Compact means compact: ~48px each, and the whole list well inside a couple
    // of phone screens rather than the ~1.5-cards-per-screen it replaced. Measured
    // rather than asserted on a class name, since the claim is about the rendered
    // height a thumb has to travel.
    const boxes = await rows.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().height)
    );
    for (const height of boxes) expect(height).toBeLessThanOrEqual(64);
    const listHeight = (await editor.boundingBox())!.height;
    expect(
      listHeight,
      "the compact list should be a flick, not an expedition"
    ).toBeLessThan(844 * 1.5);
  } finally {
    await page.context().close();
  }
});

test("a reorder performed in the compact list survives Save", async ({
  browser,
}) => {
  const page = await openCustomize(browser);
  try {
    const editor = page.getByTestId("dashboard-customize");
    const rows = editor.locator("[data-testid^='dashboard-widget-']");
    const idsBefore = await rows.evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-testid") ?? "")
    );
    expect(idsBefore.length).toBeGreaterThan(3);

    // Lift the top row by its grip and drop it two slots down. Compact rows are a
    // fraction of a screen, so unlike the card editor there is nothing to scroll
    // into view first — which is the improvement being tested.
    const handle = editor
      .getByTestId(idsBefore[0])
      .getByRole("button", { name: /^Drag / });
    const target = editor.getByTestId(idsBefore[2]);
    const from = (await handle.boundingBox())!;
    const to = (await target.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      from.x + from.width / 2,
      from.y + from.height / 2 + 10,
      { steps: 4 }
    );
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
      steps: 12,
    });

    // Mid-gesture the ghost is what the user is carrying — a real element, so the
    // lift is not just a repaint of the list.
    await expect(page.getByTestId("dashboard-drag-ghost")).toBeAttached();
    await page.mouse.up();

    // The gesture is over only once the ghost is gone: dnd-kit keeps the overlay
    // mounted through its drop animation, and a ghost left behind would sit over
    // the list as dead chrome.
    await expect(page.getByTestId("dashboard-drag-ghost")).toHaveCount(0);

    // The list moved: the row that led is no longer leading. How FAR it landed is
    // left to the collision detector (the rows shift under the pointer as it
    // travels), so the assertion is that a move happened, not which slot it chose.
    await expect
      .poll(async () =>
        rows.evaluateAll((els) => els[0]?.getAttribute("data-testid") ?? "")
      )
      .not.toBe(idsBefore[0]);
    const idsAfter = await rows.evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-testid") ?? "")
    );
    expect(idsAfter).not.toEqual(idsBefore);

    // And Save wrote exactly that. This is the assertion that matters: a sortable
    // that shuffles the DOM and persists the old list would pass a DOM-only check
    // and still lose the user's edit.
    await saveLayout(page);
    await expect.poll(() => savedLayout()?.order).toEqual(widgetIds(idsAfter));

    // It also survives a reload — the saved order, not a client state that
    // happened to look right until the page went away.
    await page.reload();
    const reopened = await enterCustomize(page);
    await expect
      .poll(async () =>
        reopened
          .locator("[data-testid^='dashboard-widget-']")
          .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")))
      )
      .toEqual(idsAfter);
  } finally {
    await page.context().close();
  }
});

test("the eye on a compact row still hides — and un-hides — a widget", async ({
  browser,
}) => {
  const page = await openDashboard(browser);
  try {
    // Pick the subject from what the NORMAL dashboard is actually rendering, so
    // the hide has something visible to remove. Customize also lists widgets that
    // have nothing to show right now; hiding one of those would prove only that a
    // JSON blob changed.
    const main = page.getByRole("main");
    const rendered = await main
      .locator("[data-testid^='dashboard-widget-']")
      .evaluateAll((els) =>
        els.map((e) => e.getAttribute("data-testid") ?? "")
      );
    expect(rendered.length).toBeGreaterThan(0);
    const testid = rendered[0];
    const [widgetId] = widgetIds([testid]);

    const editor = await enterCustomize(page);
    const subject = editor.getByTestId(testid);
    await subject.getByRole("button", { name: /^Hide / }).click();
    await expect(subject).toContainText("Hidden");
    await saveLayout(page);

    await expect.poll(() => savedLayout()?.hidden).toContain(widgetId);
    await expect(main.getByTestId(testid)).toHaveCount(0);

    // And back: the same control, on the same row, restores it.
    const reopened = await enterCustomize(page);
    await reopened
      .getByTestId(testid)
      .getByRole("button", { name: /^Show / })
      .click();
    await saveLayout(page);
    await expect.poll(() => savedLayout()?.hidden).not.toContain(widgetId);
    await expect(main.getByTestId(testid)).toBeVisible();
  } finally {
    await page.context().close();
  }
});
