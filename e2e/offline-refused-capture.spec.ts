import { test, expect } from "./fixtures";
import { closeEditor, openFact } from "./intake-form-helpers";
import type { Page } from "@playwright/test";
import Database from "better-sqlite3";
import {
  comboboxRows,
  hydratedClick,
  openDashboardAll,
  settledClick,
} from "./helpers";
import { loginAs, openCommandPalette } from "./nav";
import {
  E2E_LOGIN_MOBILITY,
  E2E_LOGIN_WEIGHT_QA,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";
import {
  MEASUREMENTS_PARTIAL_REFUSED_MESSAGE,
  OFFLINE_CAPTURE_REFUSED_MESSAGE,
} from "@/lib/offline/queue";

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

// Refuse ONE of the two writes a measurements sitting makes (#3118), which
// `breakIndexedDB` cannot do: it removes storage entirely, so both halves refuse
// together and the surface is right to say nothing was saved. The failure the issue
// describes is storage dying BETWEEN the two puts, and it has TWO causes that differ
// in what the device is left holding. This is the QUOTA one: it throws on the vitals
// intent's write and only that one, so `guardedWriteNow` catches it and answers
// "failed" exactly as it does for a real QuotaExceededError — the body intent stays in
// the store. `wipeInTheGap` below is the other cause, where it does not.
async function refuseVitalsWrites(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey
    ): IDBRequest<IDBValidKey> {
      if ((value as { flow?: string } | null)?.flow === "vitals") {
        throw new DOMException("forced by a spec", "QuotaExceededError");
      }
      return put.call(this, value as never, key);
    };
  });
}

// The OTHER cause of a gap between the two enqueues (#3118, and the one the partial
// sentence must NOT claim a save for): a logout in another tab landing in it.
//
// `clearQueue` (lib/offline/queue-db.ts) clears the intents store and closes the device
// write gate in ONE transaction, deliberately, so that no writer anywhere can believe it
// may write into data that is already gone. This performs exactly that transaction body
// right after the body intent's own put, in that same transaction — the same COMMITTED
// end state as a real wipe landing in the gap, without needing a second tab and a real
// logout POST inside a 200ms window. The vitals enqueue then opens its own transaction,
// reads a closed gate, and is refused — while the body intent it would be reported
// alongside no longer exists.
async function wipeInTheGap(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    let done = false;
    IDBObjectStore.prototype.put = function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey
    ): IDBRequest<IDBValidKey> {
      const req = put.call(this, value as never, key);
      if (
        !done &&
        (value as { flow?: string } | null)?.flow === "body-metric"
      ) {
        done = true;
        const tx = this.transaction;
        tx.objectStore("intents").clear();
        const meta = tx.objectStore("meta");
        const read = meta.get("device-writes");
        read.onsuccess = () => {
          const gate = (read.result as Record<string, unknown>) ?? {};
          meta.put({
            ...gate,
            key: "device-writes",
            generation: Number(gate.generation ?? 0) + 1,
            sessionClosed: true,
          });
        };
      }
      return req;
    };
  });
}

// How many intents the device is actually holding. The badge answers the same question
// for the cases where a queue exists to render one, but a wipe leaves no provider state
// to disagree with — so the store itself is asked.
async function queuedIntentCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open("allos-offline", 5);
        open.onsuccess = () => {
          const db = open.result;
          const req = db
            .transaction("intents", "readonly")
            .objectStore("intents")
            .getAll();
          req.onsuccess = () => {
            resolve((req.result as unknown[]).length);
            db.close();
          };
        };
        open.onerror = () => resolve(-1);
      })
  );
}

// Open one of the quick-add form's collapsed groups. The disclosure keeps closed
// fields in the DOM (they still post), so a fill has to open the group first.
async function openMeasurementGroup(
  page: Page,
  group: "body" | "vitals"
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

// #3118: the ONE partial shape the #3114 rule leaves open. The body half is enqueued
// first and a refusal there stops the vitals enqueue, so "kept the body, refused the
// vitals" is the only way half a sitting can reach the queue — and before this fix the
// screen showed the pending badge "1 queued offline" AND the shared sentence saying
// the entry was not saved. Re-entering the whole sitting, as that sentence instructs,
// duplicates the weight: intents are uuid-keyed, so a re-entry is a distinct write.
test("a measurements save whose vitals half is refused says which half it kept", async ({
  page,
  context,
}) => {
  await refuseVitalsWrites(page);
  await page.goto("/trends");
  await hydratedClick(page, page.getByTestId("log-measurements-toggle"));
  const form = page.getByTestId("measurements-quick-add");
  await expect(form).toBeVisible();
  await openMeasurementGroup(page, "body");
  await openMeasurementGroup(page, "vitals");

  await context.setOffline(true);
  await form.getByLabel("Weight", { exact: true }).fill("81.4");
  await form.getByLabel("Systolic", { exact: true }).fill("118");
  await form.getByLabel("Diastolic", { exact: true }).fill("76");
  await form.getByRole("button", { name: "Save measurements" }).click();

  // The sentence states the partial truth, and the shared one — which would be a lie
  // about the weight — does not appear beside it.
  await expect(
    page.getByText(MEASUREMENTS_PARTIAL_REFUSED_MESSAGE)
  ).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(OFFLINE_CAPTURE_REFUSED_MESSAGE)).toHaveCount(0);
  await expect(page.getByText(SAVED_OFFLINE)).toHaveCount(0);
  // …and the badge is the thing it must agree with: the body half really IS queued,
  // which is what makes the shared sentence wrong here rather than merely blunt.
  await expect(page.getByTestId("offline-queue-badge")).toHaveText(
    /1 queued offline/
  );

  // RECONNECTING WITH THE REPLAY ROUTE SHUT, which is not fussiness in either
  // direction. Every other test here can go online freely because it refused BOTH
  // halves and has nothing queued; this one holds a REAL body-metric intent that
  // would land a weigh-in on the shared fixture profile the moment the flush ran. And
  // simply staying offline is not an option: e2e-hygiene's offline-navigation rule
  // reads the window as running to the END OF THE FILE when a spec never comes back,
  // so an unclosed window swallows every later test's `goto` — the guard being right.
  // So: block the flush, come back online, and let the intent die with the context.
  await page.route("**/api/offline-replay", (route) => route.abort());
  await context.setOffline(false);
  // Still queued, so nothing reached the server — a presence assertion, which is the
  // honest shape here: waiting longer cannot make a badge that was cleared reappear.
  await expect(page.getByTestId("offline-queue-badge")).toHaveText(
    /1 queued offline/
  );
});

// #3118's OTHER cause, and the one that decides which sentence is honest. Here the
// vitals half is refused BY THE CLOSED GATE, which only `clearQueue` ever closes — and
// it clears the intents store in the same transaction, so the body half the surface
// would be claiming is already gone. "Body measurements were saved" would send someone
// back to re-enter the vitals alone and quietly lose the weigh-in, which is a worse
// trade than the duplicate the partial sentence exists to prevent. The shared sentence
// is simply true here, and the empty store is what makes it true.
test("a measurements save whose vitals half is refused by a logout wipe claims no half", async ({
  page,
  context,
}) => {
  await wipeInTheGap(page);
  await page.goto("/trends");
  await hydratedClick(page, page.getByTestId("log-measurements-toggle"));
  const form = page.getByTestId("measurements-quick-add");
  await expect(form).toBeVisible();
  await openMeasurementGroup(page, "body");
  await openMeasurementGroup(page, "vitals");

  await context.setOffline(true);
  await form.getByLabel("Weight", { exact: true }).fill("81.4");
  await form.getByLabel("Systolic", { exact: true }).fill("118");
  await form.getByLabel("Diastolic", { exact: true }).fill("76");
  await form.getByRole("button", { name: "Save measurements" }).click();

  // The shared sentence, no "saved offline", and no badge — expectRefusedOnly's three.
  await expectRefusedOnly(page);
  // …and NOT the partial one, which would be a claim about a weight the wipe took.
  await expect(
    page.getByText(MEASUREMENTS_PARTIAL_REFUSED_MESSAGE)
  ).toHaveCount(0);
  // The durable truth the sentence now matches: the device is holding nothing.
  expect(await queuedIntentCount(page), "queued intents").toBe(0);
  await context.setOffline(false);
});

// THE LINE THAT CHOOSES BETWEEN THE TWO SENTENCES, observed. Every other measurements
// case here either fills Weight (so a refusal returns at the body branch, before that
// line) or is the partial case itself — so `keptBody ? "partial" : "refused"` could be
// mutated to a bare "partial" and the file stayed green. A vitals-only sitting is the
// case that reaches the line with nothing kept: no body half was ever enqueued, so
// naming one is a claim about a write that does not exist.
test("a refused vitals-only sitting says nothing was saved, not that the body half was", async ({
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
  await expect(
    page.getByText(MEASUREMENTS_PARTIAL_REFUSED_MESSAGE)
  ).toHaveCount(0);
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
    await comboboxRows(page)
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
    await page.waitForTimeout(REFUSED_FLUSH_SETTLE_MS); // waitfortimeout-ok: the assertion IS an absence — no attempt from a close that was already refused may write in the window one would have written in
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
