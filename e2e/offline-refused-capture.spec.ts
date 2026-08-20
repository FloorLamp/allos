import { test, expect } from "./fixtures";
import { closeEditor, openFact } from "./intake-form-helpers";
import type { Page } from "@playwright/test";
import Database from "better-sqlite3";
import { hydratedClick, openDashboardAll, settledClick } from "./helpers";
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
// in lib/offline/queue.ts). LogPracticeButton predates this spec and keeps its
// refused-capture coverage in offline-write-gate.spec.ts R-5 (the gate-closed
// cause); DoseStatusControl's toast is covered there too, and the LAST test here
// pins the half only this spec observes — its ledger settling the refusal as
// ready-again rather than a post-"success" cooldown.

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

// The highest activity id profile 1 currently owns — the fixture watermark for the
// workout test below, which cannot name the row it will create.
function maxActivityId(): number {
  const db = new Database(workerDbPath(), { readonly: true });
  try {
    db.pragma("busy_timeout = 5000");
    const row = db
      .prepare("SELECT MAX(id) AS id FROM activities WHERE profile_id = 1")
      .get() as { id: number | null };
    return row.id ?? 0;
  } finally {
    db.close();
  }
}

// Delete every profile-1 activity created after `since`, once the reconnect flush
// has had its chance to land one (#3163).
//
// WHY A WATERMARK AND NOT THE TITLE. The row this test leaves behind is written by
// the RECONNECT, after the test's own "no row landed" assertion has already run and
// passed — so at deletion time the title may not be the marker yet, and matching on
// it deletes nothing. The id watermark names "whatever this test caused", which is
// the thing that must not outlive it. Playwright runs a worker's tests serially
// against that worker's own database, so nothing else can be writing profile-1
// activities in this window.
//
// The poll is what makes the cleanup deterministic rather than a race: it waits for
// the write to appear before removing it, so the test cannot delete first and have
// the row land afterwards. A window that stays empty is fine — nothing was created,
// nothing to drop.
async function dropActivitiesCreatedAfter(since: number): Promise<void> {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const created = db.prepare(
      "SELECT id FROM activities WHERE profile_id = 1 AND id > ?"
    );
    for (let attempt = 0; attempt < 40; attempt++) {
      if (created.all(since).length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    db.prepare("DELETE FROM activities WHERE profile_id = 1 AND id > ?").run(
      since
    );
  } finally {
    db.close();
  }
}

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

test("a refused measurements save says so and claims nothing", async ({
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
  // The form stays open for the retry, with no success toast and no inline
  // error contradicting the sentence. (The fields themselves clear either way:
  // React resets a form after its action, refused or not.)
  await expect(form).toBeVisible();
  await expect(page.getByText(/Measurements saved/)).toHaveCount(0);
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
    await context.setOffline(false);
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

test("a refused dashboard weigh-in says so and claims nothing", async ({
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
    await openDashboardAll(page);
    const input = page.getByTestId("weight-quick-add-input");
    await expect(input).toBeVisible();

    await context.setOffline(true);
    await input.fill("81.4");
    await hydratedClick(page, page.getByTestId("weight-quick-add-save"));

    await expectRefusedOnly(page);
    // No success claim of either kind — online's "Entry saved" or the offline
    // queue's promise.
    await expect(page.getByText("Entry saved")).toHaveCount(0);
    await context.setOffline(false);
  } finally {
    await context.close();
  }
});

test("a refused workout capture at close says so and claims no sync", async ({
  page,
  context,
}) => {
  const marker = `Refused session ${Date.now()}`; // clock-ok: unique-name suffix for this spec's own session title, never a stored timestamp
  // FIXTURE OWNERSHIP (#3163). Closing the editor here leaves a STARTED, UNENDED
  // session on profile 1 — which is the app working as designed (an abandoned live
  // draft is kept, not discarded, so the dock can offer "finish or discard"), but
  // profile 1 is shared with every other spec on this worker. Left behind, workout
  // presence reads that draft as an ACTIVE workout and the app-wide dock haunts
  // every later page, which is exactly how offline-set-log's dock assertion started
  // failing whenever the shard plan put it after this test. The draft is this
  // test's, so this test disposes of it.
  //
  // FROM A `finally`, not from the end of the body (#3173). The watermark is taken
  // before the first interaction and the disposal is the block's only exit, so a
  // failure ANYWHERE after the editor opens still reconnects and still drops what
  // this test caused. The end-of-body version shipped in #3169 skipped both on an
  // early failure, which is precisely the run where a draft is most likely to be
  // sitting there — the standing guard in e2e/shared-profile-guard.ts is the
  // backstop, and this is the disposal it should never have to be.
  const activityWatermark = maxActivityId();
  try {
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
    // And the durable truth agrees with the sentence: no row landed WHILE OFFLINE.
    // (The reconnect below is a different moment — see the teardown note.)
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
  } finally {
    // Reconnect FIRST: the close-path flush the editor queued only lands once the
    // page is back online, and the drop below waits for exactly that write.
    await context.setOffline(false);
    await dropActivitiesCreatedAfter(activityWatermark);
  }
});

test("a refused dose tap settles READY AGAIN — the retry it asks for is not absorbed", async ({
  page,
  context,
}) => {
  // THE LEDGER HALF of DoseStatusControl's refusal, which R-5's sibling (the
  // toast, offline-write-gate.spec.ts) cannot see. A refused queue settles the
  // ledger as "nothing" — rollback, phase ready — so the very retry the sentence
  // asks for goes through and is refused AGAIN, visibly. The mutant this pins
  // (it shipped green through every other test): settling the refusal as "wrote"
  // puts the clear→taken transition into the 2s post-"success" cooldown, which
  // silently absorbs the second tap — one sentence, then a control that ignores
  // the person following its own instruction (and a settle animation plus a
  // snapshot dirty-mark for a write that never happened). Two taps, two
  // sentences, is the observable difference.
  //
  // Fixture-owned supplement (#868, the offline-dose-confirm pattern): a
  // uniquely-named Morning dose this test creates and deletes, so it never
  // touches the seeded intake rows other specs count on.
  const name = `Refused Dose Zinc ${Date.now()}`; // clock-ok: unique fixture-name suffix, never a stored timestamp
  await breakIndexedDB(page);
  await page.goto("/nutrition?tab=supplements");
  await page.getByTestId("supplement-add-toggle").click();
  const addCard = page.getByRole("dialog", { name: "Add supplement" });
  await addCard.getByLabel("Name").fill(name);
  const doseEditor1 = await openFact(page, "dose", addCard);
  await doseEditor1.getByLabel("Amount").first().fill("10 mg"); // first-ok: the add-supplement form's own first dose-row field (deterministic within one form render, not a seeded list)
  await doseEditor1.getByLabel("Time of day").first().selectOption("Morning"); // first-ok: the add-supplement form's own first dose-row field (deterministic within one form render, not a seeded list)
  await closeEditor(page, addCard);
  await addCard.getByRole("button", { name: "Add", exact: true }).click();
  await expect(addCard).toHaveCount(0);
  const row = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Morning" }) })
    .locator("div.card")
    .filter({ hasText: name });
  const take = row.getByTestId("dose-take");
  await expect(take).toBeVisible();

  await context.setOffline(true);
  const sentence = page.getByText(OFFLINE_CAPTURE_REFUSED_MESSAGE);
  await hydratedClick(page, take);
  await expect(sentence).toHaveCount(1);
  // The optimistic "taken" rolled back the moment the queue refused…
  await expect(take).toHaveAttribute("aria-pressed", "false");
  // …and the control is READY, not cooling down: the immediate second tap runs,
  // is refused, and says so again. Keyless error toasts stack, so the count is
  // the proof the tap was not absorbed. (Well inside the mutant's 2s window:
  // the first sentence renders on the settle's own frame, with no network and
  // no storage between tap and answer.)
  await take.click();
  await expect(sentence).toHaveCount(2);
  await expect(take).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText(SAVED_OFFLINE)).toHaveCount(0);
  await expect(page.getByTestId("offline-queue-badge")).toHaveCount(0);
  await context.setOffline(false);

  // Cleanup: the fixture supplement goes with the test.
  await hydratedClick(
    page,
    row.getByRole("button", { name: "Supplement actions" })
  );
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator("div.card").filter({ hasText: name })).toHaveCount(
    0
  );
});
