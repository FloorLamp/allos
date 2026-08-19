import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import Database from "better-sqlite3";
import { hydratedClick, settledClick } from "./helpers";
import { loginAs, openCommandPalette } from "./nav";
import {
  E2E_LOGIN_MOBILITY,
  E2E_LOGIN_WEIGHT_QA,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";
import { OFFLINE_CAPTURE_REFUSED_MESSAGE } from "@/lib/offline/queue";

// #3038: no quick-log surface may toast "saved offline" over a write the device
// REFUSED to keep. `enqueue` answers whether the capture was kept, and it is
// `false` wherever there is no IndexedDB at all — private browsing, a
// storage-blocked embedded webview — or the device write gate is closed (#2908,
// pinned by offline-write-gate.spec.ts R-5). Each test here forces the refusal
// the first way, at the tier that renders the copy: the global is masked before
// the page loads, so `enqueue` genuinely runs and genuinely answers false, and
// the surface must
//   • say the ONE shared sentence (OFFLINE_CAPTURE_REFUSED_MESSAGE),
//   • never claim "saved offline",
//   • roll its optimistic state back (no phantom count, chip, or closed sheet),
//   • and leave no pending badge — nothing was queued, so nothing may claim it.
//
// POSITIVE EVIDENCE, per surface: the refused toast can only come from the
// surface's own `!kept` branch, which can only be reached by a tap that ran,
// took the offline path, and was refused — so none of these needs a separate
// non-vacuity control.
//
// The flows covered here are the queue's enumerated consumers (see the constant
// in lib/offline/queue.ts). DoseStatusControl and LogPracticeButton predate this
// spec and keep their refused-capture coverage in offline-write-gate.spec.ts;
// HowAreYouCard is unmounted since the #3097 dashboard cutover (the dashboard's
// mood entry is the quick-entry sheet asserted below), so it has no tier that
// renders it — its refused branch is held by the lib scan test instead.

// Mask IndexedDB before the surface's page loads. `hasIndexedDB()` reads
// `typeof indexedDB`, so every queue write refuses while the rest of the app
// (which degrades to no-op without storage, by design) runs untouched.
async function breakIndexedDB(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", {
      get: () => undefined,
      configurable: true,
    });
  });
}

const SAVED_OFFLINE = /saved offline/i;

async function expectRefusedOnly(page: Page): Promise<void> {
  await expect(page.getByText(OFFLINE_CAPTURE_REFUSED_MESSAGE)).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(SAVED_OFFLINE)).toHaveCount(0);
  // Nothing was queued, so nothing may count itself pending.
  await expect(page.getByTestId("offline-queue-badge")).toHaveCount(0);
}

test("a refused food-serving tap says so and rolls its counts back", async ({
  page,
  context,
}) => {
  await breakIndexedDB(page);
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
  const row = page.getByTestId("food-group-nuts_seeds");
  if (!(await row.isVisible())) {
    await page.getByTestId("food-more-groups-summary").click();
    await expect(row).toBeVisible();
  }
  const count = page.getByTestId("count-nuts_seeds");
  const before = Number((await count.textContent())?.trim() || "0");

  await context.setOffline(true);
  await hydratedClick(page, page.getByTestId("log-nuts_seeds"));

  await expectRefusedOnly(page);
  // The optimistic bump rolled back — the count is the row's own claim.
  await expect(count).toHaveText(String(before));
  await context.setOffline(false);
});

test("refused protein grams say so and roll the total back", async ({
  page,
  context,
}) => {
  await breakIndexedDB(page);
  await page.goto("/nutrition");
  const quickAdd = page.getByTestId("protein-quickadd");
  await expect(quickAdd).toBeVisible();
  const total = page.getByTestId("protein-quickadd-total");
  const before = ((await total.textContent()) ?? "").trim();

  await context.setOffline(true);
  await page.getByTestId("protein-quickadd-input").fill("30");
  await hydratedClick(page, page.getByTestId("protein-quickadd-add"));

  await expectRefusedOnly(page);
  await expect(total).toHaveText(before);
  await context.setOffline(false);
});

test("a refused measurements save says so and keeps the typed values", async ({
  page,
  context,
}) => {
  await breakIndexedDB(page);
  await page.goto("/trends");
  await hydratedClick(page, page.getByTestId("log-measurements-toggle"));
  const form = page.getByTestId("measurements-quick-add");
  await expect(form).toBeVisible();

  await context.setOffline(true);
  const weight = form.getByLabel("Weight", { exact: true });
  await weight.fill("81.4");
  await form.getByRole("button", { name: "Save measurements" }).click();

  await expectRefusedOnly(page);
  // The form did NOT reset — the reading is still there for the retry.
  await expect(weight).toHaveValue("81.4");
  await context.setOffline(false);
});

test("a refused mobility-move tap says so and un-presses the chip", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_MOBILITY,
    password: E2E_MEMBER_PASSWORD,
  });
  const context = page.context();
  try {
    await breakIndexedDB(page);
    await page.goto("/training?tab=overview");
    // A move no other spec logs (offline-mobility owns neck_cars), normalized to
    // OFF online so the offline tap below is the queueable ON tap.
    const chip = page.getByTestId("mobility-move-wrist_cars");
    await expect(chip).toBeVisible();
    if ((await chip.getAttribute("aria-pressed")) === "true") {
      await settledClick(page, chip);
      await expect(chip).toHaveAttribute("aria-pressed", "false");
    }
    const total = page.getByTestId("mobility-move-total");
    const before = ((await total.textContent()) ?? "").trim();

    await context.setOffline(true);
    await hydratedClick(page, chip);

    await expectRefusedOnly(page);
    // The optimistic chip rolled back with the count beside it.
    await expect(chip).toHaveAttribute("aria-pressed", "false");
    await expect(total).toHaveText(before);
  } finally {
    await context.close();
  }
});

test("a refused quick-entry mood tap says so, rolls back, and keeps the sheet open", async ({
  page,
  context,
}) => {
  await breakIndexedDB(page);
  await page.goto("/upcoming");
  // Open the mood sheet ONLINE (its chunk and day data load on open), then cut
  // the network so the tap takes the offline capture path.
  const input = await openCommandPalette(page);
  await input.fill("log mood");
  await page.getByTestId("palette-action-log-mood").click();
  const checkin = page.getByTestId("quick-mood-checkin");
  await expect(checkin).toBeVisible();

  // Tap a face that is not already the stored rating, so the rollback below is
  // observable as its own state change.
  const face2 = checkin.getByTestId("quick-mood-tap-2");
  const face3 = checkin.getByTestId("quick-mood-tap-3");
  const face =
    (await face2.getAttribute("aria-pressed")) === "true" ? face3 : face2;

  await context.setOffline(true);
  await face.click();

  await expectRefusedOnly(page);
  // The face rolled back, and the sheet stayed open — closing it is this
  // surface's claim that the check-in landed.
  await expect(face).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("quick-entry-sheet")).toBeVisible();
  await context.setOffline(false);
  await page.keyboard.press("Escape");
});

test("a refused dashboard weigh-in says so and keeps the typed weight", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_WEIGHT_QA,
    password: E2E_MEMBER_PASSWORD,
  });
  const context = page.context();
  try {
    await breakIndexedDB(page);
    await page.goto("/");
    const input = page.getByTestId("weight-quick-add-input");
    await expect(input).toBeVisible();

    await context.setOffline(true);
    await input.fill("81.4");
    await hydratedClick(page, page.getByTestId("weight-quick-add-save"));

    await expectRefusedOnly(page);
    // No reset — the weigh-in is still in the field for the retry.
    await expect(input).toHaveValue("81.4");
  } finally {
    await context.close();
  }
});

test("a refused workout capture at close says so and claims no sync", async ({
  page,
  context,
}) => {
  const marker = `Refused session ${Date.now()}`; // clock-ok: unique-name suffix for this spec's own session title, never a stored timestamp
  await breakIndexedDB(page);
  await page.goto("/training?tab=log");
  await hydratedClick(
    page,
    page.getByRole("main").getByRole("button", { name: "New activity" })
  );
  await expect(page.getByTestId("activity-form")).toBeVisible();

  // Reception dies after the editor opens; the close-path flush must try the
  // queue — and be refused.
  await context.setOffline(true);
  await page.getByPlaceholder(/What did you do/).fill("Barbell Bench Press");
  await page
    .getByRole("listbox")
    .getByRole("button")
    .filter({ hasText: "Barbell Bench Press" })
    .first() // first-ok: transient combobox list this spec just opened by typing; the first filtered match is the intended option
    .click();
  await page
    .getByTestId("next-set-card")
    .getByRole("button", { name: "Use" })
    .click();
  await expect(page.getByTestId("set1-weight")).toHaveValue(/^\d/);
  await page.getByLabel("Activity name").fill(marker);

  await page.keyboard.press("Escape");

  await expectRefusedOnly(page);
  // And the durable truth agrees with the sentence: no row landed.
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const rows = db
      .prepare("SELECT id FROM activities WHERE title = ?")
      .all(marker);
    expect(rows).toEqual([]);
  } finally {
    db.close();
  }
  await context.setOffline(false);
});
