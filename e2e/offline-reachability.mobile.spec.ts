import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
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
import { workerDbPath } from "./worker-env";
import { LOG_MANIFEST } from "@/lib/log-manifest";
import { SNAPSHOT_KINDS } from "@/lib/offline/snapshots";
import { practiceIdentity } from "@/lib/practice";
import type { QuickLogId } from "@/lib/quick-log";

// CAN YOU GET INTO THE FORM AT ALL — the question no other offline spec asks (#4091).
//
// ── THE ORDERING IS THE WHOLE TEST ───────────────────────────────────────────
//
// Every other offline spec in this repo goes online → open the form →
// `setOffline(true)` → act, and `quick-log-overlay.mobile.spec.ts` says so in its
// own comment: "here it is only the wait that lets the sheet — which loads through
// a Server Action — be reopened." That ordering proves a WRITE QUEUES once you are
// inside a form. It cannot prove you can get in, because the getting-in already
// happened on a live connection.
//
// The cost of the gap, measured on #4083: retiring the dashboard's inline weight
// widget removed the last offline-reachable weigh-in, and every guard on that PR
// stayed green — the retirement census asserts the sheet OFFERS the row, which is
// a statement about membership, and reachability is a precondition membership
// never had.
//
// So here the connection dies FIRST, after full hydration, and only then does the
// test reach for the surface. Nothing is opened on a live connection.
//
// ── WHICH SURFACES BELONG IN THIS FILE ───────────────────────────────────────
//
// The rule the app follows, now written down (docs/internals/e2e-hygiene.md):
// **a surface is offline-reachable exactly when opening it needs no Server
// Action** — server-rendered inline, client state the shell already holds, or
// (#3416) the device's own copy: a #2908 snapshot for the sheet's day, or the
// device's own day and queue. One test per surface with a real opening step, and
// ONE test that walks every flow the manifest declares offline-capable, so the next
// declared flow cannot ship half-connected (#4434).
//
// The inline controls (the food bar, the dose rows, the mobility chips) have no
// opening step at all: you are standing on their page or you are not, and
// navigating offline is the `/offline` shell's subject, not this file's.

const PHONE_CONTEXT = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
} as const;

const QUEUED = "Saved offline — will sync when you reconnect.";

test("the quick logger's measurements row OPENS with no connection, and the weigh-in queues", async ({
  browser,
}) => {
  // The profile #4083's matched pair was measured on: write-granted, adult (so no
  // growth fields), and spec-owned. This test never reconnects, so the queued entry
  // never replays and no row of its own reaches the database — the owning spec's
  // reset is untouched.
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_WEIGHT_QA, password: E2E_MEMBER_PASSWORD },
    PHONE_CONTEXT
  );
  const context = page.context();
  try {
    await page.goto("/");
    // FULL HYDRATION BEFORE THE DISCONNECT, and it is load-bearing in both
    // directions. Too early and the dock puck's tap is swallowed pre-hydration
    // (#2742) and this reports a reachability failure it did not have; too late is
    // impossible, because nothing here is timed. React's fibers on the puck are the
    // repo's own hydration probe, and the puck is the first thing the test touches.
    const puck = page.getByTestId("dock-log-puck");
    await awaitHydrated(puck);

    await context.setOffline(true);

    // offline-nav-ok: nothing here navigates. The sheet is a client toggle, the
    // form is already in the shell's bundle, and the save reaches IndexedDB — none
    // of which the service worker's fetch bypass can fake, and no shell has to come
    // from anywhere, so `readyForOffline` is not this block's precondition
    // (docs/internals/e2e-hygiene.md, "Offline does not reach the service worker").
    // This test never reconnects, so its window is textually open to the end of the
    // file and the scan sees the NEXT tests' `goto`s — which run in their own
    // contexts, online, before their own `setOffline(true)`.
    const sheet = await openLogSheet(page);
    const row = await showLogRow(sheet, "log-measurements");
    await row.click();
    await expect(sheet).toHaveCount(0);

    const overlay = page.getByTestId("quick-entry-sheet");
    await expect(overlay).toBeVisible();
    // THE ASSERTION THE WHOLE FILE EXISTS FOR. A presence, deliberately: waiting
    // longer cannot make a form appear that was never mounted, so this fails
    // honestly on the broken tree at any budget. (An absence check on the refusal
    // sentence used to follow it; #4980 found the sentence was one no production
    // path emits, so it could never fail and is gone. The refusal path that DOES
    // exist is driven, positively, below: "an injected read failure".)
    const form = overlay.getByTestId("measurements-quick-add");
    await expect(form).toBeVisible();

    // Reachable is not yet useful: the point of getting in is getting a weight out.
    await openMeasurementGroup(page, form, "body");
    await overlay.locator("#m-weight").fill("81.4");
    // A plain click: this submit deliberately posts NOTHING — the queue is the
    // point — so there is no Server Action response to settle on.
    await overlay.getByRole("button", { name: "Save measurements" }).click();

    await expect(page.getByText(QUEUED)).toBeVisible();
    const badge = page.getByTestId("offline-queue-badge");
    await expect(badge).toHaveText(/1 queued offline/);
  } finally {
    // Closed while still offline: the queued entry dies with the context rather
    // than replaying into a profile another spec owns.
    await context.close();
  }
});

// The worker's shared session, on the phone the ruling was reported from: the
// desktop "Add activity" button does not render at 390px, so the door here is the
// same dock puck the row above uses. Two rows of one sheet, offline-reachable for
// the same reason — which is what makes this a rule rather than one bug's guard.
test("the activity editor OPENS with no connection — the shell already holds its props", async ({
  page,
  context,
}) => {
  // ActivityEditorProvider is propped from the app shell, so `openCreate` is client
  // state and needs no round trip. offline-set-log.spec.ts drives the WRITE from
  // this editor, and opens it online first — this is the half that ordering cannot
  // see.
  await page.goto("/");
  const puck = page.getByTestId("dock-log-puck");
  await awaitHydrated(puck);

  await context.setOffline(true);

  const sheet = await openLogSheet(page);
  const row = await showLogRow(sheet, "log-activity");
  await row.click();
  await expect(page.getByTestId("activity-form")).toBeVisible();
  // Nothing is saved: the editor is opened and abandoned, so no activity row is
  // left to displace the seeded lift (offline-set-log.spec.ts's #3930 hazard).
  await context.setOffline(false);
});

// ── EVERY DECLARED OFFLINE FLOW, BEFORE ITS FIRST OPEN (#3416, absorbing #4434) ──
//
// The rows this walks come from the MANIFEST, not from a hand list: every domain
// whose `offline` column is `covered` and whose sheet surface is `covered` is a row
// the sheet promises to open with no connection. A driver below is required for each,
// and a driver for a row the manifest does not declare is an error — so declaring a
// flow offline-capable and leaving its open path on a Server Action fails here.
const DECLARED_ROWS = Object.values(LOG_MANIFEST)
  .filter(
    (d) => d.offline.kind === "covered" && d.surfaces.sheet.kind === "covered"
  )
  .map((d) => (d.surfaces.sheet as { via: QuickLogId }).via)
  .sort();

// What each declared row must show with the connection cut and NO earlier open of
// the sheet in this document — and, where it can, what durable intent a tap leaves.
//
//   copy:   `device` — the form renders from the device's own copy and says so
//           (`quick-entry-asof`); `shell` — the props ride the app shell (#4091);
//           `none` — ARGUED: no honest copy exists, so the row shows the retry state
//           rather than a form over invented data.
//   queues: the queue flow one tap leaves, or null where the driver only opens. The
//           intent is asserted where it is DURABLE — the badge count after the tap and
//           the stored rows at the end — never by the tap's toast: one toast shows at
//           a time with the rest queued behind it (components/Toast.tsx), so a walk
//           asserting each row's sentence would be asserting the toast queue's timing.
//           Each write flow's own spec owns its sentence.
//   closes: the tap ENDS the sheet (a transaction with an end closes itself), so the
//           walk waits for it to go rather than reaching for a Close control that is
//           already playing its exit — measured here as a 15s click timeout.
type Driver = {
  copy: "device" | "shell" | "none";
  queues: string | null;
  closes: boolean;
  open: (overlay: Locator) => Promise<void>;
};

const DRIVERS: Partial<Record<QuickLogId, Driver>> = {
  "log-dose": {
    copy: "device",
    queues: "dose",
    // The fixture's one dose is the day's last: taking it leaves nothing in the
    // window, and QuickDoseList closes the sheet on exactly that.
    closes: true,
    open: async (overlay) => {
      const row = overlay.getByTestId(`quick-entry-dose-${shellDoseId()}`);
      await expect(row).toBeVisible();
      await row.getByTestId("dose-take").click();
    },
  },
  "log-practice": {
    copy: "device",
    queues: "practice",
    closes: false,
    open: async (overlay) => {
      const row = overlay.getByTestId(
        `quick-entry-practice-${practiceIdentity(SHELL_PRACTICE)}`
      );
      await expect(row).toBeVisible();
      await row.getByTestId("practice-log-button").click();
    },
  },
  "log-mood": {
    copy: "device",
    queues: "mood",
    closes: true,
    open: async (overlay) => {
      const form = overlay.getByTestId("mood-form");
      await expect(form).toBeVisible();
      await form.getByTestId("quick-mood-tap-4").click();
    },
  },
  "log-stool": {
    copy: "device",
    queues: "stool",
    closes: false,
    open: async (overlay) => {
      await expect(overlay.getByTestId("quick-entry-stool")).toBeVisible();
      await overlay.getByTestId("stool-type-4").click();
    },
  },
  "log-measurements": {
    copy: "shell",
    queues: null,
    closes: false,
    open: async (overlay) => {
      await expect(overlay.getByTestId("measurements-quick-add")).toBeVisible();
    },
  },
  // ARGUED, not forgotten: `food-tallies` answers "have I logged that serving", not
  // "what may I log" — the bar's ranked catalog, exclusions and meal windows are
  // server-resolved per profile (lib/offline/quick-entry-read.ts). A last-good open
  // still serves it; a cold one is honest about not being able to.
  "log-food": {
    copy: "none",
    queues: null,
    closes: false,
    open: async (overlay) => {
      await expect(overlay.getByTestId("quick-entry-error")).toBeVisible();
      await expect(overlay.getByTestId("quick-entry-retry")).toBeVisible();
    },
  },
};

// The rows the queue holds, read straight out of IndexedDB. Never creates the
// database (a version-less open on a missing name would, at v1, in the way of the
// app's own upgrade — offline-snapshots.spec.ts records the cost).
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

// The Shell fixture's dose and practice, both left UNLOGGED for today so the snapshot
// captured below has a tap to offer: a dose already taken is not due, and a practice
// already logged today makes an offline tap say so instead of queueing
// (LogPracticeButton's same-day narrowing). quick-log-overlay.mobile.spec.ts owns
// the fixture and clears both at its own start; this does the same, whichever spec
// ran last in this worker.
function clearShellLogs(): void {
  const db = new Database(workerDbPath());
  try {
    db.prepare("DELETE FROM intake_item_logs WHERE dose_id = ?").run(
      shellDoseId()
    );
    db.prepare(
      "DELETE FROM practice_logs WHERE profile_id = (SELECT id FROM profiles WHERE name = ?)"
    ).run(SHELL_PROFILE);
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

// Escape is this sheet's exit: the host mounts BottomSheet without `showClose`, so
// there is no Close control to reach for (quick-log-overlay.mobile.spec.ts closes it
// the same way). FOCUS THE PANEL FIRST: the trap's initial focus lands on the body's
// first focusable, and where that is an InfoTooltipIcon (the measurements form's help
// glyph) focusing it OPENS the tooltip, which then owns the first Escape as its own
// layer (useFocusTrap's `data-escape-layer` rule) — measured here as a sheet that
// stayed open on exactly that row. Nothing here types into a body, so the exit's
// dirty guard never asks.
async function dismiss(page: Page): Promise<void> {
  const overlay = page.getByTestId("quick-entry-sheet"); // testid-scope-ok: portals to <body> (BottomSheet), one copy
  await overlay.locator("[data-sheet-panel]").focus();
  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
}

test("every flow the manifest declares offline-capable OPENS with no connection before its first open, from the device's own copy, and queues", async ({
  browser,
}) => {
  test.slow();
  expect(Object.keys(DRIVERS).sort()).toEqual(DECLARED_ROWS);
  clearShellLogs();
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_SHELL, password: E2E_MEMBER_PASSWORD },
    PHONE_CONTEXT
  );
  const context = page.context();
  try {
    await page.goto("/");
    // THE DEVICE'S COPY: an ordinary authenticated visit captures the #2908 snapshots
    // in the background; wait on the captured state, never on the navigation.
    await expect
      .poll(
        () =>
          storedRows(page, "snapshots").then((rows) =>
            (rows as { kind: string }[]).map((r) => r.kind).sort()
          ),
        { timeout: 30_000 }
      )
      .toEqual([...SNAPSHOT_KINDS].sort());

    // WARM THE CODE, NOT THE DATA. Three of the bodies are on-demand chunks
    // (#1525/#1892), and a chunk never fetched is the OTHER offline failure — the
    // "a body whose chunk fails to load" below drives through an aborted request.
    // This test is about the DATA: so each such body is opened once online (nothing
    // is tapped), and the page is then RELOADED, which discards the in-memory
    // last-good copies along with the document. What is left on the device is the
    // snapshot store and the queue, and the as-of line each driver asserts is the
    // proof that this is what the form rendered from — a last-good render carries
    // none.
    for (const id of ["log-practice", "log-mood", "log-stool"] as const) {
      await openRow(page, id);
      await dismiss(page);
    }
    await page.reload();
    const puck = page.getByTestId("dock-log-puck"); // testid-scope-ok: layout chrome, outside every streamed boundary
    await awaitHydrated(puck);

    await context.setOffline(true);

    // offline-nav-ok: nothing below navigates — every open is a client toggle, the
    // forms render from IndexedDB and memory, and every tap reaches the queue. This
    // test never reconnects, so the queued intents die with the context.
    let queued = 0;
    const badge = page.getByTestId("offline-queue-badge"); // testid-scope-ok: layout chrome, outside every streamed boundary
    for (const id of DECLARED_ROWS) {
      const driver = DRIVERS[id];
      if (!driver) throw new Error(`no driver for the declared row ${id}`);
      // A step per row, so a red names the row it was on.
      await test.step(id, async () => {
        const overlay = await openRow(page, id);
        const asOf = overlay.getByTestId("quick-entry-asof");
        if (driver.copy === "device") {
          await expect(asOf).toBeVisible();
        }
        await driver.open(overlay);
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

    // THE DURABLE HALF: the intents are in IndexedDB, one per declared queueing
    // flow, stamped to the profile that tapped them.
    const intents = (await storedRows(page, "intents")) as {
      flow: string;
      profileId?: number;
    }[];
    expect(intents.map((i) => i.flow).sort()).toEqual(
      DECLARED_ROWS.flatMap((id) => DRIVERS[id]?.queues ?? []).sort()
    );
    expect(new Set(intents.map((i) => i.profileId)).size).toBe(1);
  } finally {
    await context.close();
  }
});

// ── THE READ PATH AFTER THE DOOR (#3416) — three legs the walk above cannot ask ──
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
// Leg 1's queued tap dies with its context; legs 2 and 3 write nothing.

test("a form opened once online reopens at once with the network cut, says its copy could not refresh, and its tap queues", async ({
  browser,
}) => {
  clearShellLogs();
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
  // The DOCUMENT row: the one declared row with no copy on the device, so a refused
  // gather has nothing to fall back to and the retry state is the only honest answer.
  // (The dose row would fall back to its snapshot the moment the refresher has run —
  // that path is the reachability spec's, and it is why this is not that row.)
  //
  // `serviceWorkers: "block"`, as in the chunk test below: once the worker controls
  // the page its fetch handler carries the action POST, and `page.route` never sees
  // it — measured here as an abort count of 0 on the run the worker won the race.
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_SHELL, password: E2E_MEMBER_PASSWORD },
    { ...PHONE_CONTEXT, serviceWorkers: "block" }
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

    const overlay = await openRow(page, "add-document");
    await expect(overlay.getByTestId("quick-entry-error")).toBeVisible();
    expect(
      aborted,
      "the gather was never asked, so nothing was refused"
    ).toBeGreaterThan(0);

    armed = false;
    await overlay.getByTestId("quick-entry-retry").click();
    // Recovered IN PLACE: the same sheet, never closed, now holds the form.
    await expect(overlay.getByTestId("medical-upload-choose")).toBeVisible();
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
