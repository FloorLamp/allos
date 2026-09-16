import { test, expect } from "./fixtures";
import { type Locator, type Request } from "@playwright/test";
import Database from "better-sqlite3";
import { hydratedClick, settledClick, settledFill } from "./helpers";
import { frozenNow, workerDbPath } from "./worker-env";
import { pinnedTimezone } from "./pinned-timezone";
import { dateStrInTz, zonedWallIsoToUtc, zonedWallTimeToUtc } from "@/lib/date";

// Bristol stool form, end to end (issue #2785).
//
// What only a browser can prove here is that the seven buttons ARE the entry surface:
// the number is never typed, so the guard against a 0 or an 8 is not a validator the
// user can route around — there is no field to route around it with. The spec therefore
// asserts the vocabulary the picker actually renders, taps one, and reads the row back
// out of the store the placement decision put it in.
//
// It also pins the panel's ONE presentation rule: a day is rendered by its TYPES, never
// by an average of them. A day carrying type 1 and type 7 must show both marks — an
// averaged surface would show one mark at 4, the middle of the scale.

const DB_PATH = workerDbPath();
// `stool_events` holds CANONICAL UTC instants, so rendering one back as the wall clock
// a surface prints needs the run's rotating instance timezone (e2e/pinned-timezone.ts).
const TZ = pinnedTimezone(frozenNow().toISOString()).zone;

function clearBristol(): void {
  const db = new Database(DB_PATH);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare("DELETE FROM stool_events WHERE profile_id = 1").run();
  } finally {
    db.close();
  }
}

interface BristolRow {
  id: number;
  date: string;
  /**
   * The row's BEST-KNOWN instant as a profile-local `YYYY-MM-DDTHH:MM:SS` — the stated
   * movement instant when there is one, the tap stamp otherwise.
   *
   * PROJECTED, not stored. The ledger keeps canonical UTC (#5872); this is the shape
   * the surfaces under test actually render, and it is also the shape the samples table
   * stored, so the assertions below go on saying what they always said. Where the
   * DISTINCTION matters — whether anybody stated a time at all — the raw columns beside
   * it are what the case reads.
   */
  started_at: string;
  /** The stored type, or null for an occurrence nobody saw the form of. */
  value: number | null;
  /** The stated movement instant, canonical UTC. NULL means nobody stated one. */
  occurred_at: string | null;
  time_source: string | null;
}

function bristolRows(): BristolRow[] {
  const db = new Database(DB_PATH);
  try {
    const rows = db
      .prepare(
        `SELECT id, date, type AS value, occurred_at, recorded_at, time_source
           FROM stool_events
          WHERE profile_id = 1
          ORDER BY COALESCE(occurred_at, recorded_at), id`
      )
      .all() as (Omit<BristolRow, "started_at"> & { recorded_at: string })[];
    return rows.map(({ recorded_at, ...row }) => ({
      ...row,
      started_at: localWall(row.occurred_at ?? recorded_at),
    }));
  } finally {
    db.close();
  }
}

/** A canonical UTC instant as the profile-local `YYYY-MM-DDTHH:MM:SS` a surface shows. */
function localWall(at: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(at));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

function seedBristol(date: string, hhmmss: string, type: number): void {
  const db = new Database(DB_PATH);
  try {
    db.pragma("busy_timeout = 5000");
    // A SEEDED ROW IS A STATED ONE. The fixture is standing in for a movement somebody
    // timed, so it writes `occurred_at` + `time_source = 'stated'` — built through
    // zonedWallTimeToUtc against the run's rotating zone, because the column is a
    // canonical UTC instant now rather than the local string the samples table held.
    const at = zonedWallTimeToUtc(TZ, date, hhmmss.slice(0, 5))!;
    const seconds = Number(hhmmss.slice(6, 8));
    const instant =
      new Date(at.getTime() + seconds * 1000).toISOString().slice(0, 19) + "Z";
    db.prepare(
      `INSERT INTO stool_events
         (profile_id, date, recorded_at, occurred_at, time_source, type)
       VALUES (1, ?, ?, ?, 'stated', ?)`
    ).run(date, instant, instant, type);
  } finally {
    db.close();
  }
}

/** One receipt row, addressed by the `stool_events` id the store gave it. */
function receiptFor(picker: Locator, id: number): Locator {
  return picker.locator(
    `[data-testid="quick-entry-stool-receipt"][data-reading-id="${id}"]`
  );
}

test.beforeEach(() => clearBristol());
test.afterEach(() => clearBristol());

test("the picker offers exactly the seven types and logs the tapped one", async ({
  page,
}) => {
  // The same overlay the sheet's Body segment opens, reached by url (#1424).
  await page.goto("/?quick=log-stool");

  const sheet = page.getByTestId("quick-entry-sheet");
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("quick-entry-body")).toHaveAttribute(
    "data-form",
    "stool"
  );

  const picker = page.getByTestId("quick-entry-stool");
  await expect(picker).toBeVisible();

  // Seven buttons — no 0, no 8, and no free-entry field to type one into. That
  // absence is the guard, so it is asserted rather than assumed.
  for (let type = 1; type <= 7; type += 1) {
    await expect(picker.getByTestId(`stool-type-${type}`)).toBeVisible();
  }
  await expect(picker.getByTestId("stool-type-0")).toHaveCount(0);
  await expect(picker.getByTestId("stool-type-8")).toHaveCount(0);
  // No field to type a TYPE into — that absence IS the guard, so it is asserted
  // rather than assumed. Scoped to the type row: since #3273 the picker also carries
  // a collapsed "Happened earlier?" whose time input is a different question, and an
  // unscoped `locator("input")` would start passing for the wrong reason the day that
  // control changed.
  await expect(picker.locator(".grid input")).toHaveCount(0);

  // The accessible name is the SCALE's own description, not the two-word caption
  // the button has room for — that is what makes a self-reported type comparable.
  await expect(picker.getByTestId("stool-type-3")).toHaveAttribute(
    "aria-label",
    "Type 3, Like a sausage but with cracks on the surface"
  );

  await expect(page.getByTestId("quick-entry-stool-count")).toHaveText(
    "Nothing logged today."
  );

  const before = frozenNow().getTime();
  const settle = picker.getByTestId("stool-settle-6");
  const rolling = picker.getByTestId("quick-entry-stool-rolling-count");
  const settleRuns = Number(await settle.getAttribute("data-motion-runs"));
  const rollingRuns = Number(await rolling.getAttribute("data-motion-runs"));
  await picker.getByTestId("stool-type-6").click();
  // Persistent receipts, not a race to sample the 300/250 ms transient flags.
  // The settle count is driven by the actual CSS animationstart event; the roll
  // count increments only when RollingNumber schedules its real rAF sequence.
  await expect(settle).toHaveAttribute(
    "data-motion-runs",
    String(settleRuns + 1)
  );
  await expect(rolling).toHaveAttribute(
    "data-motion-runs",
    String(rollingRuns + 1)
  );

  // The sheet STAYS OPEN — several a day is ordinary, and a mis-tap is corrected by
  // tapping again rather than by reopening.
  await expect(page.getByTestId("quick-entry-stool-count")).toHaveText(
    "1 today"
  );
  await expect(sheet).toBeVisible();
  const after = frozenNow().getTime();

  const rows = bristolRows();
  expect(rows).toHaveLength(1);
  expect(rows[0].value).toBe(6);
  // NOBODY STATED A TIME, AND THE ROW SAYS SO (#5872). The old store stamped the wall
  // clock into the reading's own instant, so the record could not tell "happened at
  // 7:41" from "filed at 7:41" and printed the filing minute in the stated grammar.
  // The tap instant is still recorded — below — but it is recorded as what it is.
  expect(rows[0].occurred_at).toBeNull();
  expect(rows[0].time_source).toBeNull();
  // The TAP stamp records WHEN THIS WAS FILED, which is what makes a deliberate second
  // tap a second row rather than an overwrite of the first.
  //
  // BRACKETED, not "not midnight" (#3214). The tap is bracketed between two readings
  // of the app's clock seam and the stamp has to land between them — that states the
  // property, "stamped during this operation". The old check asserted the time part
  // was not `00:00:00`, which infers the clock from one value the stamp is unlikely
  // to equal; it reds outright under the boundary-stress hook that supplies
  // ALLOS_TEST_NOW at local midnight (playwright.config.ts), and it would keep
  // passing if the fallback ever became any other fixed time.
  //
  // The run FREEZES that seam, so the two captures coincide and the bracket collapses
  // to an identity against the frozen instant — the strongest form of the same
  // statement, and the reason no tolerance is needed here.
  const stampedAt = zonedWallIsoToUtc(TZ, rows[0].started_at);
  expect(stampedAt).not.toBeNull();
  // Whole seconds, so the lower bound is `before` floored to its own second.
  expect(stampedAt!.getTime()).toBeGreaterThanOrEqual(
    Math.floor(before / 1000) * 1000
  );
  expect(stampedAt!.getTime()).toBeLessThanOrEqual(after);

  // Reduced motion keeps the write/count end state and removes both transient
  // animation bands.
  //
  // THE COUNT GOES TO TWO, AND THAT IS THE FIX (#5872 defect 1). The run freezes the
  // clock, so this second tap lands on the very same second as the first — and under
  // the samples table's natural key that made it an UPSERT, so the count "correctly
  // remained one" and the first movement was gone. It was the merge defect, reachable
  // by two taps in one test. The ledger is append-only: two movements are two rows.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedSettle = picker.getByTestId("stool-settle-5");
  await settledClick(page, picker.getByTestId("stool-type-5"));
  await expect(page.getByTestId("quick-entry-stool-count")).toHaveText(
    "2 today"
  );
  expect(bristolRows().map((r) => r.value)).toEqual([6, 5]);
  await expect(reducedSettle).toHaveAttribute("data-reduced-motion", "true");
  await expect(reducedSettle).not.toHaveClass(/motion-settle/);
  await expect(reducedSettle).toHaveAttribute("data-motion-runs", "0");
  await expect(rolling).toHaveAttribute("data-reduced-motion", "true");
  await expect(rolling).toHaveAttribute("data-rolling", "false");
  await expect(rolling).toHaveAttribute(
    "data-motion-runs",
    String(rollingRuns + 1)
  );
});

test("a Bristol tap queues offline and syncs exactly once (#3166)", async ({
  page,
  context,
}) => {
  const date = dateStrInTz(TZ, frozenNow());
  await page.goto("/?quick=log-stool");
  const picker = page.getByTestId("quick-entry-stool");
  const awaitHydrated = (await import("./helpers")).awaitHydrated;
  await awaitHydrated(picker.getByTestId("stool-type-6"));

  await context.setOffline(true);
  await picker.getByTestId("stool-type-6").click();
  await expect(page.getByTestId("offline-queue-badge")).toHaveText(
    /1 queued offline/
  );
  expect(bristolRows()).toEqual([]);

  await context.setOffline(false);
  await expect(page.getByText(/Synced 1 offline entr/)).toBeVisible();

  const rows = bristolRows();
  expect(rows).toHaveLength(1);
  // A REPLAYED TAP STATES NO MORE THAN A LIVE ONE. The captured instant is a CAPTURE
  // stamp and lands in `recorded_at`; `occurred_at` stays null because nobody named a
  // time offline either.
  expect(rows[0]).toMatchObject({ date, value: 6, occurred_at: null });
  expect(zonedWallIsoToUtc(TZ, rows[0].started_at)?.getTime()).toBe(
    Math.floor(frozenNow().getTime() / 1000) * 1000
  );
  await page.reload();
  expect(bristolRows()).toHaveLength(1);
});

// #3273 — the picker states WHEN, and an unstated tap is unchanged.
//
// A bowel movement is exactly the event people log later, and until this the picker
// had no time affordance at all: a two-hours-late tap was wrong forever, because the
// Trends panel is read-only. The property with two halves, both asserted here: a
// stated minute is the instant the reading carries, and a tap that says nothing writes
// the row it wrote before the affordance existed — same second-grain key and all.
test('a stated "Happened earlier?" time is the instant the reading carries (#3273)', async ({
  page,
}) => {
  clearBristol();
  await page.goto("/?quick=log-stool");
  const picker = page.getByTestId("quick-entry-stool");
  await expect(picker).toBeVisible();

  const date = dateStrInTz(TZ, frozenNow());
  // The stored `started_at` is a profile-LOCAL WALL CLOCK, so every expectation below
  // is stated as the INSTANT that wall clock means — decoded with the same
  // `zonedWallIsoToUtc` the test above uses, against instants built by the safe
  // builder. Comparing the strings directly would mean assembling `${date}THH:MM:SS`
  // by hand, which is what e2e-fixture-time.test.ts's ledger exists to keep out of
  // spec files.
  const at = (hhmm: string) => zonedWallTimeToUtc(TZ, date, hhmm)!.getTime();
  const storedInstant = (started_at: string) =>
    zonedWallIsoToUtc(TZ, started_at)!.getTime();
  // What the clock-seam path writes, to the second: the write core reads the frozen
  // instant for the wall minute and takes the SECONDS off it in UTC, which is the
  // second-grain key itself. Whole seconds, so the frozen instant floors to its own.
  const tapInstant = Math.floor(frozenNow().getTime() / 1000) * 1000;

  // COLLAPSED: the fast path is untouched and the control is not even in the DOM.
  const toggle = picker.getByTestId("stool-when-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(picker.getByTestId("stool-when-time")).toHaveCount(0);

  // Leg 1 — the unstated tap writes the tap instant, seconds and all.
  //
  // ITS WRITE IS HELD OPEN while the statement is made, which is what makes the
  // ORDERING here a fact rather than a sample. The tap's settle resets the field, and
  // it runs when the write ANSWERS — arbitrarily later than the tap. Unheld, whether
  // the fill below lands before or after that reset is a race the box's load decides:
  // it failed 1 run in 3 under load, and the surviving shape was a silent one — the
  // second tap posting no time, colliding with the first row on the same second, and
  // one reading standing where two should be. Holding the POST puts the fill
  // deterministically INSIDE the flight window.
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const onThisPage = (url: URL): boolean => url.pathname === "/";
  // THE WRITE, NOT MERELY A POST TO THIS PAGE. Every Server Action on "/" is a POST
  // there, and since #5663 the picker asks for the day's receipt rows through one of
  // them at mount. "Hold the first POST" would hold that READ and let the tap's write
  // straight through — the opposite of the ordering this leg is built on, and it fails
  // by leaving the write's row to land after the assertion rather than by saying so.
  //
  // A WRITE IS THE STAMPED ONE. `useWritePipeline` stamps every post it makes with the
  // surface it happened on (#3087), so `logged_via` in the body is the property that
  // separates a write from a read — not the field names of one action, and not an
  // ordinal that assumes which request comes first.
  const isWrite = (request: Request): boolean =>
    request.method() === "POST" &&
    new URL(request.url()).pathname === "/" &&
    /name="[^"]*logged_via"/.test(request.postData() ?? "");
  await page.route(onThisPage, async (route) => {
    if (!isWrite(route.request())) return route.continue();
    await held;
    await route.continue();
  });
  // Armed BEFORE the click so it cannot miss its event.
  const answered = page.waitForResponse((r) => isWrite(r.request()), {
    timeout: 30_000,
  });
  await hydratedClick(page, picker.getByTestId("stool-type-4"));
  // IN FLIGHT, PROVED BY THE PAGE RATHER THAN BY THE WIRE. The ledger paints its
  // optimistic count the moment `write()` is invoked and adopts the server's only in
  // `settle`, so this text is the tap having STARTED — which is the whole ordering
  // this leg needs, since the settle cannot run before the response this route is
  // holding. It replaces a `waitForRequest` ceiling that went red once on CI without
  // the write being broken: a network-timing bound on a loaded shard is a worse
  // question than the state it was standing in for.
  await expect(page.getByTestId("quick-entry-stool-count")).toHaveText(
    "1 today"
  );

  // The statement, made while that first write is still out. The day half is FIXED,
  // so a statement can only move the minute — and under the sheet's day switcher it
  // does not RENDER that day either, because the switcher above already states it
  // (#5753 leg 3). What opens is the minute and nothing else.
  await hydratedClick(page, toggle);
  await expect(picker.getByTestId("stool-when-time")).toBeVisible();
  await expect(picker.getByTestId("stool-when-date")).toHaveCount(0);
  await settledFill(page, picker.getByTestId("stool-when-time"), "07:05");

  release();
  await answered;
  // The tap posted NO time — it consumed the silence that was in force when it fired,
  // not the statement that arrived while it was in flight.
  const tapped = bristolRows();
  expect(tapped).toHaveLength(1);
  expect(tapped[0]).toMatchObject({ date, value: 4 });
  expect(storedInstant(tapped[0].started_at)).toBe(tapInstant);
  // …AND THE SETTLE LEFT THE NEW STATEMENT ALONE. A reset scoped to the tap rather
  // than to the field is the difference between the next tap adding a reading and
  // overwriting this one.
  await expect(picker.getByTestId("stool-when-time")).toHaveValue("07:05");

  // Leg 2 — the statement lands, as its own row beside the tap's.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await settledClick(page, picker.getByTestId("stool-type-3"));
  await expect(page.getByTestId("quick-entry-stool-count")).toHaveText(
    "2 today"
  );
  // Both rows survive — the statement moved the minute, it did not overwrite the tap.
  const both = bristolRows();
  expect(both.map((r) => [r.date, r.value])).toEqual([
    [date, 3],
    [date, 4],
  ]);
  // The stated wall minute, on the second: a stated time carries no seconds.
  expect(both.map((r) => storedInstant(r.started_at))).toEqual([
    at("07:05"),
    tapInstant,
  ]);
  expect(both[0].started_at.endsWith(":00")).toBe(true);
  // AND THE PROVENANCE IS RECORDED, which is the half the old store had nowhere to put:
  // the stated row says a person named that minute, the tap row says nobody did.
  expect(both.map((r) => r.time_source)).toEqual(["stated", null]);

  // THE STATEMENT IS SPENT BY THE TAP IT ANSWERS. This used to matter because the key
  // WAS the instant, so a second tap under a surviving 07:05 silently overwrote the row
  // the first one wrote; the ledger is append-only now and would keep both. It still
  // matters for what the row SAYS: a stale 07:05 would file a movement at a minute
  // nobody meant to restate.
  await expect(picker.getByTestId("stool-when-time")).toHaveValue("");
  clearBristol();
});

// ── THE SHEET STATES THE DAY (#5663) ──────────────────────────────────────────
//
// The owner's report was "quicklogging stool provides no feedback or description": the
// tap moved a count and toasted a number, and the sentence that says what the number
// means was reachable only as a tile's accessible name or behind the title row's info
// glyph. The ruling is the whole day on the sheet, each entry its own two-line receipt
// row, newest first, with Undo on the newest and one count line beneath.
//
// WHAT ONLY A BROWSER CAN PROVE HERE is that the rows are the STORE's. Two halves: rows
// that predate the sheet appear at all — the sheet's own gather answers with a count,
// so the control asks for them itself — and the Undo makes a round trip that really
// removes the row rather than hiding it. The unit tier drives both against a mocked
// action; nothing below this asks the running app.
//
// EVERY TIME IS READ BACK OUT OF THE STORE rather than built here. The run freezes the
// clock and the boundary-stress hook can put that instant at local midnight
// (playwright.config.ts), so a tapped reading's wall clock is not a literal this file
// may assume — and an assertion that assumed one would go red for the wrong reason on
// the midnight shard.
test("the sheet lists the day's movements and the newest tap is undoable (#5663)", async ({
  page,
}) => {
  await page.goto("/?quick=log-stool");
  const picker = page.getByTestId("quick-entry-stool"); // testid-scope-ok: the quick-log sheet body is portalled to <body> (BottomSheet), one copy
  await expect(picker).toBeVisible();
  const rows = picker.getByTestId("quick-entry-stool-receipt");
  await expect(rows).toHaveCount(0);
  await expect(picker.getByTestId("quick-entry-stool-count")).toHaveText(
    "Nothing logged today."
  );

  await settledClick(page, picker.getByTestId("stool-type-6"));

  // The ruled two lines: the number with the tile's own caption above, the scale's own
  // sentence with the reading's clock below. Neither the caption nor the sentence was
  // printed anywhere on this surface before.
  await expect(rows).toHaveCount(1);
  const logged = bristolRows();
  expect(logged.map((r) => r.value)).toEqual([6]);
  // ADDRESSED BY THE ROW THE STORE SAYS WAS WRITTEN, not by position: the sentence
  // under test belongs to a particular reading, and reading it off "whichever row is
  // on top" would pass for a row about some other movement.
  const tapped = receiptFor(picker, logged[0].id);
  await expect(
    tapped.getByTestId("quick-entry-stool-receipt-heading")
  ).toHaveText("Type 6 · Mushy");
  await expect(
    tapped.getByTestId("quick-entry-stool-receipt-facts")
  ).toHaveText(
    `Fluffy pieces with ragged edges, a mushy stool · ${logged[0].started_at.slice(11, 16)}`
  );
  await expect(rows.nth(0)).toHaveAttribute(
    "data-reading-id",
    String(logged[0].id)
  );
  await expect(picker.getByTestId("quick-entry-stool-count")).toHaveText(
    "1 today"
  );

  // THE UNDO IS A ROUND TRIP, not a hidden row. `StoolTypeControl` declared `undo:
  // null` until this issue, on the argument that the record's ⋯ is where a movement is
  // removed; the ruling puts it here, and this is the assertion that it actually works.
  const undo = picker.getByTestId("quick-entry-stool-receipt-undo");
  await expect(undo).toHaveCount(1);
  await settledClick(page, undo);
  await expect(rows).toHaveCount(0);
  await expect(picker.getByTestId("quick-entry-stool-count")).toHaveText(
    "Nothing logged today."
  );
  expect(bristolRows()).toEqual([]);
});

test("movements logged before the sheet opened are listed, without an Undo (#5663)", async ({
  page,
}) => {
  const day = dateStrInTz(TZ, frozenNow());
  seedBristol(day, "06:02:00", 3);
  seedBristol(day, "07:30:00", 5);

  await page.goto("/?quick=log-stool");
  const picker = page.getByTestId("quick-entry-stool"); // testid-scope-ok: the quick-log sheet body is portalled to <body> (BottomSheet), one copy
  const rows = picker.getByTestId("quick-entry-stool-receipt");

  // NEWEST FIRST, stated against the store's own order rather than against two times
  // written out here — the property is the ordering, not the pair of clocks.
  await expect(rows).toHaveCount(2);
  const newestFirst = [...bristolRows()].reverse();
  for (const [index, row] of newestFirst.entries())
    await expect(rows.nth(index)).toHaveAttribute(
      "data-reading-id",
      String(row.id)
    );
  await expect(
    receiptFor(picker, newestFirst[0].id).getByTestId(
      "quick-entry-stool-receipt-heading"
    )
  ).toHaveText("Type 5 · Soft blobs");
  await expect(picker.getByTestId("quick-entry-stool-count")).toHaveText(
    "2 today"
  );

  // NO UNDO ON A ROW THIS SHEET DID NOT WRITE. #2642's offer rides the write; beside a
  // reading gathered from the store it would be a delete wearing the word, and the
  // record's ⋯ is where a delete belongs.
  await expect(
    picker.getByTestId("quick-entry-stool-receipt-undo")
  ).toHaveCount(0);
});

test("the Body panel shows a day's types as marks, never as one average", async ({
  page,
}) => {
  await page.goto("/?quick=log-stool");
  const picker = page.getByTestId("quick-entry-stool");
  await expect(picker).toBeVisible();

  // The two extremes on one day. Their mean is 4 — the middle of the scale — so an
  // averaged surface would draw the worst day in the window as textbook-normal.
  //
  // One reading is TAPPED and the other is seeded, because the suite freezes the
  // clock (ALLOS_TEST_NOW) and every tap in a run therefore claims the same instant —
  // which the store's second-resolution natural key correctly reads as one reading
  // corrected, not two. The DB tier proves the two-row case through the stated-time
  // door; what this spec is for is the PANEL, and the panel needs a day that really
  // holds two types.
  await settledClick(page, picker.getByTestId("stool-type-1"));
  seedBristol(bristolRows()[0].date, "23:59:59", 7);

  await page.goto("/trends");

  const panel = page.getByTestId("bristol-panel");
  await expect(panel).toBeVisible();

  // The distribution counted BOTH extremes once and put nothing on type 4.
  await expect(panel.getByTestId("bristol-bar-1")).toHaveAttribute(
    "data-count",
    "1"
  );
  await expect(panel.getByTestId("bristol-bar-7")).toHaveAttribute(
    "data-count",
    "1"
  );
  await expect(panel.getByTestId("bristol-bar-4")).toHaveAttribute(
    "data-count",
    "0"
  );

  // …and the day itself carries both marks.
  const day = bristolRows()[0].date;
  await expect(panel.getByTestId(`bristol-day-${day}`)).toHaveAttribute(
    "data-types",
    "1,7"
  );
});

test("the panel is absent for a profile with nothing logged", async ({
  page,
}) => {
  // Never an empty chart with an exhortation under it: a profile that does not use
  // this sees the Body section exactly as it was.
  await page.goto("/trends");
  await expect(page.getByTestId("bristol-panel")).toHaveCount(0);
});

// ── STOOL JOINS THE RECORD (#4433) ────────────────────────────────────────────
//
// The absence this closes was a mis-tap being PERMANENT: a logged movement rendered on
// the Trends dot strip and nowhere correctable. Only a browser can prove the ⋯ round
// trip — the DB tier cannot render a page and the action tier posts its own FormData,
// so nothing below the menu was ever driven by the thing that actually sends it.
//
// AND THE DOOR IS WHAT MAKES A PAST DAY REACHABLE AT ALL. `TAP_REACH` files
// `stool-form` as a `today` tap, correctly — the sheet states no day — so a movement
// remembered the NEXT morning had no surface in the app before this.

const localDay = (offsetDays: number) =>
  dateStrInTz(TZ, new Date(frozenNow().getTime() + offsetDays * 86_400_000));

function clearStoolTrash(): void {
  const db = new Database(DB_PATH);
  try {
    db.pragma("busy_timeout = 5000");
    // The holding rows this spec's delete mints, so a failed run leaves no capture for
    // the Data → Trash specs to trip over.
    db.prepare(
      "DELETE FROM deleted_rows WHERE profile_id = 1 AND kind = 'metric-sample'"
    ).run();
  } finally {
    db.close();
  }
}

test.describe("the record's stool rows (#4433)", () => {
  test.afterEach(() => clearStoolTrash());

  test("corrects a mis-tapped type in place and deletes with undo", async ({
    page,
  }) => {
    test.slow();
    const day = localDay(-1);
    seedBristol(day, "08:12:00", 3);
    seedBristol(day, "19:40:00", 6);

    await page.goto("/history?kind=stool");

    // Both movements are their own row — instant grain, never a day's average.
    const rows = page.getByTestId("history-row");
    await expect(rows.filter({ hasText: "Type 3" })).toHaveCount(1);
    await expect(rows.filter({ hasText: "Type 6" })).toHaveCount(1);

    // THE CORRECTION. "Type 3, meant 4" is the mis-tap the issue names, and the form
    // offers the type ALONE — the reading's instant is its address, so a time field
    // here would fork the row rather than move it.
    const misTapped = rows.filter({ hasText: "Type 3" });
    await hydratedClick(page, misTapped.getByTestId("overflow-menu-trigger"));
    // The menu is portalled, so the item is addressed on the PAGE — the row scope
    // above is what decided which ⋯ opened it.
    await page.getByTestId("history-row-edit").click();
    const form = page.getByTestId("history-row-editing");
    await expect(form.getByTestId("stool-form-when")).toHaveCount(0);
    await form.getByTestId("stool-form-type").selectOption("4");
    await settledClick(page, form.getByTestId("stool-form-save"));

    await expect(rows.filter({ hasText: "Type 4" })).toHaveCount(1);
    await expect(rows.filter({ hasText: "Type 3" })).toHaveCount(0);
    // ONE row still, at the same instant: the correction moved the type and nothing
    // else. Read from the store rather than from the page, because a fork would render
    // as a second row that a "the row I clicked changed" assertion never looks at.
    expect(bristolRows().map((r) => [r.started_at, r.value])).toEqual([
      [`${day}T08:12:00`, 4],
      [`${day}T19:40:00`, 6],
    ]);

    // THE DELETE, through the shared undo-capture contract (#2642).
    const corrected = rows.filter({ hasText: "Type 4" });
    await hydratedClick(page, corrected.getByTestId("overflow-menu-trigger"));
    await page.getByTestId("history-row-delete").click();
    await settledClick(
      page,
      page.getByTestId("confirm-dialog").getByRole("button", { name: "Delete" })
    );
    await expect(rows.filter({ hasText: "Type 4" })).toHaveCount(0);
    await expect(page.getByText("Movement removed")).toBeVisible();
    // The row beside it is untouched — "the row I clicked went away" cannot see a
    // delete that took the wrong reading with it.
    await expect(rows.filter({ hasText: "Type 6" })).toHaveCount(1);
    expect(bristolRows().map((r) => r.value)).toEqual([6]);

    await settledClick(page, page.getByRole("button", { name: "Undo" }));
    await expect(rows.filter({ hasText: "Type 4" })).toHaveCount(1);
    expect(bristolRows().map((r) => [r.started_at, r.value])).toEqual([
      [`${day}T08:12:00`, 4],
      [`${day}T19:40:00`, 6],
    ]);
  });

  test("the record's door logs a movement onto the day being read", async ({
    page,
  }) => {
    test.slow();
    const day = localDay(-2);
    // A CHIP IS EARNED BY THE PROFILE'S OWN KINDS (#4851's presence gate), and since
    // #5618 ruling 1 the chip IS the door — so the record offers to add a movement
    // because this profile records movements. Seeded a day EARLIER than the one under
    // test, so the assertion below still names which day the door wrote on.
    const earlier = localDay(-3);
    seedBristol(earlier, "09:00:00", 3);
    // Read back what the seed stored rather than restating its shape: the comparison
    // below is still over the WHOLE set, and this file's one interpolated wall clock
    // stays the one the door itself is being asked to write.
    const seeded = bristolRows();
    // AND NO `?kind=`: the reader is on the day, not filtered to a kind. That is the
    // whole of ruling 1 — the chip opens the form without narrowing the record — and
    // this test used to have to type the filter into the URL to reach a door at all.
    await page.goto(`/history?day=${day}`);

    await hydratedClick(page, page.getByTestId("history-add-open-stool"));
    const panel = page.getByTestId("history-add-panel-stool");
    // The date opens on the day the reader was looking at — the whole reason to add
    // from here is a gap you just found — and the time is EMPTY, never defaulted.
    // `DateField` renders the login's DISPLAY format, so the ISO day is asserted where
    // it is unambiguous: on the row this writes, below.
    await expect(panel.getByTestId("stool-form-when-date")).not.toHaveValue("");
    await expect(panel.getByTestId("stool-form-when-time")).toHaveValue("");
    await settledFill(page, panel.getByTestId("stool-form-when-time"), "07:05");
    await panel.getByTestId("stool-form-type").selectOption("5");
    await settledClick(page, panel.getByTestId("stool-form-save"));

    await expect(
      page.getByTestId("history-row").filter({ hasText: "Type 5" })
    ).toHaveCount(1);
    // Filed on the day it names, at the minute it states — not on today, which is
    // what `logStoolForm` re-derived before this leg. The whole set is compared, so a
    // door that wrote onto the seeded day instead would fail by naming it.
    expect(
      bristolRows().map(({ date, started_at, value }) => ({
        date,
        started_at,
        value,
      }))
    ).toEqual([
      ...seeded.map(({ date, started_at, value }) => ({
        date,
        started_at,
        value,
      })),
      { date: day, started_at: `${day}T07:05:00`, value: 5 },
    ]);
  });
});
