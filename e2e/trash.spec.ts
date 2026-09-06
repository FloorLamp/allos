import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
import { hydratedClick, settledClick } from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_TRASH_EAST,
  E2E_LOGIN_TRASH_WEST,
  E2E_MEMBER_PASSWORD,
  TRASH_EAST_TZ,
  TRASH_EAST_PROFILE,
  TRASH_STRADDLE_HHMMSS,
  TRASH_WEST_PROFILE,
  TRASH_WEST_TZ,
} from "./fixture-logins";
import { plantTrashCaptures, sweepTrashProbes } from "./trash-probe";
import { frozenNow, workerDbPath } from "./worker-env";
import Database from "better-sqlite3";
import { shiftDateStr } from "../lib/date";
import { DEFAULT_FORMAT_PREFS, formatDateWithYear } from "../lib/format-date";

// Issue #2013: `deleted_rows` has held a fully restorable capture of every
// destructive delete since #30, and the ONLY affordance over it was a toast that
// disappeared in 15 seconds. This spec drives the exact journey that had no path
// before: delete a row, LET THE TOAST GO, open Data → Trash, and get it back.
//
// Fixture ownership (docs/internals/e2e-hygiene.md failure class 1): every row this
// spec touches is a uniquely-titled probe it created itself, and every assertion is
// scoped to that title — never a count over the shared trash, which any sibling
// spec's delete can add to.
//
// EXCEPT FOR THE ONE CONTROL THAT CANNOT BE SCOPED (#3547). "Empty trash" deletes
// every capture on the acting profile by design — that IS the behaviour #2013 put
// there — so on the shared admin profile it destroyed rows this spec never created,
// which is a live violation of #868 and the reason no spec could seed a trashed row
// and trust it to still be there. It is not scoped by title now either; it is scoped
// by SUBJECT. It runs as a dedicated login on a profile nothing else in the suite
// writes to, so "everything" is only ever this spec's own rows, and the shared
// profile's Trash is left alone.
//
// The same two dedicated profiles carry the timezone assertion at the bottom of this
// file, which is not a coincidence: both needed a Trash whose contents this spec owns
// outright. See e2e/logins/trash.ts.

const PROBE_PREFIX = "Trash probe";
let probeSeq = 0;

function cardsByTitle(page: Page, text: string | RegExp) {
  return page
    .getByRole("main")
    .getByTestId("history-row")
    .filter({ hasText: text });
}

// The Trash row for a given probe title (the headline is "<title> · <date>").
function trashRow(page: Page, title: string) {
  return page.getByTestId("trash-row").filter({ hasText: title });
}

// Resolve the two dedicated Trash fixture profile ids (spec-owned, so a name lookup is
// stable). Read through workerDbPath(), which is the only address a spec process may
// use: the app server's own database env var belongs to the server, not to us (#1538).
function trashProfileId(which: "TRASH_EAST" | "TRASH_WEST"): number {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const name =
      which === "TRASH_EAST" ? TRASH_EAST_PROFILE : TRASH_WEST_PROFILE;
    return (
      db.prepare("SELECT id FROM profiles WHERE name = ?").get(name) as {
        id: number;
      }
    ).id;
  } finally {
    db.close();
  }
}

// Open the stored activity's canonical page, then launch its shared workspace.
async function openEditorFromRow(page: Page, row: Locator): Promise<void> {
  await hydratedClick(
    page,
    row.getByRole("link").first() // eslint-disable-line no-restricted-properties -- first-ok: the canonical title link precedes any exercise links in the row
  );
  await page
    .getByTestId("training-activity-page")
    .getByTestId("activity-page-edit")
    .click();
}

// Confirm the dialog-scoped Delete on the activity editor and await the capture POST.
async function confirmDelete(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await settledClick(
    page,
    page
      .getByTestId("confirm-dialog")
      .getByRole("button", { name: "Delete", exact: true })
  );
}

// Create a uniquely-titled cardio probe that auto-saves, then close the editor so the
// delete is driven from the FEED. Cardio + a duration auto-saves without the per-set
// equipment pick a bare strength variant needs (#342).
async function createProbe(page: Page): Promise<string> {
  const title = `${PROBE_PREFIX} ${Date.now()}-${++probeSeq}`; // eslint-disable-line no-restricted-properties -- clock-ok: unique probe-name suffix, never a stored timestamp
  await page.goto("/training?tab=log");
  await page
    .getByRole("main")
    .getByRole("button", { name: "Add activity" })
    .click();
  await page.getByRole("textbox", { name: "Activity name" }).fill(title);
  await page.getByPlaceholder(/What did you do/).fill("Running");
  await page
    .getByRole("listbox")
    .getByRole("option", { name: "Running", exact: true })
    .click();
  await page.getByTestId("cardio-duration").fill("30");
  // The Delete button appears only once the auto-save created the row — a stable
  // persist signal (it stays while the row exists, unlike the fading "Saved" check).
  await expect(
    page.getByRole("button", { name: "Delete", exact: true })
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(cardsByTitle(page, title)).toHaveCount(1);
  return title;
}

// Create a probe, delete it via its canonical record, and WALK AWAY from the
// Undo toast — the state that used to be unreachable. Returns the probe's title.
async function deleteProbeAndAbandonTheToast(page: Page): Promise<string> {
  const title = await createProbe(page);
  await openEditorFromRow(page, cardsByTitle(page, title));
  await confirmDelete(page);
  // Navigating away discards the toast without waiting out its 15 seconds, which is
  // exactly what a person who noticed the mistake later did.
  await page.goto("/data?section=trash");
  return title;
}

test("a deleted row is restorable from Data → Trash after the toast is gone (#2013)", async ({
  page,
}) => {
  test.slow(); // local next dev compiles /training and /data on first hit

  const title = await deleteProbeAndAbandonTheToast(page);

  // The capture is listed with the identifying content read out of its payload —
  // the label column alone would say "activity" for every one of them.
  const row = trashRow(page, title);
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("trash-row-headline")).toContainText(title);

  // Restore is the same one-tap restore the toast performs.
  await settledClick(page, row.getByTestId("trash-restore"));
  await expect(page.getByText("Restored.")).toBeVisible();
  // The capture is consumed, so the Trash stops offering it.
  await expect(trashRow(page, title)).toHaveCount(0);

  // And the row is back on its own surface (under a NEW id, so match by title).
  await page.goto("/training?tab=log");
  await expect(cardsByTitle(page, title)).toHaveCount(1);

  // Clean up: delete the restored probe and purge its capture, so this spec leaves
  // the shared DB exactly as it found it.
  await openEditorFromRow(page, cardsByTitle(page, title));
  await confirmDelete(page);
  await page.goto("/data?section=trash");
  const leftover = trashRow(page, title);
  // The purge button opens a confirm (no POST of its own) — the confirm's button is
  // what fires the action, so that is the settled click.
  await leftover.getByTestId("trash-purge").click();
  await settledClick(
    page,
    page
      .getByTestId("confirm-dialog")
      .getByRole("button", { name: "Delete permanently" })
  );
  await expect(trashRow(page, title)).toHaveCount(0);
});

test("Delete permanently removes a capture ahead of its window (#2013)", async ({
  page,
}) => {
  test.slow();

  const title = await deleteProbeAndAbandonTheToast(page);
  const row = trashRow(page, title);
  await expect(row).toHaveCount(1);

  // A destructive confirm, then the row leaves the list — the capture is gone, not
  // merely hidden.
  await row.getByTestId("trash-purge").click();
  await settledClick(
    page,
    page
      .getByTestId("confirm-dialog")
      .getByRole("button", { name: "Delete permanently" })
  );
  await expect(page.getByText("Deleted permanently.")).toBeVisible();
  await expect(trashRow(page, title)).toHaveCount(0);

  // Reloading proves it was a write, not client state — and the activity stays gone.
  await page.reload();
  await expect(trashRow(page, title)).toHaveCount(0);
  await page.goto("/training?tab=log");
  await expect(cardsByTitle(page, title)).toHaveCount(0);
});

// THE ONE TEST THAT IS ABOUT THE WHOLE BIN, ON A BIN IT OWNS (#2013 behaviour, #3547
// scoping). "Empty trash" is not a control that can be aimed at one row — emptying
// everything is the behaviour under test — so the only honest way to own its blast
// radius is to own the SUBJECT. It signs in as a dedicated login whose profile no
// other spec writes to, does the full journey there (create, delete, walk away from
// the toast), and empties. On the shared admin profile this used to delete captures
// belonging to whichever specs had run beside it in the worker.
test("Empty trash clears the list and leaves the empty state (#2013)", async ({
  browser,
}) => {
  test.slow();

  const page = await loginAs(browser, {
    username: E2E_LOGIN_TRASH_EAST,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    const title = await deleteProbeAndAbandonTheToast(page);
    await expect(trashRow(page, title)).toHaveCount(1);

    await page.getByTestId("trash-empty-all").click();
    await settledClick(
      page,
      page
        .getByTestId("confirm-dialog")
        .getByRole("button", { name: "Empty trash" })
    );

    await expect(page.getByTestId("trash-row")).toHaveCount(0);
    await expect(page.getByTestId("trash-empty")).toBeVisible();

    // The emptied state survives a reload, and the deleted probe stays deleted.
    await page.reload();
    await expect(page.getByTestId("trash-empty")).toBeVisible();
    await page.goto("/training?tab=log");
    await expect(cardsByTitle(page, title)).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});

// THE #3547 ASSERTION ITSELF, and it is separate from the test above on purpose. That
// test would still pass if "Empty trash" reached across profiles — it only ever looks
// at its own page. This one plants a capture on the WEST profile, empties the EAST
// one, and asserts the west capture survived: the reach of the control, measured
// rather than assumed. It is the fact that makes seeding a shared Trash viable again.
test("Empty trash reaches only the acting profile's captures (#3547)", async ({
  browser,
}) => {
  test.slow();

  const bystander = `${PROBE_PREFIX} bystander`;
  plantTrashCaptures(
    [{ labelSuffix: "bystander", title: bystander, date: null }],
    {
      profileId: trashProfileId("TRASH_WEST"),
    }
  );
  const east = await loginAs(browser, {
    username: E2E_LOGIN_TRASH_EAST,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    // The east profile needs something of its own to empty, or "the button did
    // nothing" and "the button worked" are the same page.
    plantTrashCaptures(
      [{ labelSuffix: "own", title: "Trash probe own", date: null }],
      {
        profileId: trashProfileId("TRASH_EAST"),
      }
    );
    await east.goto("/data?section=trash");
    await expect(east.getByTestId("trash-row")).toHaveCount(1);

    await east.getByTestId("trash-empty-all").click();
    await settledClick(
      east,
      east
        .getByTestId("confirm-dialog")
        .getByRole("button", { name: "Empty trash" })
    );
    await expect(east.getByTestId("trash-empty")).toBeVisible();
  } finally {
    await east.context().close();
  }

  // The bystander's capture is untouched — read from the west profile's own page,
  // not from the database, because the claim is about what a person still has.
  const west = await loginAs(browser, {
    username: E2E_LOGIN_TRASH_WEST,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await west.goto("/data?section=trash");
    await expect(trashRow(west, bystander)).toHaveCount(1);
  } finally {
    await west.context().close();
    sweepTrashProbes();
  }
});

// ── WHICH DAY A DELETE IS NAMED BY (#3546) ───────────────────────────────────
//
// The row prints the profile-local calendar day of an INSTANT. It used to print
// `deletedAt.slice(0, 10)` — the UTC day — so a capture deleted at 18:00 in UTC−07:00
// read as tomorrow, beside a countdown computed from the instant and therefore right.
//
// THIS CANNOT BE TESTED ON A PIN-FOLLOWING PROFILE, which is why the fixture exists.
// e2e/pinned-timezone.ts puts local time at 13:mm at every UTC start hour precisely so
// the local date always equals the frozen instant's UTC date — the two agree by
// construction, and a fixture where they agree is green under the bug.
//
// ONE INSTANT, TWO PROFILES, TWO DIFFERENT DAYS. The capture is stamped 11:30 UTC,
// which is the one hour of the day that has already rolled over at UTC+13 and has not
// yet rolled over at UTC−12 (e2e/logins/trash.ts). So the same instant is the day
// AFTER its UTC day in the east and the day BEFORE it in the west, and the truncation
// can only ever answer with the UTC day in the middle — an answer that is wrong on
// both pages here and is asserted absent from both.
test("a Trash row names the profile's own day for the delete instant (#3546)", async ({
  browser,
}) => {
  test.slow();

  // Yesterday's 11:30 UTC: safely in the past, safely inside the retention window,
  // and derived from the run's frozen instant so it moves with the clock the app is
  // pinned to rather than with the host's.
  const utcDay = shiftDateStr(frozenNow().toISOString().slice(0, 10), -1);
  const stamp = `${utcDay} ${TRASH_STRADDLE_HHMMSS}`;

  // The expected days are computed by CALENDAR ARITHMETIC, not by re-running the
  // conversion under test through Intl — otherwise the assertion would agree with the
  // implementation by construction, including when both are wrong.
  const subjects = [
    {
      login: E2E_LOGIN_TRASH_EAST,
      profile: "TRASH_EAST" as const,
      zone: TRASH_EAST_TZ,
      localDay: shiftDateStr(utcDay, 1), // UTC+13 → 11:30Z is already tomorrow
    },
    {
      login: E2E_LOGIN_TRASH_WEST,
      profile: "TRASH_WEST" as const,
      zone: TRASH_WEST_TZ,
      localDay: shiftDateStr(utcDay, -1), // UTC−12 → 11:30Z is still yesterday
    },
  ];
  // The shifts above are only right for THESE offsets. Pinned here so moving a zone in
  // e2e/logins/trash.ts reds this test rather than silently re-aiming it at a day the
  // page no longer prints.
  expect(subjects.map((s) => s.zone)).toEqual(["Etc/GMT-13", "Etc/GMT+12"]);

  const title = "Trash probe local day";
  const label = (day: string) => formatDateWithYear(day, DEFAULT_FORMAT_PREFS);

  try {
    for (const subject of subjects) {
      plantTrashCaptures([{ labelSuffix: "local day", title, date: null }], {
        profileId: trashProfileId(subject.profile),
        deletedAt: stamp,
      });
    }

    for (const subject of subjects) {
      const page = await loginAs(browser, {
        username: subject.login,
        password: E2E_MEMBER_PASSWORD,
      });
      try {
        await page.goto("/data?section=trash");
        const row = trashRow(page, title);
        // Presence first: the day assertions below are about WHICH day is printed,
        // and every one of them would also be satisfied by a page that never
        // rendered the row at all.
        await expect(row).toHaveCount(1);
        await expect(row).toContainText(`Deleted ${label(subject.localDay)}`);
        // The UTC day is what the truncation printed. It is a real, plausible date
        // and it is on neither of these two pages.
        await expect(row).not.toContainText(label(utcDay));
      } finally {
        await page.context().close();
      }
    }
  } finally {
    sweepTrashProbes();
  }
});
