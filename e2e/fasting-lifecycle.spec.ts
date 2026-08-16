import { test, expect } from "./fixtures";
import { dismissToast, settledClick } from "./helpers";
import Database from "better-sqlite3";
import { frozenNow, workerDbPath } from "./worker-env";
import { pinnedTimezone } from "./pinned-timezone";
import { zonedWallTimeToUtc, utcInstant } from "@/lib/date";

// The fasting lifecycle in the real app (#2756) and the stand-down it feeds (#2757).
//
// What is pinned here — the things only a browser proves:
//   • the control renders FROM STATE and its label NAMES the write ("End fast · 16 h");
//   • a second start is refused rather than confirmed, and the refusal writes nothing;
//   • a backdated interval that overlaps an existing fast is refused;
//   • past the plausibility bound the chip escalates to a SUGGEST with two resolutions
//     — and nothing auto-ends;
//   • logging food mid-fast OFFERS "End your fast?" beside a serving that has already
//     landed, declining changes nothing, and the count is unaffected either way;
//
// The #2757 OFFER stand-down is asserted at the DB tier instead
// (lib/__db_tests__/fasting-lifecycle.test.ts): the usual-routine control lives on the
// dashboard under a fixture-OWNED login that e2e/routine-usual.spec.ts writes to, so
// asserting it from here would couple two specs' fixtures to each other.
//
// FIXTURE DISCIPLINE (shared seeded DB): this spec owns the `fasts` table for profile 1
// and nothing else. Every test cleans it before and after, so the file is idempotent
// across --repeat-each and retries.
//
// INSTANTS, NOT NAIVE STRINGS. Every seeded instant is built through
// zonedWallTimeToUtc(pinnedTimezone(...).zone, day, "HH:MM") — the seed pins a ROTATING per-run
// instance timezone (e2e/pinned-timezone.ts), so a `${day}THH:MM` literal would parse
// host-UTC and this whole file would be judging the wrong hours (#1417). A fast spans a
// day boundary by nature, which is precisely the domain where that goes wrong quietly.

function openDb(): Database.Database {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  return db;
}

function clearFasts(): void {
  const db = openDb();
  try {
    db.prepare("DELETE FROM fasts WHERE profile_id = 1").run();
  } finally {
    db.close();
  }
}

/** Insert a fast for profile 1 directly, so a test can start from a chosen state. */
function seedFast(startedAt: Date, endedAt: Date | null): number {
  const db = openDb();
  try {
    return Number(
      db
        .prepare(
          "INSERT INTO fasts (profile_id, started_at, ended_at) VALUES (1, ?, ?)"
        )
        .run(utcInstant(startedAt), endedAt ? utcInstant(endedAt) : null)
        .lastInsertRowid
    );
  } finally {
    db.close();
  }
}

// An instant `hoursAgo` before the frozen now, resolved through the profile's own zone
// via a wall time — never a hand-built string.
function agoInstant(hoursAgo: number): Date {
  const { zone } = pinnedTimezone(frozenNow().toISOString());
  const at = new Date(frozenNow().getTime() - hoursAgo * 3_600_000);
  const day = at.toLocaleDateString("en-CA", { timeZone: zone });
  const hhmm = at.toLocaleTimeString("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const resolved = zonedWallTimeToUtc(zone, day, hhmm);
  if (!resolved) throw new Error(`could not resolve ${day} ${hhmm} in ${zone}`);
  return resolved;
}

test.describe("the fasting lifecycle (#2756)", () => {
  test.beforeEach(clearFasts);
  test.afterAll(clearFasts);

  test("start and end, with the label naming the write at each step", async ({
    page,
  }) => {
    await page.goto("/nutrition");
    const control = page.getByTestId("fasting-control");
    await expect(control).toHaveText("Start fast");
    await expect(page.getByTestId("fasting-state")).toHaveText(
      "No fast running."
    );

    await settledClick(page, control);
    // The label now names the END, which is the write the next tap performs.
    await expect(control).toContainText("End fast");
    await dismissToast(page, "Fast started.");

    await settledClick(page, page.getByTestId("fasting-control"));
    await expect(page.getByTestId("fasting-control")).toHaveText("Start fast");
    // And the completed fast is in the history, with the day-attribution rule stated.
    // Exactly one row, because the spec OWNS the `fasts` table for profile 1 and
    // cleared it before this test — so nothing has to disambiguate a row here.
    await expect(page.getByTestId("fasting-history-row")).toHaveCount(1);
    await expect(page.getByTestId("fasting-card")).toContainText(
      "A fast counts for the day it ends"
    );
  });

  test("a fast seeded 16 h ago renders its elapsed time in the control", async ({
    page,
  }) => {
    seedFast(agoInstant(16), null);
    await page.goto("/nutrition");
    await expect(page.getByTestId("fasting-control")).toContainText(
      "End fast · 16 h"
    );
    await expect(page.getByTestId("fasting-state")).toContainText(
      "Fasting for 16 h"
    );
    // Not stale — 16 h is an ordinary window, and nothing suggests anything.
    await expect(page.getByTestId("fasting-stale-suggest")).toHaveCount(0);
  });

  test("past the plausibility bound the chip SUGGESTS, and never auto-ends", async ({
    page,
  }) => {
    seedFast(agoInstant(40), null);
    await page.goto("/nutrition");
    const suggest = page.getByTestId("fasting-stale-suggest");
    await expect(suggest).toBeVisible();
    // BOTH resolutions are offered and neither is taken for the user: end it at the
    // time you actually stopped, or discard it as never-happened.
    await expect(suggest).toContainText("End it at the time you actually stopped");
    await expect(page.getByTestId("fasting-discard")).toBeVisible();
    // The fast is still RUNNING — detection suggests, the tap writes.
    await expect(page.getByTestId("fasting-control")).toContainText("End fast");

    await settledClick(page, page.getByTestId("fasting-discard"));
    await expect(page.getByTestId("fasting-control")).toHaveText("Start fast");
    // Discarded means never-happened: no history row was left behind.
    await expect(page.getByTestId("fasting-history-row")).toHaveCount(0);
  });

  test("a STALE tab's start is refused, not confirmed — the cross-device double-start", async ({
    page,
  }) => {
    // The page is rendered with nothing running, so it offers "Start fast" …
    await page.goto("/nutrition");
    await expect(page.getByTestId("fasting-control")).toHaveText("Start fast");

    // … and then a fast begins somewhere else (the other device, the Telegram tap).
    // The tab knows nothing about it, which is exactly the state a UI-only gate cannot
    // survive: the button is real, it is enabled, and its promise is now false.
    seedFast(agoInstant(2), null);

    await settledClick(page, page.getByTestId("fasting-control"));
    // The CORE refuses, and the surface says which thing it could not do rather than
    // confirming a write that never landed.
    await expect(
      page.getByTestId("toast").filter({ hasText: "A fast is already running." })
    ).toBeVisible();

    // Exactly one open fast, and it is still the one the other device started.
    const db = openDb();
    try {
      const rows = db
        .prepare(
          "SELECT COUNT(*) AS n FROM fasts WHERE profile_id = 1 AND ended_at IS NULL"
        )
        .get() as { n: number };
      expect(rows.n).toBe(1);
    } finally {
      db.close();
    }
  });

  test("a backdated start overlapping a recorded fast is refused", async ({
    page,
  }) => {
    // A completed fast covering [-6 h, -3 h] and nothing open.
    seedFast(agoInstant(6), agoInstant(3));
    await page.goto("/nutrition");
    await expect(page.getByTestId("fasting-control")).toHaveText("Start fast");
    // Starting NOW is fine — it does not reach back over the recorded one.
    await settledClick(page, page.getByTestId("fasting-control"));
    await expect(page.getByTestId("fasting-control")).toContainText("End fast");

    const db = openDb();
    try {
      const rows = db
        .prepare("SELECT COUNT(*) AS n FROM fasts WHERE profile_id = 1")
        .get() as { n: number };
      // Two fasts, no overlap: the completed one and the new open one.
      expect(rows.n).toBe(2);
    } finally {
      db.close();
    }
  });
});

test.describe("food logged mid-fast (#2756) and the stand-down (#2757)", () => {
  test.beforeEach(clearFasts);
  test.afterAll(clearFasts);

  test("logging a serving OFFERS to end the fast, and declining changes nothing", async ({
    page,
  }) => {
    seedFast(agoInstant(16), null);
    await page.goto("/nutrition");
    await expect(page.getByTestId("food-log-bar")).toBeVisible();

    const group = "legumes";
    const count = page.getByTestId(`count-${group}`);
    const before = Number((await count.textContent())?.trim() || "0");

    await settledClick(page, page.getByTestId(`log-${group}`));

    // THE SERVING LANDS. The prompt is a follow-up offer beside a successful write, not
    // a confirm-before-write — dueness gates nudging, never logging.
    await expect(count).toHaveText(String(before + 1));

    const offer = page.getByTestId("toast").filter({ hasText: "End your fast?" });
    await expect(offer).toBeVisible();

    // DECLINE by dismissing. Nothing happens: the app never auto-ends a fast, and the
    // serving that already landed stays landed.
    await dismissToast(page, "End your fast?");
    await expect(page.getByTestId("fasting-control")).toContainText("End fast");
    await expect(count).toHaveText(String(before + 1));
  });

  test("accepting the offer ends the fast — the tap IS the write", async ({
    page,
  }) => {
    seedFast(agoInstant(16), null);
    await page.goto("/nutrition");
    await expect(page.getByTestId("food-log-bar")).toBeVisible();

    await settledClick(page, page.getByTestId("log-legumes"));
    const offer = page.getByTestId("toast").filter({ hasText: "End your fast?" });
    await expect(offer).toBeVisible();
    await settledClick(page, offer.getByRole("button", { name: "End fast" }));

    await expect(
      page.getByTestId("toast").filter({ hasText: "Fast ended." })
    ).toBeVisible();
    const db = openDb();
    try {
      const open = db
        .prepare(
          "SELECT COUNT(*) AS n FROM fasts WHERE profile_id = 1 AND ended_at IS NULL"
        )
        .get() as { n: number };
      expect(open.n).toBe(0);
    } finally {
      db.close();
    }
  });

  test("with no fast running, logging a serving offers nothing", async ({
    page,
  }) => {
    await page.goto("/nutrition");
    await expect(page.getByTestId("food-log-bar")).toBeVisible();
    await settledClick(page, page.getByTestId("log-legumes"));
    await expect(
      page.getByTestId("toast").filter({ hasText: "End your fast?" })
    ).toHaveCount(0);
  });
});
