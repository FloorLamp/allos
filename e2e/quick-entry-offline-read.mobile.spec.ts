import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { awaitHydrated } from "./helpers";
import { openLogSheet, showLogRow } from "./log-sheet-helpers";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_SHELL,
  SHELL_DOSE_ITEM,
  SHELL_PROFILE,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";
import type { QuickLogId } from "@/lib/quick-log";

// THE QUICK LOGGER'S READ PATH ON A BAD CONNECTION (#3416) — the three legs the
// reachability spec does not cover:
//
//   1. AFTER a successful open, the network dies: the same form reopens at once from
//      its last-good copy, the revalidate behind it fails, and the sheet says so
//      (the #2908 as-of line) rather than blanking into an error.
//   2. An INJECTED read failure — the gather's own request aborted — exercises the
//      real error and retry path: the retry state renders, and Retry recovers the
//      form in place once the request can land, without the sheet closing (#4980's
//      positive counterpart: the refusal the app actually renders, driven).
//   3. A DYNAMIC CHUNK failure on a body's first open reaches the same retry state,
//      and Retry re-imports and recovers.
//
// The Mobile Shell fixture throughout (quick-log-overlay.mobile.spec.ts owns it and
// clears the dose's logs at its own start; leg 1 does the same). Leg 1's queued tap
// dies with its context; legs 2 and 3 write nothing.

const PHONE_CONTEXT = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
} as const;

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

function clearShellDoseLogs(): void {
  const db = new Database(workerDbPath());
  try {
    db.prepare("DELETE FROM intake_item_logs WHERE dose_id = ?").run(
      shellDoseId()
    );
  } finally {
    db.close();
  }
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

async function dismiss(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  const overlay = page.getByTestId("quick-entry-sheet"); // testid-scope-ok: portals to <body> (BottomSheet), one copy
  await expect(overlay).toHaveCount(0);
}

test("a form opened once online reopens at once with the network cut, says its copy could not refresh, and its tap queues", async ({
  browser,
}) => {
  clearShellDoseLogs();
  const doseId = shellDoseId();
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_SHELL, password: E2E_MEMBER_PASSWORD },
    PHONE_CONTEXT
  );
  const context = page.context();
  try {
    await page.goto("/");
    const first = await openRow(page, "log-dose");
    await expect(first.getByTestId(`quick-entry-dose-${doseId}`)).toBeVisible();
    // Fresh from the server: no as-of line.
    await expect(first.getByTestId("quick-entry-asof")).toHaveCount(0);
    await dismiss(page);

    await context.setOffline(true);

    // offline-nav-ok: nothing below navigates; the reopen is memory, the tap is the
    // queue, and this test never reconnects.
    const overlay = await openRow(page, "log-dose");
    const row = overlay.getByTestId(`quick-entry-dose-${doseId}`);
    await expect(row).toBeVisible();
    // The revalidate behind the last-good render fails at once offline, and from
    // then on the sheet says what it is showing rather than pretending it is fresh.
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
    await context.close();
  }
});

test("an injected read failure shows the retry state, and Retry recovers the form in place", async ({
  browser,
}) => {
  clearShellDoseLogs();
  const doseId = shellDoseId();
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_SHELL, password: E2E_MEMBER_PASSWORD },
    PHONE_CONTEXT
  );
  try {
    await page.goto("/");
    const puck = page.getByTestId("dock-log-puck"); // testid-scope-ok: layout chrome, outside every streamed boundary
    await awaitHydrated(puck);

    // The gather is a Server Action: a POST carrying the `next-action` header, which
    // is how every other request on the page is told apart from it. Aborted only
    // while armed, and COUNTED, so a green here is a green over a request that was
    // really refused and not over a gather that happened to succeed.
    let armed = true;
    let aborted = 0;
    await page.route("**/*", async (route) => {
      const req = route.request();
      if (armed && req.method() === "POST" && req.headers()["next-action"]) {
        aborted += 1;
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    const overlay = await openRow(page, "log-dose");
    await expect(overlay.getByTestId("quick-entry-error")).toBeVisible();
    expect(aborted, "the gather was never asked, so nothing was refused").toBe(
      1
    );

    armed = false;
    await overlay.getByTestId("quick-entry-retry").click();
    // Recovered IN PLACE: the same sheet, never closed, now holds the form.
    await expect(
      overlay.getByTestId(`quick-entry-dose-${doseId}`)
    ).toBeVisible();
    await expect(overlay.getByTestId("quick-entry-error")).toHaveCount(0);
    await expect(overlay).toBeVisible();
  } finally {
    await page.context().close();
  }
});

test("a body whose chunk fails to load on first open shows the same retry state, and Retry re-imports it", async ({
  browser,
}) => {
  // `serviceWorkers: "block"`: public/sw.js serves `/_next/static/*` cacheFirst and
  // Playwright cannot intercept a service-worker-mediated fetch, so with the worker
  // live the abort below would never fire (logout-pre-hydration.spec.ts records the
  // same obstacle). The chunk request has to be the PAGE's for the route to see it.
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_SHELL, password: E2E_MEMBER_PASSWORD },
    { ...PHONE_CONTEXT, serviceWorkers: "block" }
  );
  try {
    await page.goto("/");
    const puck = page.getByTestId("dock-log-puck"); // testid-scope-ok: layout chrome, outside every streamed boundary
    await awaitHydrated(puck);
    // The sheet's own chunks arrive here, online; only the BODY's is refused.
    const sheet = await openLogSheet(page);
    const row = await showLogRow(sheet, "add-document");

    // `.js` ONLY: in this Turbopack build the stylesheets live under the same path,
    // and a held stylesheet stops React revealing anything at all
    // (logout-pre-hydration.spec.ts measured it).
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
    // The gather succeeded; the body's import did not — and the failure lands on the
    // sheet's own boundary as the same retry state, not on the route's.
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
