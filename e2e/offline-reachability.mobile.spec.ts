import { test, expect } from "./fixtures";
import { type BrowserContext, type Locator, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { awaitHydrated, openMeasurementGroup } from "./helpers";
import { openLogSheet, showLogRow } from "./log-sheet-helpers";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_SHELL,
  E2E_LOGIN_WEIGHT_QA,
  SHELL_DOSE_ITEM,
  SHELL_PRACTICE,
  SHELL_PROFILE,
} from "./fixture-logins";
import { frozenNow, workerDbPath } from "./worker-env";
import { LOG_MANIFEST } from "@/lib/log-manifest";
import { SNAPSHOT_KINDS } from "@/lib/offline/snapshots";
import { practiceIdentity } from "@/lib/practice";
import type { QuickLogId } from "@/lib/quick-log";
import type { FlowKind, QueuedIntent } from "@/lib/offline/queue";

const PHONE_CONTEXT = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
} as const;

const QUEUED = "Saved offline — will sync when you reconnect.";

test("the quick logger's measurements row OPENS with no connection, and the weigh-in queues", async ({
  browser,
}) => {
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_WEIGHT_QA, password: E2E_MEMBER_PASSWORD },
    PHONE_CONTEXT
  );
  const context = page.context();
  try {
    await page.goto("/");
    const puck = page.getByTestId("dock-log-puck");
    await awaitHydrated(puck);

    await context.setOffline(true);
    // offline-nav-ok: these opens are client toggles; writes stay in IndexedDB.
    // This context closes offline, so the next test's navigation is independent.

    const sheet = await openLogSheet(page);
    const row = await showLogRow(sheet, "log-measurements");
    await row.click();
    await expect(sheet).toHaveCount(0);

    const overlay = page.getByTestId("quick-entry-sheet");
    await expect(overlay).toBeVisible();
    const form = overlay.getByTestId("measurements-quick-add");
    await expect(form).toBeVisible();

    await openMeasurementGroup(page, form, "body");
    await overlay.locator("#m-weight").fill("81.4");
    await overlay.getByRole("button", { name: "Save measurements" }).click();

    await expect(page.getByText(QUEUED)).toBeVisible();
    const badge = page.getByTestId("offline-queue-badge");
    await expect(badge).toHaveText(/1 queued offline/);
  } finally {
    await context.close();
  }
});

test("the activity editor OPENS with no connection — the shell already holds its props", async ({
  page,
  context,
}) => {
  await page.goto("/");
  const puck = page.getByTestId("dock-log-puck");
  await awaitHydrated(puck);

  await context.setOffline(true);
  // offline-nav-ok: the activity editor opens from shell props without navigation.

  const sheet = await openLogSheet(page);
  const row = await showLogRow(sheet, "log-activity");
  await row.click();
  await expect(page.getByTestId("activity-form")).toBeVisible();
  await context.setOffline(false);
});

// Reachability is separate from write support: these forms must open after the
// connection is cut, then leave durable intents through their existing flows.
const DECLARED_ROWS = Object.values(LOG_MANIFEST)
  .filter(
    (d) => d.offline.kind === "covered" && d.surfaces.sheet.kind === "covered"
  )
  .map((d) => (d.surfaces.sheet as { via: QuickLogId }).via)
  .sort();

type Driver = {
  copy: "device" | "shell";
  body: string;
  queues: FlowKind | null;
  closes: boolean;
  tap?: (overlay: Locator) => Promise<void>;
};

const DRIVERS: Partial<Record<QuickLogId, Driver>> = {
  "log-dose": {
    copy: "device",
    body: "quick-entry-dose-list",
    queues: "dose",
    closes: true,
    tap: async (overlay) => {
      await overlay
        .getByTestId(`quick-entry-dose-${shellDoseId()}`)
        .getByTestId("dose-take")
        .click();
    },
  },
  "log-practice": {
    copy: "device",
    body: "quick-entry-practice-list",
    queues: "practice",
    closes: false,
    tap: async (overlay) => {
      await overlay
        .getByTestId(`quick-entry-practice-${practiceIdentity(SHELL_PRACTICE)}`)
        .getByTestId("practice-log-button")
        .click();
    },
  },
  "log-mood": {
    copy: "device",
    body: "mood-form",
    queues: "mood",
    closes: true,
    tap: async (overlay) => {
      await overlay.getByTestId("quick-mood-tap-4").click();
    },
  },
  "log-stool": {
    copy: "device",
    body: "quick-entry-stool",
    queues: "stool",
    closes: false,
    tap: async (overlay) => {
      await overlay.getByTestId("stool-type-4").click();
    },
  },
  "log-measurements": {
    copy: "shell",
    body: "measurements-quick-add",
    queues: null,
    closes: false,
  },
  "log-food": {
    copy: "device",
    body: "food-log-bar",
    queues: "food",
    closes: false,
    tap: async (overlay) => {
      const row = overlay.getByTestId("food-group-cruciferous");
      if (!(await row.isVisible())) {
        await overlay.getByTestId("food-more-groups-summary").click();
      }
      await expect(row).toBeVisible();
      const meal = await overlay
        .getByTestId("food-meal-slots")
        .getByRole("button", { pressed: true })
        .textContent();
      await row.getByTestId("log-cruciferous").click();
      // Shell inherits the run's pinned zone, whose local date equals the frozen
      // UTC date. The serving must keep that day and the meal shown at the tap.
      await expect
        .poll(async () => {
          const intents = (await storedRows(
            overlay.page(),
            "intents"
          )) as QueuedIntent[];
          return intents.find((intent) => intent.flow === "food");
        })
        .toMatchObject({
          date: frozenNow().toISOString().slice(0, 10),
          payload: {
            entry: "serving",
            groupKey: "cruciferous",
            mealSlot: meal,
          },
        });
    },
  },
};

// Check existence first: opening a missing IndexedDB name would create version 1
// and interfere with the app's own upgrade. Match the existing offline harness.
function storedRows(page: Page, storeName: string): Promise<unknown[]> {
  return page.evaluate(
    ([dbName, store]) =>
      (async () => {
        const known = await indexedDB.databases();
        if (!known.some((d) => d.name === dbName)) return [];
        return new Promise<unknown[]>((resolve) => {
          const req = indexedDB.open(dbName);
          req.onerror = () => resolve([]);
          req.onblocked = () => resolve([]);
          req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(store)) {
              db.close();
              resolve([]);
              return;
            }
            const all = db
              .transaction(store, "readonly")
              .objectStore(store)
              .getAll();
            all.onerror = () => {
              db.close();
              resolve([]);
            };
            all.onsuccess = () => {
              const rows = all.result as unknown[];
              db.close();
              resolve(rows);
            };
          };
        });
      })(),
    ["allos-offline", storeName] as const
  );
}

function shellDoseId(): number {
  const db = new Database(workerDbPath());
  try {
    return (
      db
        .prepare(
          `SELECT d.id AS id FROM intake_item_doses d
             JOIN intake_items i ON i.id = d.item_id
            WHERE i.profile_id = (SELECT id FROM profiles WHERE name = ?)
              AND i.name = ?`
        )
        .get(SHELL_PROFILE, SHELL_DOSE_ITEM) as { id: number }
    ).id;
  } finally {
    db.close();
  }
}

// Borrow the two existing fixture rows, then restore their exact prior logs after
// the offline context closes. No queued write in these tests reaches the server.
function clearShellLogs(): () => void {
  const db = new Database(workerDbPath());
  let saved: { table: string; rows: Record<string, unknown>[] }[];
  try {
    saved = db.transaction(() => [
      {
        table: "intake_item_logs",
        rows: db
          .prepare("DELETE FROM intake_item_logs WHERE dose_id = ? RETURNING *")
          .all(shellDoseId()) as Record<string, unknown>[],
      },
      {
        table: "practice_logs",
        rows: db
          .prepare(
            "DELETE FROM practice_logs WHERE profile_id = (SELECT id FROM profiles WHERE name = ?) AND practice = ? RETURNING *"
          )
          .all(SHELL_PROFILE, SHELL_PRACTICE) as Record<string, unknown>[],
      },
    ])();
  } finally {
    db.close();
  }
  return () => {
    const restore = new Database(workerDbPath());
    try {
      restore.transaction(() => {
        for (const { table, rows } of saved) {
          for (const row of rows) {
            const columns = Object.keys(row);
            restore
              .prepare(
                `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
              )
              .run(...Object.values(row));
          }
        }
      })();
    } finally {
      restore.close();
    }
  };
}

async function openRow(page: Page, id: QuickLogId): Promise<Locator> {
  const sheet = await openLogSheet(page);
  const row = await showLogRow(sheet, id);
  await row.click();
  await expect(sheet).toHaveCount(0);
  const overlay = page.getByTestId("quick-entry-sheet"); // testid-scope-ok: portals to <body> (BottomSheet), one copy
  await expect(overlay).toBeVisible();
  return overlay;
}

// Focus the sheet before Escape so a tooltip cannot consume its dismissal.
async function dismiss(page: Page): Promise<void> {
  const overlay = page.getByTestId("quick-entry-sheet"); // testid-scope-ok: portals to <body> (BottomSheet), one copy
  await overlay.locator("[data-sheet-panel]").focus();
  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
}

test("declared offline rows open from device data after a reload and their writes queue", async ({
  browser,
}) => {
  test.slow();
  expect(Object.keys(DRIVERS).sort()).toEqual(DECLARED_ROWS);
  // Login reaches the app and can capture snapshots immediately. Borrow the
  // fixture logs first so even that initial capture sees the intended state.
  const restoreLogs = clearShellLogs();
  let context: BrowserContext | undefined;
  try {
    const page = await loginAs(
      browser,
      { username: E2E_LOGIN_SHELL, password: E2E_MEMBER_PASSWORD },
      PHONE_CONTEXT
    );
    context = page.context();
    await page.goto("/");
    await expect
      .poll(
        () =>
          storedRows(page, "snapshots").then((rows) =>
            (rows as { kind: string }[]).map((r) => r.kind).sort()
          ),
        { timeout: 30_000 }
      )
      .toEqual([...SNAPSHOT_KINDS].sort());

    // Cache lazy code online, then reload to discard every in-memory last-good
    // payload. The first data open in this document happens offline. The separate
    // chunk-failure test below covers code that has not loaded successfully.
    for (const id of ["log-practice", "log-mood", "log-stool"] as const) {
      const overlay = await openRow(page, id);
      await expect(overlay.getByTestId(DRIVERS[id]!.body)).toBeVisible();
      await dismiss(page);
    }
    await page.reload();
    const puck = page.getByTestId("dock-log-puck"); // testid-scope-ok: layout chrome, outside every streamed boundary
    await awaitHydrated(puck);

    await context.setOffline(true);
    // offline-nav-ok: these opens are client toggles; writes stay in IndexedDB.
    // This context closes offline, so the next test's navigation is independent.

    let queued = 0;
    const opens: { row: QuickLogId; milliseconds: number }[] = [];
    const badge = page.getByTestId("offline-queue-badge"); // testid-scope-ok: layout chrome, outside every streamed boundary
    for (const id of DECLARED_ROWS) {
      const driver = DRIVERS[id];
      if (!driver) throw new Error(`no driver for the declared row ${id}`);
      await test.step(id, async () => {
        const started = performance.now();
        const overlay = await openRow(page, id);
        await expect(overlay.getByTestId(driver.body)).toBeVisible();
        opens.push({ row: id, milliseconds: performance.now() - started });
        const asOf = overlay.getByTestId("quick-entry-asof");
        if (driver.copy === "device") {
          await expect(asOf).toBeVisible();
        }
        await driver.tap?.(overlay);
        if (driver.copy !== "device") await expect(asOf).toHaveCount(0);
        if (driver.queues) {
          queued += 1;
          await expect(badge).toHaveText(
            new RegExp(`^${queued} queued offline$`)
          );
        }
        if (driver.closes) await expect(overlay).toHaveCount(0);
        else await dismiss(page);
      });
    }

    await test.info().attach("offline-first-data-open-latency", {
      body: JSON.stringify(
        { warmedBodies: ["practice", "mood", "stool"], opens },
        null,
        2
      ),
      contentType: "application/json",
    });
    const intents = (await storedRows(page, "intents")) as {
      flow: string;
      profileId?: number;
    }[];
    expect(intents.map((i) => i.flow).sort()).toEqual(
      DECLARED_ROWS.flatMap((id) => DRIVERS[id]?.queues ?? []).sort()
    );
    const db = new Database(workerDbPath());
    try {
      const profile = db
        .prepare("SELECT id FROM profiles WHERE name = ?")
        .get(SHELL_PROFILE) as { id: number };
      expect([...new Set(intents.map((i) => i.profileId))]).toEqual([
        profile.id,
      ]);
    } finally {
      db.close();
    }
  } finally {
    try {
      await context?.close();
    } finally {
      restoreLogs();
    }
  }
});

test("a warm form reopens offline with an as-of label and its tap queues", async ({
  browser,
}) => {
  const doseId = shellDoseId();
  const restoreLogs = clearShellLogs();
  let context: BrowserContext | undefined;
  try {
    const page = await loginAs(
      browser,
      { username: E2E_LOGIN_SHELL, password: E2E_MEMBER_PASSWORD },
      PHONE_CONTEXT
    );
    context = page.context();
    await page.goto("/");
    const first = await openRow(page, "log-dose");
    await expect(first.getByTestId(`quick-entry-dose-${doseId}`)).toBeVisible();
    await expect(first.getByTestId("quick-entry-asof")).toHaveCount(0);
    await dismiss(page);

    await context.setOffline(true);
    // offline-nav-ok: these opens are client toggles; writes stay in IndexedDB.
    // This context closes offline, so the next test's navigation is independent.

    const overlay = await openRow(page, "log-dose");
    const row = overlay.getByTestId(`quick-entry-dose-${doseId}`);
    await expect(row).toBeVisible();
    await expect(overlay.getByTestId("quick-entry-asof")).toHaveText(
      /^As of .* — couldn't refresh\.$/
    );
    await expect(overlay.getByTestId("quick-entry-error")).toHaveCount(0);

    await row.getByTestId("dose-take").click();
    await expect(
      page.getByText("Dose saved offline — will sync when you reconnect.")
    ).toBeVisible();
    const badge = page.getByTestId("offline-queue-badge"); // testid-scope-ok: layout chrome, outside every streamed boundary
    await expect(badge).toHaveText(/^1 queued offline$/);
  } finally {
    try {
      await context?.close();
    } finally {
      restoreLogs();
    }
  }
});

for (const fault of ["failed", "stalled"] as const) {
  test(`a ${fault} gather reaches Retry and recovers the form in place`, async ({
    browser,
  }) => {
    if (fault === "stalled") test.slow();
    const page = await loginAs(
      browser,
      { username: E2E_LOGIN_SHELL, password: E2E_MEMBER_PASSWORD },
      // Service-worker-mediated requests bypass page.route and would evade injection.
      { ...PHONE_CONTEXT, serviceWorkers: "block" }
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await page.goto("/");
      const sheet = await openLogSheet(page);
      const row = await showLogRow(sheet, "add-document");

      // Prime the picker first, so the intercepted Action is the form gather.
      // A response held beyond the load bound exercises a stall, not rejection.
      let armed = true;
      let intercepted = 0;
      await page.route("**/*", async (route) => {
        const req = route.request();
        if (armed && req.method() === "POST" && req.headers()["next-action"]) {
          intercepted += 1;
          if (fault === "failed") {
            await route.abort("failed");
          } else {
            const response = await route.fetch();
            await held;
            await route.fulfill({ response });
          }
          return;
        }
        await route.continue();
      });

      await row.click();
      await expect(sheet).toHaveCount(0);
      const overlay = page.getByTestId("quick-entry-sheet"); // testid-scope-ok: portals to <body> (BottomSheet), one copy
      await expect(overlay.getByTestId("quick-entry-error")).toBeVisible({
        timeout: 15_000,
      });
      expect(
        intercepted,
        "the form gather must encounter the injected fault"
      ).toBeGreaterThan(0);

      armed = false;
      release();
      await overlay.getByTestId("quick-entry-retry").click();
      await expect(overlay.getByTestId("medical-upload-choose")).toBeVisible();
      await expect(overlay.getByTestId("quick-entry-error")).toHaveCount(0);
      await expect(overlay).toBeVisible();
    } finally {
      release();
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.context().close();
    }
  });
}

test("a failed body chunk retries in place without losing the sheet", async ({
  browser,
}) => {
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_SHELL, password: E2E_MEMBER_PASSWORD },
    // Service-worker-mediated requests bypass page.route and would evade injection.
    { ...PHONE_CONTEXT, serviceWorkers: "block" }
  );
  try {
    await page.goto("/");
    const puck = page.getByTestId("dock-log-puck"); // testid-scope-ok: layout chrome, outside every streamed boundary
    await awaitHydrated(puck);
    const sheet = await openLogSheet(page);
    const row = await showLogRow(sheet, "add-document");

    // Count actual faults so an inactive interception cannot produce a green.
    let armed = true;
    let aborted = 0;
    await page.route("**/_next/static/chunks/**", async (route) => {
      const url = new URL(route.request().url()).pathname;
      if (armed && url.endsWith(".js")) {
        aborted += 1;
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    await row.click();
    await expect(sheet).toHaveCount(0);
    const overlay = page.getByTestId("quick-entry-sheet"); // testid-scope-ok: portals to <body> (BottomSheet), one copy
    await expect(overlay).toBeVisible();
    await expect(overlay.getByTestId("quick-entry-error")).toBeVisible();
    expect(
      aborted,
      "no chunk was requested, so no import could have failed"
    ).toBeGreaterThan(0);
    await expect(puck).toBeVisible();

    armed = false;
    await overlay.getByTestId("quick-entry-retry").click();
    await expect(overlay.getByTestId("medical-upload-choose")).toBeVisible();
    await expect(overlay.getByTestId("quick-entry-error")).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});
