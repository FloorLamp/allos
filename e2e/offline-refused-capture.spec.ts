import { test, expect } from "./fixtures";
import { closeEditor, openFact } from "./intake-form-helpers";
import type { Page } from "@playwright/test";
import Database from "better-sqlite3";
import {
  appContent,
  comboboxRows,
  expandLedgerDueGroups,
  hydratedClick,
  ledgerDoseRow,
  openFoodAdd,
  settledClick,
  settledFill,
} from "./helpers";
import { openLogSheet, showLogRow } from "./log-sheet-helpers";
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

// Force storage failures inside the real transaction. A second-put exception must
// abort the first put too; returning a refusal alone does not roll IndexedDB back.
async function failMeasurementBatch(
  page: Page,
  failure: "first put" | "second put" | "request error" | "transaction abort"
): Promise<void> {
  await page.addInitScript((failure) => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey
    ): IDBRequest<IDBValidKey> {
      const flow = (value as { flow?: string } | null)?.flow;
      if (
        (failure === "first put" && flow === "body-metric") ||
        (failure === "second put" && flow === "vitals")
      ) {
        (
          window as Window & { measurementFaultReached?: string }
        ).measurementFaultReached = failure;
        throw new DOMException("forced by a spec", "QuotaExceededError");
      }
      const request = put.call(this, value as never, key);
      if (flow === "vitals") {
        (
          window as Window & { measurementFaultReached?: string }
        ).measurementFaultReached = failure;
        if (failure === "request error") {
          // The put and duplicate add are real requests. ConstraintError aborts
          // asynchronously after both intent puts have been scheduled.
          this.add(value);
        } else if (failure === "transaction abort") {
          this.transaction.abort();
        }
      }
      return request;
    };
  }, failure);
}

// Install only after the form is ready. The capture token is read first; a gate
// mutation then takes the transaction lock before the queue writer can start.
async function changeGateBeforeBatch(
  page: Page,
  change: "profile" | "logout" | "reopen-same-session" | "reopen-new-session"
): Promise<void> {
  await page.evaluate((change) => {
    const transaction = IDBDatabase.prototype.transaction;
    let done = false;
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      stores: string | string[],
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions
    ): IDBTransaction {
      if (
        !done &&
        mode === "readwrite" &&
        Array.from(typeof stores === "string" ? [stores] : stores).includes(
          "intents"
        )
      ) {
        done = true;
        const gateTx = transaction.call(this, ["meta", "intents"], "readwrite");
        (
          window as Window & { measurementGateChanged?: Promise<boolean> }
        ).measurementGateChanged = new Promise((resolve, reject) => {
          gateTx.oncomplete = () => resolve(true);
          gateTx.onabort = () => reject(gateTx.error);
        });
        if (change !== "profile") gateTx.objectStore("intents").clear();
        const meta = gateTx.objectStore("meta");
        const read = meta.get("device-writes");
        read.onsuccess = () => {
          const gate = (read.result as Record<string, unknown>) ?? {};
          meta.put({
            ...gate,
            key: "device-writes",
            generation: Number(gate.generation ?? 0) + 1,
            sessionClosed: change === "logout",
            ...(change === "reopen-new-session"
              ? { sessionKey: "e2e-new-session-after-wipe" }
              : {}),
          });
        };
      }
      return transaction.call(this, stores, mode, options);
    };
  }, change);
}

// The actual capture read sees a closed gate. Reopen with the same generation
// immediately after that read, before any fallback write can acquire its lock.
async function reopenAfterClosedCapture(
  page: Page,
  newSession: boolean
): Promise<void> {
  await page.evaluate(async (newSession) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("allos-offline", 5);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("meta", "readwrite");
      const meta = tx.objectStore("meta");
      const read = meta.get("device-writes");
      read.onsuccess = () =>
        meta.put({ ...read.result, key: "device-writes", sessionClosed: true });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    const get = IDBObjectStore.prototype.get;
    let done = false;
    IDBObjectStore.prototype.get = function (
      this: IDBObjectStore,
      key: IDBValidKey | IDBKeyRange
    ): IDBRequest {
      const request = get.call(this, key);
      if (
        !done &&
        this.name === "meta" &&
        key === "device-writes" &&
        this.transaction.mode === "readonly"
      ) {
        done = true;
        request.addEventListener("success", () => {
          const tx = db.transaction("meta", "readwrite");
          tx.objectStore("meta").put({
            ...request.result,
            sessionClosed: false,
            ...(newSession
              ? { sessionKey: "e2e-new-session-after-closed-capture" }
              : {}),
          });
          (
            window as Window & { measurementGateReopened?: Promise<boolean> }
          ).measurementGateReopened = new Promise((resolve, reject) => {
            tx.oncomplete = () => {
              db.close();
              resolve(true);
            };
            tx.onabort = () => reject(tx.error);
          });
        });
      }
      return request;
    };
  }, newSession);
}

// A reader scheduled after the first put waits for the complete batch. With the
// former two-enqueue implementation this reader would observe just the body row.
async function observeMeasurementCommit(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey
    ): IDBRequest<IDBValidKey> {
      const request = put.call(this, value as never, key);
      if ((value as { flow?: string } | null)?.flow === "body-metric") {
        const read = this.transaction.db
          .transaction("intents", "readonly")
          .objectStore("intents")
          .getAll();
        (
          window as Window & { measurementBatchRead?: Promise<number> }
        ).measurementBatchRead = new Promise((resolve, reject) => {
          read.onsuccess = () => resolve(read.result.length);
          read.onerror = () => reject(read.error);
        });
      }
      return request;
    };
  });
}

// How many intents the device is actually holding. The badge answers the same question
// for the cases where a queue exists to render one, but a wipe leaves no provider state
// to disagree with — so the store itself is asked.
async function queuedIntentCount(page: Page, flow?: string): Promise<number> {
  return page.evaluate(
    (flow) =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open("allos-offline", 5);
        open.onsuccess = () => {
          const db = open.result;
          const req = db
            .transaction("intents", "readonly")
            .objectStore("intents")
            .getAll();
          req.onsuccess = () => {
            const rows = req.result as { flow: string }[];
            resolve(
              flow
                ? rows.filter((row) => row.flow === flow).length
                : rows.length
            );
            db.close();
          };
        };
        open.onerror = () => resolve(-1);
      }),
    flow
  );
}

// Open one of the quick-add form's collapsed groups. The disclosure keeps closed
// fields in the DOM (they still post), so a fill has to open the group first.
async function openMeasurementGroup(
  page: Page,
  group: "body" | "vitals" | "sleep"
): Promise<void> {
  const toggle = page.getByTestId(`measurements-group-${group}-toggle`);
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await hydratedClick(page, toggle);
  }
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

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

// Every profile-1 activity created after `since` — "whatever this test caused".
//
// WHY A WATERMARK AND NOT THE TITLE. The row this is watching for is written by a
// flush the test never asked for, so at read time it may not carry the marker yet
// and matching on the title would see nothing. Playwright runs a worker's tests
// serially against that worker's own database, so nothing else can be writing
// profile-1 activities in this window.
function activitiesCreatedAfter(
  since: number
): { id: number; title: string; start_time: string | null }[] {
  const db = new Database(workerDbPath(), { readonly: true });
  try {
    db.pragma("busy_timeout = 5000");
    return db
      .prepare(
        "SELECT id, title, start_time FROM activities WHERE profile_id = 1 AND id > ?"
      )
      .all(since) as { id: number; title: string; start_time: string | null }[];
  } finally {
    db.close();
  }
}

// The BACKSTOP, called from a `finally` so a RED still leaves the shared profile
// clean for the rest of the worker (#3163/#3173). It no longer polls: the
// assertion in the test body owns the wait now, so by the time this runs the
// window has already closed and there is nothing left to wait for.
function dropActivitiesCreatedAfter(since: number): void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    db.prepare("DELETE FROM activities WHERE profile_id = 1 AND id > ?").run(
      since
    );
  } finally {
    db.close();
  }
}

// HOW LONG A LANDED ROW GETS TO SHOW UP after the reconnect, and the number is a
// measurement: on the pre-fix tree the close-path flush fires ~20 attempts in ~80ms
// and the row appeared within 250ms of `setOffline(false)` — the first tick of the
// 250ms poll #3169 used for its disposal caught it every time. 3s is that with an
// order of magnitude of headroom for a loaded box.
//
// THE WAIT IS ON THE FAR SIDE OF THE RECONNECT, and that is the whole design. A
// dwell BEFORE reconnecting makes this assertion pass on the broken tree: the burst
// dies while the link is still down and there is nothing left in flight to catch it
// coming back (measured on the pre-fix tree — 5s dwell, then 10s of polling, no
// row). So the patience that would look like care here is the one thing that would
// blind the guard. Waiting longer AFTER the reconnect only makes it stricter.
const REFUSED_FLUSH_SETTLE_MS = 3_000;

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
  await openFoodAdd(page);
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
  await openFoodAdd(page);
  const quickAdd = page.getByTestId("protein-quickadd");
  await expect(quickAdd).toBeVisible();
  const total = page.getByTestId("protein-quickadd-total");
  const before = ((await total.textContent()) ?? "").trim();

  await context.setOffline(true);
  await settledFill(page, page.getByTestId("protein-quickadd-input"), "30");
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
  // error contradicting the sentence.
  await expect(form).toBeVisible();
  await expect(page.getByText(/Measurements saved/)).toHaveCount(0);
  await context.setOffline(false);
});

// #3118 permits atomic capture. Either failure keeps the entire sitting ready
// to retry; no queue reader or user should see a saved body with refused vitals.
for (const failure of [
  "first put",
  "second put",
  "request error",
  "transaction abort",
] as const) {
  test(`a measurements ${failure} failure retains the whole sitting and queues neither half`, async ({
    page,
    context,
  }) => {
    await failMeasurementBatch(page, failure);
    await page.goto("/trends");
    await hydratedClick(page, page.getByTestId("log-measurements-toggle"));
    const form = page.getByTestId("measurements-quick-add");
    await expect(form).toBeVisible();
    await openMeasurementGroup(page, "body");
    await openMeasurementGroup(page, "vitals");
    await openMeasurementGroup(page, "sleep");

    await context.setOffline(true);
    const body = [
      ["Weight", "81.4"],
      ["Body Fat", "22.5"],
      ["Resting Heart Rate", "61"],
      ["Notes", "after breakfast"],
    ] as const;
    for (const [label, value] of body)
      await form.getByLabel(label, { exact: true }).fill(value);
    const vitals =
      "systolic=118 diastolic=76 glucose=5.6 spo2=98 temperature=98.6 sleep_hours=7.5 bed_time=22:30 wake_time=06:30 hrv=42 respiratory_rate=14 peak_flow=450"
        .split(" ")
        .map((pair) => pair.split("=") as [string, string]);
    for (const [name, value] of vitals) {
      if (name === "bed_time" || name === "wake_time") continue;
      await form.locator(`[name="${name}"]`).fill(value);
    }
    await form.getByLabel("Bed time", { exact: true }).fill("22:30");
    await form.getByLabel("Wake time", { exact: true }).fill("06:30");
    await form.getByLabel("Glucose unit").selectOption("mmol/L");
    await form.getByTestId("m-time").fill("08:15");
    await form.getByRole("button", { name: "Save measurements" }).click();

    await expectRefusedOnly(page);
    expect(
      await page.evaluate(
        () =>
          (window as Window & { measurementFaultReached?: string })
            .measurementFaultReached
      ),
      "the intended storage fault was reached"
    ).toBe(failure);
    expect(await queuedIntentCount(page), "atomic batch rolled back").toBe(0);
    for (const [label, value] of body)
      await expect(form.getByLabel(label, { exact: true })).toHaveValue(value);
    for (const [name, value] of vitals)
      await expect(form.locator(`[name="${name}"]`)).toHaveValue(value);
    await expect(form.getByLabel("Glucose unit")).toHaveValue("mmol/L");
    await expect(form.getByTestId("m-time")).toHaveValue("08:15");
    await context.setOffline(false);
  });
}

for (const change of [
  "profile",
  "logout",
  "reopen-same-session",
  "reopen-new-session",
  "closed-capture-reopen-same-session",
  "closed-capture-reopen-new-session",
] as const) {
  test(`a measurements save across ${change} retains both halves and queues neither`, async ({
    page,
    context,
  }) => {
    await page.goto("/trends");
    await hydratedClick(page, page.getByTestId("log-measurements-toggle"));
    const form = page.getByTestId("measurements-quick-add");
    await expect(form).toBeVisible();
    await openMeasurementGroup(page, "body");
    await openMeasurementGroup(page, "vitals");
    await context.setOffline(true);
    if (
      change === "closed-capture-reopen-same-session" ||
      change === "closed-capture-reopen-new-session"
    ) {
      await reopenAfterClosedCapture(
        page,
        change === "closed-capture-reopen-new-session"
      );
    } else {
      await changeGateBeforeBatch(page, change);
    }
    await form.getByLabel("Weight", { exact: true }).fill("81.4");
    await form.getByLabel("Systolic", { exact: true }).fill("118");
    await form.getByLabel("Diastolic", { exact: true }).fill("76");
    await form.getByRole("button", { name: "Save measurements" }).click();

    await expectRefusedOnly(page);
    if (
      change === "closed-capture-reopen-same-session" ||
      change === "closed-capture-reopen-new-session"
    ) {
      expect(
        await page.evaluate(
          () =>
            (window as Window & { measurementGateReopened?: Promise<boolean> })
              .measurementGateReopened
        ),
        "the gate really reopened after the closed capture read"
      ).toBe(true);
    } else {
      expect(
        await page.evaluate(
          () =>
            (window as Window & { measurementGateChanged?: Promise<boolean> })
              .measurementGateChanged
        ),
        "the gate mutation committed before the writer"
      ).toBe(true);
    }
    expect(await queuedIntentCount(page), "stale capture refused").toBe(0);
    await expect(form.getByLabel("Weight", { exact: true })).toHaveValue(
      "81.4"
    );
    await expect(form.getByLabel("Systolic", { exact: true })).toHaveValue(
      "118"
    );
    await expect(form.getByLabel("Diastolic", { exact: true })).toHaveValue(
      "76"
    );
    await context.setOffline(false);
  });
}

test("a measurements batch becomes visible together and clears the saved sitting", async ({
  page,
  context,
}) => {
  await observeMeasurementCommit(page);
  await page.goto("/trends");
  await hydratedClick(
    page,
    appContent(page).getByTestId("log-measurements-toggle")
  );
  const form = appContent(page).getByTestId("measurements-quick-add");
  await openMeasurementGroup(page, "body");
  await openMeasurementGroup(page, "vitals");
  await context.setOffline(true);
  await form.getByLabel("Weight", { exact: true }).fill("81.4");
  await form.getByLabel("Systolic", { exact: true }).fill("118");
  await form.getByLabel("Diastolic", { exact: true }).fill("76");
  await form.getByRole("button", { name: "Save measurements" }).click();

  await expect(page.getByTestId("offline-queue-badge")).toHaveText(
    /2 queued offline/
  );
  expect(
    await page.evaluate(
      () =>
        (window as Window & { measurementBatchRead?: Promise<number> })
          .measurementBatchRead
    ),
    "reader scheduled after the first put sees the complete pair"
  ).toBe(2);
  expect(await queuedIntentCount(page, "body-metric")).toBe(1);
  expect(await queuedIntentCount(page, "vitals")).toBe(1);
  await expect(form.getByLabel("Weight", { exact: true })).toHaveValue("");
  await expect(form.getByLabel("Systolic", { exact: true })).toHaveValue("");
  await expect(form.getByLabel("Diastolic", { exact: true })).toHaveValue("");
  // Keep successful fixture intents from replaying into the shared profile.
  await page.route("**/api/offline-replay", (route) => route.abort());
  await context.setOffline(false);
  await expect(page.getByTestId("offline-queue-badge")).toHaveText(
    /2 queued offline/
  );
});

test("a refused vitals-only sitting reports the shared refusal", async ({
  page,
  context,
}) => {
  await breakIndexedDB(page);
  await page.goto("/trends");
  await hydratedClick(page, page.getByTestId("log-measurements-toggle"));
  const form = page.getByTestId("measurements-quick-add");
  await expect(form).toBeVisible();
  await openMeasurementGroup(page, "vitals");

  await context.setOffline(true);
  await form.getByLabel("Systolic", { exact: true }).fill("118");
  await form.getByLabel("Diastolic", { exact: true }).fill("76");
  await form.getByRole("button", { name: "Save measurements" }).click();

  await expectRefusedOnly(page);
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
  const checkin = page.getByTestId("mood-form");
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

test("a refused quick weigh-in says so and claims nothing", async ({
  browser,
}) => {
  // #3366 retired the dashboard tail's own weigh-in card; the quick logger is the
  // app's one quick-write surface, and its measurements form is the same
  // `enqueue`-then-post path the card used. The sheet is reached from the dock puck,
  // which is phone-only chrome.
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_WEIGHT_QA, password: E2E_MEMBER_PASSWORD },
    { viewport: { width: 390, height: 844 }, hasTouch: true }
  );
  const context = page.context();
  try {
    await breakIndexedDB(page);
    await page.goto("/");
    const sheet = await openLogSheet(page);
    const row = await showLogRow(sheet, "log-measurements");
    await row.click();
    const overlay = page.getByTestId("quick-entry-sheet");
    const form = overlay.getByTestId("measurements-quick-add");
    await expect(form).toBeVisible();
    await openMeasurementGroup(page, "body");
    const input = overlay.locator("#m-weight");
    await expect(input).toBeVisible();

    await context.setOffline(true);
    await input.fill("81.4");
    await hydratedClick(
      page,
      overlay.getByRole("button", { name: "Save measurements" })
    );

    await expectRefusedOnly(page);
    // No success claim of either kind — the online toast or the offline queue's
    // promise.
    await expect(page.getByText("Measurements saved")).toHaveCount(0);
    await context.setOffline(false);
  } finally {
    await context.close();
  }
});

test("a refused workout capture at close says so and claims no sync", async ({
  page,
  context,
}) => {
  const marker = `Refused session ${Date.now()}`; // eslint-disable-line no-restricted-properties -- clock-ok: unique-name suffix for this spec's own session title, never a stored timestamp
  // THE SENTENCE HAS TO SURVIVE THE RECONNECT (#3170), which is the half this test
  // used to leave open. It asserted "no row landed" WHILE OFFLINE — true, and true
  // of the broken tree too: the close path fires ~20 attempts in ~80ms and the
  // unmount flush fires one more, so a link that came back inside that burst let one
  // of them CREATE the session. The person was told the entry wasn't saved and a
  // started, unended row turned up on their profile seconds later (#3163 found that
  // row and read it as the editor's deliberate live-draft retention; it is not —
  // this editor is opened by `openCreate`, which clears `liveCleanupPendingRef`, so
  // ActivityEditorProvider's empty-only discard never runs here).
  //
  // Nothing catches the person if it goes the other way, either: the refusal's own
  // cause is that IndexedDB is unavailable, and the #1699 local draft lives in that
  // same IndexedDB (lib/offline/draft-db.ts), so no draft was ever written and no
  // dock has anything to offer. The fix is therefore the flush, not the copy — the
  // first refusal ends that close's attempts — and this test now pins it on BOTH
  // sides of the reconnect.
  //
  // THE GREEN AND THE RED ARE NOT SYMMETRIC, and a reviewer re-deriving this from
  // one run needs to know which is which. The green is TIMING-INDEPENDENT: with the
  // fix in place no attempt is MADE after the refusal, so there is no race left to
  // lose and this cannot rot into a flake. The RED is racy — reverting the fix and
  // running this five times gave 4 failed / 1 passed, the green one being the run
  // where the ~80ms burst had already died before the reconnect landed. That is a
  // property of the DEFECT, not a weakness of the guard, and it is why a single
  // pre-fix run is not evidence the guard is broken. Widening the burst with
  // delayed route aborts would buy 5-of-5 by replacing real offline emulation with
  // a parallel harness; the one-in-five was judged the better trade (#3170).
  //
  // FIXTURE OWNERSHIP, still (#3163/#3173). Profile 1 is shared with every other
  // spec on this worker, and a started-but-unended row there is what workout
  // presence reads as an ACTIVE workout — the app-wide dock then haunts every later
  // page, which is how offline-set-log's dock assertion started failing whenever the
  // shard plan seated it after this test. The watermark is taken before the first
  // interaction and the disposal runs from a `finally`, so a failure ANYWHERE after
  // the editor opens — including this test's own new assertion going red — still
  // drops what it caused.
  const activityWatermark = maxActivityId();
  try {
    await breakIndexedDB(page);
    await page.goto("/training?tab=log");
    await hydratedClick(
      page,
      page.getByRole("main").getByRole("button", { name: "Add activity" })
    );
    await expect(page.getByTestId("activity-form")).toBeVisible();

    // Reception dies after the editor opens; the close-path flush must try the
    // queue — and be refused.
    await context.setOffline(true);
    await page.getByPlaceholder(/What did you do/).fill("Barbell Bench Press");
    // eslint-disable-next-line no-restricted-properties -- first-ok: transient combobox list this spec just opened by typing; the first filtered match is the intended option
    await comboboxRows(page)
      .filter({ hasText: "Barbell Bench Press" })
      .first()
      .click();
    await page
      .getByTestId("next-set-card")
      .getByRole("button", { name: "Use" })
      .click();
    await expect(page.getByTestId("set1-weight")).toHaveValue(/^\d/);
    await page.getByLabel("Activity name").fill(marker);

    await page.keyboard.press("Escape");

    await expectRefusedOnly(page);
    // MOMENT ONE — the sentence as it is read: no row landed while offline.
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

    // MOMENT TWO — the same sentence, after the link comes back. Reconnecting
    // IMMEDIATELY is what makes this able to fail (see REFUSED_FLUSH_SETTLE_MS):
    // it is the timing under which the broken tree lands the row.
    await context.setOffline(false);
    await page.waitForTimeout(REFUSED_FLUSH_SETTLE_MS); // eslint-disable-line no-restricted-properties -- waitfortimeout-ok: the assertion IS an absence — no attempt from a close that was already refused may write in the window one would have written in
    expect(
      activitiesCreatedAfter(activityWatermark),
      "a refused close wrote a session after the reconnect, contradicting the sentence the person was shown"
    ).toEqual([]);
    // NOT VACUOUS: the refused sentence above can only come from the surface's own
    // `!kept` branch, so reaching this line at all proves the close path ran and was
    // refused. An empty result here is the absence of a write, not the absence of a
    // close.
  } finally {
    // Reconnect (a no-op on the happy path — the body already did) so an earlier
    // failure cannot leave the context offline for the next test, then drop
    // whatever this test caused.
    await context.setOffline(false);
    dropActivitiesCreatedAfter(activityWatermark);
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
  const name = `Refused Dose Zinc ${Date.now()}`; // eslint-disable-line no-restricted-properties -- clock-ok: unique fixture-name suffix, never a stored timestamp
  await breakIndexedDB(page);
  await page.goto("/nutrition?tab=supplements");
  await page.getByTestId("supplement-add-toggle").click();
  const addCard = page.getByRole("dialog", { name: "Add supplement" });
  await addCard.getByLabel("Name").fill(name);
  const doseEditor1 = await openFact(page, "dose", addCard);
  await hydratedClick(
    page,
    doseEditor1.getByRole("button", { name: "Add dose", exact: true })
  );
  await doseEditor1.getByLabel("Amount").first().fill("10 mg"); // eslint-disable-line no-restricted-properties -- first-ok: the add-supplement form's own first dose-row field (deterministic within one form render, not a seeded list)
  await doseEditor1.getByLabel("Time of day").first().selectOption("Morning"); // eslint-disable-line no-restricted-properties -- first-ok: the add-supplement form's own first dose-row field (deterministic within one form render, not a seeded list)
  await closeEditor(page, addCard);
  await addCard.getByRole("button", { name: "Add", exact: true }).click();
  await expect(addCard).toHaveCount(0);
  // THE TAP IS THE DAY'S, so it happens where the day is stated (#3987): the
  // Supplements tab is where this item was created, the Day ledger is where its dose
  // is owed. The management row below is reached again for cleanup.
  await page.goto("/nutrition?tab=food");
  await expandLedgerDueGroups(page);
  const take = ledgerDoseRow(page, name).getByTestId("dose-take");
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

  // Cleanup: the fixture supplement goes with the test, from the tab that owns it.
  await page.goto("/nutrition?tab=supplements");
  const row = page
    .getByTestId("supplement-stack")
    .getByTestId("supplement-row")
    .filter({ hasText: name });
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
