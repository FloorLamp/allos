import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { dismissToast, hydratedClick, settledClick } from "./helpers";
import Database from "better-sqlite3";
import { frozenNow, workerDbPath } from "./worker-env";
import { pinnedTimezone } from "./pinned-timezone";
import { zonedWallTimeToUtc, utcInstant } from "@/lib/date";
import { FAST_MAX_HOURS } from "@/lib/fasting";

// The fasting lifecycle in the real app (#2756) and the stand-down it feeds (#2757).
//
// What is pinned here — the things only a browser proves:
//   • the control renders FROM STATE and its label NAMES the write ("End fast · 16 h");
//   • a second start is refused rather than confirmed, and the refusal writes nothing;
//   • a backdated interval that overlaps an existing fast is refused;
//   • past the plausibility bound the chip escalates to a SUGGEST with two resolutions
//     — and nothing auto-ends, and BOTH the resolutions its copy names actually land,
//     including on a fast past FAST_MAX_HOURS;
//   • a stale tab's Discard, carrying an id the app itself gave it, is refused once that
//     fast was ended elsewhere rather than silently deleting finished history;
//   • the UNDO drawn beside an end is a real way back on a LONG fast, from BOTH controls
//     that end one — the card and the food-log follow-up toast — and is drawn nowhere a
//     restricted profile could tap it;
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

// Insert a fast for profile 1 directly, so a test can start from a chosen state. A
// seeded end is a PLAIN one — its write stamp is the instant it names — which is what
// the app writes when nobody backdates. The two coming apart is the backdated case, and
// this file drives that through the real control rather than seeding it.
function seedFast(startedAt: Date, endedAt: Date | null): number {
  const db = openDb();
  try {
    return Number(
      db
        .prepare(
          `INSERT INTO fasts (profile_id, started_at, ended_at, end_written_at)
           VALUES (1, ?, ?, ?)`
        )
        .run(
          utcInstant(startedAt),
          endedAt ? utcInstant(endedAt) : null,
          endedAt ? utcInstant(endedAt) : null
        ).lastInsertRowid
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

// The `datetime-local` value (`YYYY-MM-DDTHH:MM`) for a wall time `hoursAgo` before the
// frozen now, IN THE RUN'S PINNED ZONE — the same zone the server resolves the field in.
// A host-UTC string here would be judging different hours than the app is (#1417).
function backdateValue(hoursAgo: number): string {
  const { zone } = pinnedTimezone(frozenNow().toISOString());
  const at = new Date(frozenNow().getTime() - hoursAgo * 3_600_000);
  const day = at.toLocaleDateString("en-CA", { timeZone: zone });
  const hhmm = at.toLocaleTimeString("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${day}T${hhmm}`;
}

// Open the backdating disclosure and put a wall time in it. Both steps are PURE CLIENT
// state — the disclosure posts nothing and the field is a controlled input whose value
// only travels when the start/end control is tapped — so this uses hydratedClick and a
// plain fill rather than the settled* helpers, which wait for a Server Action POST that
// correctly never comes.
async function setBackdate(page: Page, hoursAgo: number): Promise<void> {
  await hydratedClick(page, page.getByTestId("fasting-backdate-toggle"));
  const field = page.getByTestId("fasting-backdate-input");
  await expect(field).toBeVisible();
  await field.fill(backdateValue(hoursAgo));
  await expect(field).toHaveValue(backdateValue(hoursAgo));
}

/** Put profile 1's own birthdate back exactly — it is the shared fixture. */
function restoreBirthdate(prior: string | null): void {
  const db = openDb();
  try {
    if (prior === null) {
      db.prepare(
        "DELETE FROM profile_settings WHERE profile_id = 1 AND key = 'birthdate'"
      ).run();
    } else {
      db.prepare(
        `INSERT INTO profile_settings (profile_id, key, value) VALUES (1, 'birthdate', ?)
         ON CONFLICT (profile_id, key) DO UPDATE SET value = excluded.value`
      ).run(prior);
    }
  } finally {
    db.close();
  }
}

// Make profile 1 an INFANT (under one). A second, EARLIER life-stage gate — the Food
// tab's own `isFoodLoggingRelevant` return — sits in FRONT of the fasting one, so this
// is the fixture for the age at which the whole tab is replaced by a note.
function makeInfant(): void {
  setBirthdate(0.5);
}

// Make profile 1 a KNOWN MINOR — the real shape of #2756's scenario ("a birthdate edit
// that makes a profile restricted mid-fast").
function makeMinor(): void {
  setBirthdate(15);
}

// Write profile 1's birthdate `yearsAgo` back. A BIRTHDATE, because that is what
// actually moves `getProfileAge`: it takes precedence over the stored `age` fallback, so
// setting `age` alone on a profile that has a birthdate changes nothing at all.
function setBirthdate(yearsAgo: number): void {
  const db = openDb();
  try {
    const bd = new Date(frozenNow().getTime() - yearsAgo * 365.25 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    db.prepare(
      `INSERT INTO profile_settings (profile_id, key, value) VALUES (1, 'birthdate', ?)
       ON CONFLICT (profile_id, key) DO UPDATE SET value = excluded.value`
    ).run(bd);
    // getProfileAge prefers the birthdate, but clear the fallback too so the fixture
    // leaves exactly one answer in the database.
    db.prepare(
      "DELETE FROM profile_settings WHERE profile_id = 1 AND key = 'age'"
    ).run();
  } finally {
    db.close();
  }
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

    // BACKDATED by 16 h, through the control the stale suggest's copy points at. The
    // e2e clock is FROZEN, so starting and ending at "now" would be a zero-length fast
    // — which the core refuses at the stored second, and which is the honest answer
    // rather than a test-only concession.
    await setBackdate(page, 16);
    await settledClick(page, control);
    // The label now names the END, and carries the elapsed time it will record.
    await expect(control).toContainText("End fast · 16 h");
    // THE FIELD BELONGS TO ONE WRITE. The instant has been CONSUMED, so the disclosure
    // closes and the value is gone. Left in place it would be submitted as the next
    // tap's END time — at or before the start it just created — and the user would meet
    // a refusal about a value no longer on screen. The end below is that assertion's
    // consequence; these two are the property itself.
    await expect(page.getByTestId("fasting-backdate-input")).toHaveCount(0);
    await dismissToast(page, "Fast started.");
    await hydratedClick(page, page.getByTestId("fasting-backdate-toggle"));
    await expect(page.getByTestId("fasting-backdate-input")).toHaveValue("");
    await hydratedClick(page, page.getByTestId("fasting-backdate-toggle"));

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
    await expect(suggest).toContainText(
      "End it at the time you actually stopped"
    );
    await expect(page.getByTestId("fasting-discard")).toBeVisible();
    // The fast is still RUNNING — detection suggests, the tap writes.
    await expect(page.getByTestId("fasting-control")).toContainText("End fast");

    await settledClick(page, page.getByTestId("fasting-discard"));
    await expect(page.getByTestId("fasting-control")).toHaveText("Start fast");
    // Discarded means never-happened: no history row was left behind.
    await expect(page.getByTestId("fasting-history-row")).toHaveCount(0);
  });

  // R2 — THE SUGGEST'S COPY HAS TO NAME A WRITE THAT WORKS. "End it at the time you
  // actually stopped" was false for a fast past FAST_MAX_HOURS: a length guard in
  // `endFast` refused both the plain end and the honest backdated one, leaving only a
  // time the user did not stop, or Discard — "I never actually fasted", which is a
  // different claim and not one the app may steer anyone into.
  test("an honest backdated end lands on a fast past the maximum length", async ({
    page,
  }) => {
    seedFast(agoInstant(FAST_MAX_HOURS + 48), null);
    await page.goto("/nutrition");
    await expect(page.getByTestId("fasting-stale-suggest")).toContainText(
      "End it at the time you actually stopped"
    );

    // Do the thing the sentence says: set the time you actually stopped, then end.
    await setBackdate(page, 3);
    await settledClick(page, page.getByTestId("fasting-control"));
    const ended = page.getByTestId("toast").filter({ hasText: "Fast ended." });
    await expect(ended).toBeVisible();

    // F4 — AND LOOK AT THE UNDO IN THAT SAME TOAST. This test used to stop one assertion
    // short of the surface's own rule (it does not draw a control whose every tap would
    // be refused) while the plain-end case two tests down asserted exactly that. The
    // backdated end is where the rule broke: the Undo's age bound read the instant the
    // end NAMED rather than the instant it was WRITTEN, so a three-hour backdate was
    // `too-old` the moment it landed, and behind that refusal was no way back at all.
    const undo = ended.getByRole("button", { name: "Undo" });
    await expect(undo).toBeVisible();

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
    // …and it is recorded as a completed fast rather than discarded.
    await expect(page.getByTestId("fasting-history-row")).toHaveCount(1);

    // The drawn button LANDS — the assertion that separates "an Undo is shown" from "an
    // Undo works", and the one the fourth review found missing here.
    await settledClick(page, undo);
    await expect(
      page.getByTestId("toast").filter({ hasText: "Fast reopened." })
    ).toBeVisible();
    await expect(page.getByTestId("fasting-control")).toContainText("End fast");
    await expect(page.getByTestId("fasting-history-row")).toHaveCount(0);
  });

  // F1 — THE FULL SURFACE'S UNDO, ON A LONG FAST. The one combination the neighbouring
  // cases never reached: the restricted close-out past the maximum is pinned below, and
  // so is the restricted Undo's refusal on a 16 h fast, but not the ordinary card's Undo
  // on the forgotten fast — which is the case the stale suggest exists to surface, and
  // the case a claim ceiling inside `reopenFast` turned into a dead button. The end lands
  // (no ceiling there, by R1) and the Undo beside it then answered "That fast would be
  // too long to reopen" with NOTHING behind it: discard refuses a completed row, there is
  // no edit core, and the permanent long row answers `overlap` to every backdated start
  // inside the fortnight the field can reach.
  test("the Undo drawn on a LONG fast's end takes it back", async ({
    page,
  }) => {
    seedFast(agoInstant(FAST_MAX_HOURS + 96), null);
    await page.goto("/nutrition");
    await expect(page.getByTestId("fasting-stale-suggest")).toBeVisible();
    await settledClick(page, page.getByTestId("fasting-control"));
    const ended = page.getByTestId("toast").filter({ hasText: "Fast ended." });
    await expect(ended).toBeVisible();

    // The button is drawn — this is the assertion the surface's own rule turns on: it
    // does not draw a control whose every tap would be refused.
    const undo = ended.getByRole("button", { name: "Undo" });
    await expect(undo).toBeVisible();
    await settledClick(page, undo);
    await expect(
      page.getByTestId("toast").filter({ hasText: "Fast reopened." })
    ).toBeVisible();

    // The state is back exactly where it was: the same row, open again, and no completed
    // fast left behind.
    const db = openDb();
    try {
      const rows = db
        .prepare("SELECT COUNT(*) AS n FROM fasts WHERE profile_id = 1")
        .get() as { n: number };
      expect(rows.n).toBe(1);
      const open = db
        .prepare(
          "SELECT COUNT(*) AS n FROM fasts WHERE profile_id = 1 AND ended_at IS NULL"
        )
        .get() as { n: number };
      expect(open.n).toBe(1);
    } finally {
      db.close();
    }

    // And it is a real way BACK, not just a state change: the reopened fast lands in the
    // state the stale suggest handles, where both of that copy's resolutions are on
    // screen again.
    await page.reload();
    await expect(page.getByTestId("fasting-stale-suggest")).toBeVisible();
    await expect(page.getByTestId("fasting-discard")).toBeVisible();
    await expect(page.getByTestId("fasting-backdate-toggle")).toBeVisible();
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
      page
        .getByTestId("toast")
        .filter({ hasText: "A fast is already running." })
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

  // R3 — THE SAME STALE TAB, HOLDING DISCARD. The button is drawn on the stale suggest
  // and carries the ACTIVE fast's id; when that fast is ended somewhere else the id now
  // names finished history. This is the app's own button with a now-wrong id, not a
  // crafted one — and without a state re-derivation it deletes a completed fast with no
  // confirmation and no undo, while answering "Discarded."
  test("a STALE tab's discard is refused once the fast was ended elsewhere", async ({
    page,
  }) => {
    seedFast(agoInstant(40), null);
    await page.goto("/nutrition");
    await expect(page.getByTestId("fasting-discard")).toBeVisible();

    // The fast is ended on the other device, and the next one begins.
    const db = openDb();
    try {
      db.prepare(
        "UPDATE fasts SET ended_at = ? WHERE profile_id = 1 AND ended_at IS NULL"
      ).run(utcInstant(agoInstant(1)));
    } finally {
      db.close();
    }
    seedFast(agoInstant(0.5), null);

    await settledClick(page, page.getByTestId("fasting-discard"));
    await expect(
      page
        .getByTestId("toast")
        .filter({ hasText: "That fast has already ended." })
    ).toBeVisible();

    // BOTH rows survive: the completed one was not destroyed and the running one was
    // never touched.
    const after = openDb();
    try {
      const rows = after
        .prepare("SELECT COUNT(*) AS n FROM fasts WHERE profile_id = 1")
        .get() as { n: number };
      expect(rows.n).toBe(2);
      const open = after
        .prepare(
          "SELECT COUNT(*) AS n FROM fasts WHERE profile_id = 1 AND ended_at IS NULL"
        )
        .get() as { n: number };
      expect(open.n).toBe(1);
    } finally {
      after.close();
    }
  });

  test("a backdated start overlapping a recorded fast is REFUSED", async ({
    page,
  }) => {
    // A completed fast covering [-6 h, -3 h], and nothing open.
    seedFast(agoInstant(6), agoInstant(3));
    await page.goto("/nutrition");
    await expect(page.getByTestId("fasting-control")).toHaveText("Start fast");

    // Submit a start backdated to -8 h: an OPEN fast runs to +infinity, so this one
    // would swallow the recorded fast entirely. Backdating can never manufacture an
    // overlap, and this is the assertion that says so.
    await setBackdate(page, 8);
    await settledClick(page, page.getByTestId("fasting-control"));
    await expect(
      page
        .getByTestId("toast")
        .filter({ hasText: "That overlaps a fast already on record." })
    ).toBeVisible();

    const db = openDb();
    try {
      const rows = db
        .prepare("SELECT COUNT(*) AS n FROM fasts WHERE profile_id = 1")
        .get() as { n: number };
      // The refusal wrote nothing: still just the one recorded fast.
      expect(rows.n).toBe(1);
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

  test("a backdated start that clears the recorded fast is accepted", async ({
    page,
  }) => {
    // The same seeded history, backdated to -2 h — after the recorded fast ended, so
    // there is no collision and the write lands with its elapsed time on the label.
    seedFast(agoInstant(6), agoInstant(3));
    await page.goto("/nutrition");
    await setBackdate(page, 2);
    await settledClick(page, page.getByTestId("fasting-control"));
    await expect(page.getByTestId("fasting-control")).toContainText(
      "End fast · 2 h"
    );
  });

  // #2993 — THE RECORDED FAST WITH A MIS-SET DATE, CORRECTED IN PLACE.
  //
  // The state this whole issue is about: a fast recorded as 360 hours, the Undo long
  // since gone, reopen answering `too-old` and discard refusing a completed row. The row
  // was permanent, and it then answered `overlap` to every backdated start inside the
  // fortnight it covers.
  //
  // The remedy is an EDIT and not a delete, on the owner's reasoning: removing the row
  // asserts the fast never happened, while correcting its end asserts what actually did.
  // This drives the whole of it in a browser, because a core with no reachable surface is
  // precisely the failure this issue exists to correct — `editFast` shipped once with no
  // Server Action, was filed as dead code, and was deleted.
  test("a fast recorded with a mis-set date is CORRECTED from its history row", async ({
    page,
  }) => {
    seedFast(agoInstant(FAST_MAX_HOURS + 48), agoInstant(24));
    await page.goto("/nutrition");

    const row = page.getByTestId("fasting-history-row");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("360 h");

    // FIRST, THE DAMAGE — a start backdated into the span the bogus row covers is
    // refused, which is what "the user cannot record any real fast starting inside the
    // fortnight" means from the outside.
    await setBackdate(page, 120);
    await settledClick(page, page.getByTestId("fasting-control"));
    await expect(
      page
        .getByTestId("toast")
        .filter({ hasText: "That overlaps a fast already on record." })
    ).toBeVisible();
    await dismissToast(page, "That overlaps a fast already on record.");

    // NOW CORRECT IT. The form opens prefilled with the times the row actually carries —
    // the ordinary correction moves one of the two — and the end is set to sixteen hours
    // after the start, which is what the fast really was.
    await hydratedClick(page, page.getByTestId("fasting-edit-toggle"));
    const startField = page.getByTestId("fasting-edit-start");
    const endField = page.getByTestId("fasting-edit-end");
    await expect(startField).toHaveValue(backdateValue(FAST_MAX_HOURS + 48));
    await expect(endField).toHaveValue(backdateValue(24));
    await endField.fill(backdateValue(FAST_MAX_HOURS + 32));
    await settledClick(page, page.getByTestId("fasting-edit-save"));
    await expect(
      page.getByTestId("toast").filter({ hasText: "Fast updated." })
    ).toBeVisible();
    await dismissToast(page, "Fast updated.");

    // Still ONE recorded fast — corrected, not removed.
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("16 h 0 m");

    const db = openDb();
    try {
      const stored = db
        .prepare(
          "SELECT ended_at, end_written_at FROM fasts WHERE profile_id = 1"
        )
        .get() as { ended_at: string; end_written_at: string };
      expect(stored.ended_at).toBe(utcInstant(agoInstant(FAST_MAX_HOURS + 32)));
      // The Undo's clock is NOT restarted by a correction: `end_written_at` still names
      // the write that closed the fast, so an old row does not become reopenable by
      // having its date fixed.
      expect(stored.end_written_at).toBe(utcInstant(agoInstant(24)));
    } finally {
      db.close();
    }

    // AND THE DAMAGE IS UNDONE. The identical backdated start, refused above, now lands.
    await setBackdate(page, 120);
    await settledClick(page, page.getByTestId("fasting-control"));
    await expect(page.getByTestId("fasting-control")).toContainText("End fast");
  });
});

// D3 — THE EXEMPTION'S ESCAPE HATCH HAS TO BE ON SCREEN.
//
// The write core lets a restricted profile END a fast it already has, so it cannot be
// stranded mid-fast with its food nudges stood down. That promise is only kept if the
// SURFACE renders the close-out: a gate whose escape hatch is never drawn is the same
// stranded row with extra steps.
//
// This walks the real sequence — an adult starts a fast, the birthdate is corrected to a
// minor's, and the page is reloaded — and asserts the way out is there and works.
test.describe("a profile restricted MID-FAST can still close it out (#2756)", () => {
  test.beforeEach(clearFasts);

  // The profile's own birthdate, saved and restored EXACTLY — profile 1 is the shared
  // fixture and every other spec reads its age.
  let priorBirthdate: string | null = null;

  test.beforeEach(() => {
    const db = openDb();
    try {
      const row = db
        .prepare(
          "SELECT value FROM profile_settings WHERE profile_id = 1 AND key = 'birthdate'"
        )
        .get() as { value: string } | undefined;
      priorBirthdate = row?.value ?? null;
    } finally {
      db.close();
    }
  });

  test.afterEach(() => {
    clearFasts();
    restoreBirthdate(priorBirthdate);
  });

  test("renders the close-out control, and nothing else", async ({ page }) => {
    seedFast(agoInstant(16), null);
    makeMinor();

    await page.goto("/nutrition");
    // The card IS rendered — this is the assertion that fails if the surface gates on
    // `fastingAvailable` alone.
    await expect(page.getByTestId("fasting-card")).toBeVisible();
    await expect(page.getByTestId("fasting-closeout-note")).toBeVisible();
    // …and it offers ONLY the way out. No start, no history, no elapsed framing: this is
    // harm-reduction, not tracking.
    //
    // THESE toHaveCount(0)s ARE A DEBT, NOT JUST AN ASSERTION. They say the close-out
    // control is the entire surface, which makes any refusal `endFast` can return a dead
    // end rather than a message — there is no second control to reach for. This test
    // once pinned that minimal surface while the core had grown a `too-long` refusal, so
    // the pair of them stranded every fast older than 14 days and neither half looked
    // wrong on its own. The long case is now exercised directly, below.
    await expect(page.getByTestId("fasting-control")).toHaveText("End fast");
    await expect(page.getByTestId("fasting-history-row")).toHaveCount(0);
    await expect(page.getByTestId("fasting-backdate-toggle")).toHaveCount(0);
    await expect(page.getByTestId("fasting-stale-suggest")).toHaveCount(0);
    await expect(page.getByTestId("fasting-discard")).toHaveCount(0);
    // …and no correction control either (#2993). Editing a recorded interval is
    // recording fasting content, so `editFast` is GATED like the start is. Both halves
    // are pinned — the core's refusal at the DB tier, the absent control here.
    await expect(page.getByTestId("fasting-edit-toggle")).toHaveCount(0);

    // And it WORKS — the exempt end path, reached from the rendered control.
    await settledClick(page, page.getByTestId("fasting-control"));
    const ended = page.getByTestId("toast").filter({ hasText: "Fast ended." });
    await expect(ended).toBeVisible();
    // …and it offers NO UNDO. Reopening is the one thing the gate withholds, so the core
    // would refuse every tap of it — and no surface draws a control whose every tap is a
    // refusal, which is the same reason there is no start control here. That now holds
    // because the ACTION withholds the id the button needs, rather than because this
    // branch passes a flag: the food-log toast, which never had such a flag, inherits it.
    // The core's refusal is still the real gate, pinned by the stale-tab case below.
    await expect(ended.getByRole("button", { name: "Undo" })).toHaveCount(0);

    const after = openDb();
    try {
      const open = after
        .prepare(
          "SELECT COUNT(*) AS n FROM fasts WHERE profile_id = 1 AND ended_at IS NULL"
        )
        .get() as { n: number };
      expect(open.n).toBe(0);
    } finally {
      after.close();
    }

    // With the fast closed, the surface goes away entirely — a restricted profile sees
    // no fasting content once there is nothing left to close.
    await page.reload();
    await expect(page.getByTestId("fasting-card")).toHaveCount(0);
  });

  // R1 — THE SAME SURFACE, PAST FAST_MAX_HOURS. The case the minimal-surface test above
  // never reached, and the one where "one button and nothing else" stops being a design
  // choice and starts being a trap: with a length refusal in `endFast`, the single
  // control this profile can see was refused on every tap, forever. No backdating is
  // needed to get here — a plain start and 14 days of clock does it.
  test("closes out a fast that is PAST the maximum length", async ({
    page,
  }) => {
    seedFast(agoInstant(FAST_MAX_HOURS + 72), null);
    makeMinor();

    await page.goto("/nutrition");
    await expect(page.getByTestId("fasting-card")).toBeVisible();
    // Still one button, and still no other way out on screen — which is exactly why it
    // has to work.
    await expect(page.getByTestId("fasting-control")).toHaveText("End fast");
    await expect(page.getByTestId("fasting-backdate-toggle")).toHaveCount(0);
    await expect(page.getByTestId("fasting-discard")).toHaveCount(0);

    await settledClick(page, page.getByTestId("fasting-control"));
    await expect(
      page.getByTestId("toast").filter({ hasText: "Fast ended." })
    ).toBeVisible();

    const after = openDb();
    try {
      const open = after
        .prepare(
          "SELECT COUNT(*) AS n FROM fasts WHERE profile_id = 1 AND ended_at IS NULL"
        )
        .get() as { n: number };
      expect(open.n).toBe(0);
    } finally {
      after.close();
    }

    await page.reload();
    await expect(page.getByTestId("fasting-card")).toHaveCount(0);
  });

  // F3 — THE SAME TRAP, ONE GATE EARLIER. The Food tab returns its infant note BEFORE it
  // gathers anything fasting, so a profile whose known age drops under one got no card at
  // all — an active row, #2757's food stand-down behind it, and nothing on screen. Same
  // shape as the mid-fast birthdate edit above; a different `return` reaches it.
  test("an INFANT profile mid-fast still gets the close-out", async ({
    page,
  }) => {
    seedFast(agoInstant(16), null);
    makeInfant();

    await page.goto("/nutrition");
    // The tab is gated exactly as it was — the note stands, the logger does not render.
    await expect(page.getByTestId("nutrition-infant-note")).toBeVisible();
    await expect(page.getByTestId("food-log-bar")).toHaveCount(0);

    // …and the way out is there, with the same minimal surface a restricted profile gets.
    await expect(page.getByTestId("fasting-closeout-note")).toBeVisible();
    await expect(page.getByTestId("fasting-control")).toHaveText("End fast");
    await expect(page.getByTestId("fasting-history-row")).toHaveCount(0);

    await settledClick(page, page.getByTestId("fasting-control"));
    const ended = page.getByTestId("toast").filter({ hasText: "Fast ended." });
    await expect(ended).toBeVisible();
    // No Undo: reopening is what the gate withholds, and the ACTION is what withholds the
    // id the button needs — so this holds on a surface that never passed a flag.
    await expect(ended.getByRole("button", { name: "Undo" })).toHaveCount(0);

    const after = openDb();
    try {
      const open = after
        .prepare(
          "SELECT COUNT(*) AS n FROM fasts WHERE profile_id = 1 AND ended_at IS NULL"
        )
        .get() as { n: number };
      expect(open.n).toBe(0);
    } finally {
      after.close();
    }

    // With nothing left to close, the card goes away and only the note remains.
    await page.reload();
    await expect(page.getByTestId("nutrition-infant-note")).toBeVisible();
    await expect(page.getByTestId("fasting-card")).toHaveCount(0);
  });

  test("the end's Undo is REFUSED — reopening would re-create an active fast", async ({
    page,
  }) => {
    seedFast(agoInstant(16), null);
    await page.goto("/nutrition");
    // End it as an adult, so the Undo affordance is the one the app itself offered.
    await settledClick(page, page.getByTestId("fasting-control"));
    const ended = page.getByTestId("toast").filter({ hasText: "Fast ended." });
    await expect(ended).toBeVisible();

    // The birthdate is corrected before the Undo is tapped.
    makeMinor();

    await settledClick(page, ended.getByRole("button", { name: "Undo" }));
    await expect(
      page
        .getByTestId("toast")
        .filter({ hasText: "Fasting isn't available on this profile." })
    ).toBeVisible();

    // Nothing was reopened: clearing `ended_at` is how an ACTIVE fast comes to exist,
    // and that is exactly what the gate withholds.
    const after = openDb();
    try {
      const open = after
        .prepare(
          "SELECT COUNT(*) AS n FROM fasts WHERE profile_id = 1 AND ended_at IS NULL"
        )
        .get() as { n: number };
      expect(open.n).toBe(0);
    } finally {
      after.close();
    }
  });
});

// The quick set the log bar draws is RANKED PER WINDOW (#2369/#1980), and which window
// is current depends on the run's frozen instant in the run's rotating pinned zone — so a
// group that is on screen in one run's slot is folded into the "more groups" disclosure
// in the next run's. Reveal the subject rather than assuming it, exactly as every other
// food spec here does (e2e/food-log.spec.ts, e2e/food-limit-note.spec.ts). Without this
// the assertion under test is only reached in the hours where the ranking happens to
// cooperate, which is a spec that reports on the clock rather than on the code.
async function revealFoodGroup(page: Page, slug: string): Promise<void> {
  const row = page.getByTestId(`food-group-${slug}`);
  if (!(await row.isVisible())) {
    await page.getByTestId("food-more-groups-summary").click();
    await expect(row).toBeVisible();
  }
}

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
    await revealFoodGroup(page, group);
    const count = page.getByTestId(`count-${group}`);
    const before = Number((await count.textContent())?.trim() || "0");

    await settledClick(page, page.getByTestId(`log-${group}`));

    // THE SERVING LANDS. The prompt is a follow-up offer beside a successful write, not
    // a confirm-before-write — dueness gates nudging, never logging.
    await expect(count).toHaveText(String(before + 1));

    const offer = page
      .getByTestId("toast")
      .filter({ hasText: "End your fast?" });
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

    await revealFoodGroup(page, "legumes");
    await settledClick(page, page.getByTestId("log-legumes"));
    const offer = page
      .getByTestId("toast")
      .filter({ hasText: "End your fast?" });
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

  // F2 — THE SAME UNDO, FROM THE OTHER CONTROL. This toast is the likelier route into a
  // long fast's end, not the rarer one: `promptsEndOfFast` carries no staleness term, so
  // it fires just as readily for a fast open for weeks — and by then #2757's stand-down
  // has released, so food nudges are back on and the user is MORE likely to be here
  // logging a serving. It used to replace itself with the bare confirmation and attach
  // nothing, so one tap wrote a very long fast with no way back beside it.
  test("accepting the offer offers the SAME Undo the card does", async ({
    page,
  }) => {
    seedFast(agoInstant(FAST_MAX_HOURS + 96), null);
    await page.goto("/nutrition");
    await expect(page.getByTestId("food-log-bar")).toBeVisible();

    await revealFoodGroup(page, "legumes");
    await settledClick(page, page.getByTestId("log-legumes"));
    const offer = page
      .getByTestId("toast")
      .filter({ hasText: "End your fast?" });
    await expect(offer).toBeVisible();
    await settledClick(page, offer.getByRole("button", { name: "End fast" }));

    const ended = page.getByTestId("toast").filter({ hasText: "Fast ended." });
    await expect(ended).toBeVisible();
    await settledClick(page, ended.getByRole("button", { name: "Undo" }));
    await expect(
      page.getByTestId("toast").filter({ hasText: "Fast reopened." })
    ).toBeVisible();

    const db = openDb();
    try {
      const open = db
        .prepare(
          "SELECT COUNT(*) AS n FROM fasts WHERE profile_id = 1 AND ended_at IS NULL"
        )
        .get() as { n: number };
      expect(open.n).toBe(1);
    } finally {
      db.close();
    }
  });

  test("with no fast running, logging a serving offers nothing", async ({
    page,
  }) => {
    await page.goto("/nutrition");
    await expect(page.getByTestId("food-log-bar")).toBeVisible();
    await revealFoodGroup(page, "legumes");
    await settledClick(page, page.getByTestId("log-legumes"));
    await expect(
      page.getByTestId("toast").filter({ hasText: "End your fast?" })
    ).toHaveCount(0);
  });
});
