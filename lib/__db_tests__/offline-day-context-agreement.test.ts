// DB INTEGRATION TIER — the offline dose schedule and the household card ask the same
// day question the medications page asks (#5321).
//
// #5167 closed the SITUATIONS field of the intake day context; this is the rest of the
// object. The page's builder answers FIVE fields and these two surfaces answered THREE,
// and the missing ones diverge in OPPOSITE directions:
//
//   • no `predictedWorkoutDay` ⇒ a pre-workout dose keys on "a session was already
//     logged" instead of the inferred cadence (#558), so the surface OMITS a dose the
//     page offers on a predicted training day;
//   • no `postWorkoutReady` ⇒ `conditionAppliesOn` reads `ctx.postWorkoutReady ?? true`,
//     so an omitted field does not merely lose a condition, it DEFAULTS TO PERMISSIVE
//     and the surface OFFERS a dose the page holds until the session has ended.
//
// The acceptance is "five fields, and the defaults are not neutral" — both directions,
// because the `?? true` is what made the omission silent.
//
// AND ONE OF THE FIVE IS A VERDICT, which is the axis the third describe below exists
// for. `postWorkoutReady` is a statement about the current MINUTE, and the offline
// payload is stored and read hours later, so the snapshot must ask the day's converged
// answer instead (`asOfWholeDay`) — this file's own first round did not, and froze a
// monotone gate that can only be wrong one way: it withholds. Asserting the two surfaces
// at ONE instant cannot see that. Instantaneous equality is the one property a snapshot
// does not need; what it needs is that its stored answer survives to READ TIME.
//
// OFFLINE IS WHAT SOMEONE READS WITH NO SIGNAL. /offline renders the schedule as rows
// with no control on them, so the acting happens in the world rather than in the app.
// Telling someone that nothing is owed while the page they cannot reach says a dose is
// due is the harm #5167 argued, one field over.
//
// NOTHING HERE COMPARES OFFLINE TO THE PAGE BEFORE THE EARLIEST SESSION END, AND THAT
// ABSENCE IS INTENT RATHER THAN OVERSIGHT. In that window the two deliberately still
// differ: the page holds the post-workout dose and the snapshot offers it, because the
// snapshot asks the DAY-shaped question (`asOfWholeDay`) and the day's converged answer
// is "the session has ended". Asserting agreement there would be asserting that a stored
// payload carries a wall-clock verdict, which is the thing this file's third describe
// exists to say it must not do. Closing that window means shipping the earliest session
// end time as a FACT the device evaluates against its own clock — a separate change with
// its own design, and the assertion belongs with it.
//
// Fixtures are 100% synthetic (a throwaway per-file DB via setup.ts). No AI, no network.

import { describe, it, expect, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr, weekdayOfDateStr } from "@/lib/date";
import {
  mintCalendarFeedToken,
  setCalendarFeedOptions,
  setTimezone,
} from "@/lib/settings";
import { GET as calendarFeedGET } from "@/app/api/calendar/[token]/route";
import { buildSnapshot, snapshotContext } from "@/lib/offline/snapshot-build";
import type { DoseScheduleEntry } from "@/lib/offline/snapshots";
import { loadMedicationsData } from "@/app/(app)/medications/med-data";
import { intakeAdherenceOn } from "@/lib/queries/household";
import {
  doseDayProgress,
  offeredItems,
} from "@/lib/queries/upcoming/intake-safety";
import { getOfferedIntakeForSlot } from "@/lib/queries/intake";
import { gatherDigestInput } from "@/lib/notifications/digest-data";
import { buildDigest, renderDigestMessage } from "@/lib/notifications/digest";
import { buildIntakeReminderForSlots } from "@/lib/notifications/intake";
import { mintUsualRoutineAttachment } from "@/lib/notifications/usual-routine-attach";
import { pendingDayDoses } from "@/lib/queries/usual-routine";
import { currentFoodSlotWindow } from "@/lib/queries/nutrition";
import { plainBody } from "@/lib/notifications/rich-text";
import type { IntakeCondition } from "@/lib/types";

let seq = 0;

function newProfile(): number {
  const id = Number(
    db
      .prepare("INSERT INTO profiles (name) VALUES (?)")
      .run(`Offline Day Context ${seq++}`).lastInsertRowid
  );
  setTimezone(id, "UTC");
  return id;
}

function logWorkout(
  profileId: number,
  date: string,
  start = "07:00",
  end = "07:45"
): void {
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, duration_min, start_time, end_time)
     VALUES (?, ?, 'strength', 'Session', 45, ?, ?)`
  ).run(profileId, date, start, end);
}

// One active, daily-cadence item with one dose, on the given day condition.
//
// Kind `medication` because that is the set BOTH surfaces answer about: the offline
// schedule carries every active intake item, while the medications board is the page
// whose builder this issue compares against. The day condition is what is under test,
// and it reads the same on either kind.
function seedItem(
  profileId: number,
  name: string,
  condition: IntakeCondition,
  // `may` + a hint-less dose is the OFFER shape (#1505): nothing is owed, so the item
  // reaches the availability surfaces instead of the due ones, and a dose with no
  // stated time carries no slot opinion — which is what lets one item be asked about
  // at two different minutes without the slot filter deciding the answer.
  opts: { obligation?: "should" | "may"; timeOfDay?: string | null } = {}
): void {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, kind, condition, obligation, active)
         VALUES (?, ?, 'medication', ?, ?, 1)`
      )
      .run(profileId, name, condition, opts.obligation ?? "should")
      .lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 dose', ?, 'any', 0)`
  ).run(itemId, opts.timeOfDay === undefined ? "Morning" : opts.timeOfDay);
}

/** The doses the offline snapshot would put on the device, as built right now. */
function offlineDoseNames(profileId: number): string[] {
  const snap = buildSnapshot(
    "dose-schedule",
    snapshotContext(profileId, 1),
    new Date()
  );
  return (snap.data as { entries: DoseScheduleEntry[] }).entries.map(
    (d) => d.name
  );
}

/** The doses the medications page counts as due today, by item name. */
function pageDueNames(profileId: number): string[] {
  const data = loadMedicationsData(profileId);
  const names: string[] = [];
  for (const card of data.byId.values())
    for (const _dose of card.dueDoseIds) names.push(card.med.name);
  return names.sort();
}

describe("the offline schedule and the page predict the same training day (#5321)", () => {
  it("offers the pre-workout dose the page offers on a PREDICTED training day", () => {
    const p = newProfile();
    const td = today(p);
    // A weekly cadence on today's weekday, ending a week ago: nothing is logged for
    // today, so only the prediction can say this is a training day.
    for (let w = 1; w <= 8; w++) logWorkout(p, shiftDateStr(td, -w * 7));
    expect(weekdayOfDateStr(td)).toBe(weekdayOfDateStr(shiftDateStr(td, -7)));

    seedItem(p, "Pre-exercise inhaler", "pre_workout");

    // The measured defect: {taken:0, due:0} offline against {taken:0, due:1} on the page.
    expect(pageDueNames(p)).toEqual(["Pre-exercise inhaler"]);
    expect(offlineDoseNames(p)).toEqual(["Pre-exercise inhaler"]);
  });
});

describe("a live surface holds a post-workout dose until the session ends (#5321)", () => {
  // THE `?? true` DIRECTION, on the surfaces that RENDER rather than store. The household
  // card is read at the moment it is built, so it wants the same minute-shaped answer the
  // member's own page gives — and without the field it offered a dose that page holds.
  it("counts what the medications page counts, mid-session and after", () => {
    const p = newProfile();
    const td = today(p);
    seedItem(p, "Recovery tablet", "post_workout");
    logWorkout(p, td, "17:00", "18:00");

    vi.setSystemTime(new Date(`${td}T09:00:00.000Z`));
    expect(pageDueNames(p)).toEqual([]);
    expect(intakeAdherenceOn(p, td)).toEqual({ taken: 0, due: 0 });

    // The control: the hold is the session's end time, not the condition itself.
    vi.setSystemTime(new Date(`${td}T19:00:00.000Z`));
    expect(pageDueNames(p)).toEqual(["Recovery tablet"]);
    expect(intakeAdherenceOn(p, td)).toEqual({ taken: 0, due: 1 });
  });

  // THE THREE SURFACES #5637 LEFT, closed here as the behavior fix the PM ruled it is
  // (2026-09-09). Upcoming's dose rows, Upcoming's availability disclosure and the
  // quick-log sheet each assembled their own four-field context, so `?? true` unheld a
  // dose the page was holding — a person mid-session was offered a post-workout dose on
  // one surface and told to wait on another, about the same dose on the same day.
  //
  // Both directions, because a surface that simply never offered the dose would pass a
  // one-sided assertion: held before the earliest session end, offered after it.
  it("holds it on Upcoming and the quick-log sheet too, then offers it", () => {
    const p = newProfile();
    const td = today(p);
    // One item per surface shape: `should` reaches the due rows, `may` reaches the two
    // offer surfaces. Both are post-workout on the same session, so one gate decides.
    seedItem(p, "Recovery tablet", "post_workout");
    seedItem(p, "Recovery shake", "post_workout", {
      obligation: "may",
      timeOfDay: null,
    });
    logWorkout(p, td, "17:00", "18:00");

    vi.setSystemTime(new Date(`${td}T09:00:00.000Z`));
    expect(pageDueNames(p)).toEqual([]);
    expect(doseDayProgress(p, td)).toEqual({ scheduled: 0, taken: 0 });
    expect(offeredItems(p, td).map((i) => i.title)).toEqual([]);
    expect(getOfferedIntakeForSlot(p, "09:00").map((o) => o.name)).toEqual([]);

    vi.setSystemTime(new Date(`${td}T19:00:00.000Z`));
    expect(pageDueNames(p)).toEqual(["Recovery tablet"]);
    expect(doseDayProgress(p, td)).toEqual({ scheduled: 1, taken: 0 });
    expect(offeredItems(p, td).map((i) => i.title)).toEqual(["Recovery shake"]);
    expect(getOfferedIntakeForSlot(p, "19:00").map((o) => o.name)).toEqual([
      "Recovery shake",
    ]);
  });

  // THE DIGEST IS A SEND, WHICH IS WHY IT GETS ITS OWN ASSERTION (#5321 falsifying
  // pass). Converting `scheduledDoseRows` above did not only change page rows: the
  // hourly digest reads the SAME engine — gatherDigestInput → collectUpcoming →
  // doseItems → scheduledDoseRows — so the gate now decides the pushed "what's due"
  // list too. A tick firing while the session's recorded end is still ahead no longer
  // names the post-workout dose.
  //
  // Before this, the only thing in the repository that noticed the digest moved was
  // `tick-gather-budget.test.ts`, and it noticed as a STATEMENT COUNT: a number that
  // says the gather got two reads more expensive says nothing about which doses the
  // message names. A count cannot tell a correct hold from a wrong one, and a wrongly
  // silenced dose is invisible to exactly the person it fails.
  //
  // Both directions again, so a digest that simply never names the dose cannot pass.
  it("holds it out of the digest's due doses mid-session, then names it", () => {
    const p = newProfile();
    const td = today(p);
    seedItem(p, "Recovery tablet", "post_workout");
    logWorkout(p, td, "17:00", "18:00");

    const digestDoseTitles = (): string[] =>
      gatherDigestInput(p, "Digest Day Context")
        .todayGroups.flatMap((g) => g.items)
        .filter((i) => i.domain === "dose")
        .map((i) => i.title);

    // Mid-session: the page holds the dose, and so does the message.
    vi.setSystemTime(new Date(`${td}T09:00:00.000Z`));
    expect(pageDueNames(p)).toEqual([]);
    expect(gatherDigestInput(p, "Digest Day Context").doseCount).toBe(0);
    expect(digestDoseTitles()).toEqual([]);

    // After the recorded end: the dose is owed, and the message says so.
    vi.setSystemTime(new Date(`${td}T19:00:00.000Z`));
    expect(pageDueNames(p)).toEqual(["Recovery tablet"]);
    expect(gatherDigestInput(p, "Digest Day Context").doseCount).toBe(1);
    expect(digestDoseTitles()).toEqual(["Recovery tablet"]);
  });

  // AND THE DAY LEDGER, which is the one that WRITES (#5321 falsifying pass). The three
  // conversions above are read surfaces; `pendingDayDoses` is the switcher and quick-log
  // day ledger AND the set the bulk tap filters its writes through — `markDoseTaken`
  // decrements on-hand supply for every dose it authorizes. So while it built its own
  // four-field context, a dose the page, Upcoming and the digest all held was still one
  // tap from a `taken` row and real stock spent. A read divergence shows the wrong
  // thing; a write divergence spends something.
  //
  // Reached from the same page that got this right: the medications board builds a live
  // five-field context for its own rows and then calls this for the ledger's due half —
  // one render, two answers about one dose.
  it("keeps it out of the day ledger's writable set until the session ends", () => {
    const p = newProfile();
    const td = today(p);
    seedItem(p, "Recovery tablet", "post_workout");
    logWorkout(p, td, "17:00", "18:00");

    vi.setSystemTime(new Date(`${td}T09:00:00.000Z`));
    expect(pageDueNames(p)).toEqual([]);
    expect(pendingDayDoses(p, td).map((d) => d.name)).toEqual([]);

    vi.setSystemTime(new Date(`${td}T19:00:00.000Z`));
    expect(pageDueNames(p)).toEqual(["Recovery tablet"]);
    expect(pendingDayDoses(p, td).map((d) => d.name)).toEqual([
      "Recovery tablet",
    ]);
  });
});

describe("the stored snapshot answer survives to read time (#5321)", () => {
  // THE AXIS THE PAYLOAD LIVES ON, and the one a same-instant assertion cannot see.
  //
  // A session logged 07:00-07:45 and a snapshot built at 07:20. The person is offline for
  // the rest of the day: refresh rides authenticated traffic, so the build minute is by
  // construction their LAST ONLINE MOMENT, and `isSnapshotStale` is day-granular for a
  // profile-day payload, so /offline renders it all day with no qualifier. A frozen
  // `postWorkoutReady: false` would therefore withhold the dose for sixteen hours while
  // the page they cannot reach says it is due — #5321's own harm, pointed the other way.
  const buildAt = (profileId: number, day: string, hhmm: string): string[] => {
    vi.setSystemTime(new Date(`${day}T${hhmm}:00.000Z`));
    return offlineDoseNames(profileId);
  };

  it("matches the page when the snapshot is READ, not only when it is built", () => {
    const p = newProfile();
    const td = today(p);
    seedItem(p, "Recovery tablet", "post_workout");
    logWorkout(p, td, "07:00", "07:45");

    const stored = buildAt(p, td, "07:20");

    // Read that same payload thirteen hours later. Nothing was rebuilt in between.
    vi.setSystemTime(new Date(`${td}T20:00:00.000Z`));
    expect(pageDueNames(p)).toEqual(["Recovery tablet"]);
    expect(stored).toEqual(["Recovery tablet"]);
  });

  it("does not depend on the minute it happened to be built at", () => {
    const p = newProfile();
    const td = today(p);
    seedItem(p, "Recovery tablet", "post_workout");
    logWorkout(p, td, "07:00", "07:45");

    // Before the session ends, during it, and long after: one day, one stored answer.
    expect(buildAt(p, td, "06:30")).toEqual(["Recovery tablet"]);
    expect(buildAt(p, td, "07:20")).toEqual(["Recovery tablet"]);
    expect(buildAt(p, td, "20:00")).toEqual(["Recovery tablet"]);
  });

  it("still omits what the day itself does not owe", () => {
    // The control that keeps the two above from passing for any reason at all: the
    // day-shaped question is not "offer everything". A rest-day item on a predicted
    // training day is absent at every build minute.
    const p = newProfile();
    const td = today(p);
    for (let w = 1; w <= 8; w++) logWorkout(p, shiftDateStr(td, -w * 7));
    seedItem(p, "Rest-day tablet", "rest_day");

    expect(buildAt(p, td, "07:20")).toEqual([]);
    expect(buildAt(p, td, "20:00")).toEqual([]);
    expect(pageDueNames(p)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE SENDS THIS CONVERSION REACHES (#5321 design amendment, 2026-09-09)
// ---------------------------------------------------------------------------
//
// Two falsifying passes found the same defect twice: a converted call site reached a
// notification SEND that the PR body attributed to a nearer surface, and nothing in the
// repository asserted what was sent. Round one, the digest's due-dose set (asserted
// above). Round two, the digest's offer tail and the intake reminder's ride-along row.
// Both times a query's return value was the only witness, and a query's return value
// cannot tell a correct hold from a wrong one on a message nobody reads back.
//
// So the rule this block exists under: ONE ASSERTION PER SEND the PR body's consumer
// enumeration names, on the SENT CONTENT — the message the profile would actually
// receive, built through the same builder the tick calls.
//
// The enumeration is in the PR body. What lands here is its guard:
//
//   getOfferedIntakeForSlot → gatherDigestInput → buildDigest    the digest's offer
//                                                                count, tail and the
//                                                                withheld line
//   getOfferedIntakeForSlot → buildIntakeReminderForSlots        the reminder's
//                                                                ride-along keyboard
//   pendingDayDoses → getUsualRoutineOffer                       the composed one-tap
//                   → mintUsualRoutineAttachment                 riding a send
//
// The first was found by round two; the third was found by neither pass and is reported
// on the PR as a new finding rather than covered quietly.

// A profile with NOTHING else to say: the two seasonal vaccines recorded so the
// immunization band is empty, and its rows aged out of the digest's 24-hour
// recent-changes window. That is what it takes to reach the minimal-digest guard
// (lib/notifications/digest.ts) — and reaching it is the point, because the guard is
// what the owner's ruling is about. Every other fixture in this file has incidental
// Today content, which is exactly why the whole-send suppression was invisible until
// someone built this.
function quietProfile(): number {
  const p = newProfile();
  const td = today(p);
  for (const vaccine of ["influenza", "covid"]) {
    db.prepare(
      `INSERT INTO immunizations (profile_id, date, vaccine, source)
       VALUES (?, ?, ?, 'manual')`
    ).run(p, td, vaccine);
  }
  return p;
}

// Age every row this profile owns out of the digest's "New since yesterday" window.
// Called AFTER seeding, so the fixture's own inserts do not become the news.
function ageRows(profileId: number): void {
  db.prepare(
    "UPDATE intake_items SET created_at = datetime('now','-30 days') WHERE profile_id = ?"
  ).run(profileId);
  db.prepare(
    `UPDATE intake_item_doses SET created_at = datetime('now','-30 days')
      WHERE item_id IN (SELECT id FROM intake_items WHERE profile_id = ?)`
  ).run(profileId);
  db.prepare(
    "UPDATE activities SET created_at = datetime('now','-30 days') WHERE profile_id = ?"
  ).run(profileId);
}

/** The message this profile would actually receive, or null when nothing is sent. */
function sentDigest(profileId: number): {
  body: string;
  actionLabels: string[];
} | null {
  const model = buildDigest(gatherDigestInput(profileId, "Digest Send"));
  if (!model) return null;
  const msg = renderDigestMessage(model);
  return {
    body: plainBody(msg.body),
    actionLabels: (msg.actions ?? []).map((a) => a.label),
  };
}

describe("the digest still sends while the timing gate holds the only offer (#5321)", () => {
  // THE OWNER'S RULING, 2026-09-09 21:20 UTC, and the defect it answers.
  //
  // `getOfferedIntakeForSlot` feeds `offerCount` and `offerTail`. When a profile's ONLY
  // on-demand item is post-workout, the gate empties both — and the minimal-digest
  // guard suppresses a message with no sections and no tail. Measured on the head
  // before this change: `buildDigest` returned null for the whole mid-session window,
  // where the base sent a tail-only message. The digest is the guaranteed access path
  // for a tap-only reader (#1505); losing it on the day they trained is a worse failure
  // than the over-offer this PR set out to fix.
  //
  // The ruling keeps the send and makes it honest: do not OFFER what the medications
  // page holds, but NAME the hold — the same sentence the page's own answer implies.
  it("names the hold instead of offering it, then offers it once the session ends", () => {
    const p = quietProfile();
    const td = today(p);
    seedItem(p, "Ibuprofen", "post_workout", {
      obligation: "may",
      timeOfDay: null,
    });
    logWorkout(p, td, "17:00", "18:00");
    ageRows(p);

    // MID-SESSION. The page holds the item, so the digest does not offer it — and the
    // message arrives anyway, carrying one line that says why.
    vi.setSystemTime(new Date(`${td}T09:00:00.000Z`));
    expect(pageDueNames(p)).toEqual([]);
    const mid = gatherDigestInput(p, "Digest Send");
    expect(mid.offerCount).toBe(0);
    expect(mid.offerTail).toBeNull();
    const midSent = sentDigest(p);
    expect(midSent).not.toBeNull();
    expect(midSent!.body).toContain("Ibuprofen waits until your session ends");
    // Named, not offered: no tap exists for an item the app is deliberately holding.
    expect(midSent!.actionLabels).not.toContain("➕ Doses (1)");

    // AFTER THE RECORDED END. The hold lifts by itself: the tail is back, and the line
    // that explained its absence is gone rather than sitting beside its own refutation.
    vi.setSystemTime(new Date(`${td}T19:00:00.000Z`));
    const after = gatherDigestInput(p, "Digest Send");
    expect(after.offerCount).toBe(1);
    expect(after.offerTail).not.toBeNull();
    const afterSent = sentDigest(p);
    expect(afterSent).not.toBeNull();
    expect(afterSent!.body).not.toContain("waits until your session ends");
    expect(afterSent!.body).toContain("1 more supplement you can log any time");
    expect(afterSent!.actionLabels).toContain("➕ Doses (1)");
  });

  // THE CONTROL FOR THE SEND ITSELF. Without this, the test above passes on a head that
  // suppresses nothing because it never held anything — and passes just as well on the
  // head that suppressed the whole message, since `toContain` on a null body would have
  // thrown for a reason no reader would connect to the guard. This asserts the property
  // the ruling is about: a profile with nothing else to say still receives a message in
  // BOTH windows, and the two differ only in which line they carry.
  it("sends in both windows for a profile with nothing else to say", () => {
    const p = quietProfile();
    const td = today(p);
    seedItem(p, "Ibuprofen", "post_workout", {
      obligation: "may",
      timeOfDay: null,
    });
    logWorkout(p, td, "17:00", "18:00");
    ageRows(p);

    vi.setSystemTime(new Date(`${td}T09:00:00.000Z`));
    expect(sentDigest(p)).not.toBeNull();
    vi.setSystemTime(new Date(`${td}T19:00:00.000Z`));
    expect(sentDigest(p)).not.toBeNull();

    // And it is not simply always non-null: a quiet profile with no `may` item at all
    // is still suppressed, which is the #1505 rule this line must not have widened.
    const silent = quietProfile();
    ageRows(silent);
    expect(sentDigest(silent)).toBeNull();
  });
});

describe("the intake reminder's ride-along keyboard follows the same gate (#5321)", () => {
  // THE SECOND SEND round two named. `buildIntakeReminderForSlots` decorates a reminder
  // that is going out anyway with a "➕ Log other (N)" row over the SAME slot's `may`
  // items — `getOfferedIntakeForSlot`, the converted call site. So the conversion
  // changes a KEYBOARD that is pushed to a phone, not only a page's rows.
  //
  // Asserted on the built message's actions rather than on the query, because that is
  // the thing the person receives. A reminder with no ride-along row and a reminder
  // whose row promises an item the medications page holds are indistinguishable from
  // the query's side.
  it("drops the row while the session runs and restores it after", () => {
    const p = newProfile();
    const td = today(p);
    // The reminder itself: a Morning `should` dose, so a send exists for the row to
    // ride. The ride-along may only decorate a send that exists for its own reasons.
    seedItem(p, "Morning tablet", "daily");
    seedItem(p, "Ibuprofen", "post_workout", {
      obligation: "may",
      timeOfDay: null,
    });
    logWorkout(p, td, "17:00", "18:00");

    vi.setSystemTime(new Date(`${td}T09:00:00.000Z`));
    const mid = buildIntakeReminderForSlots(p, ["Morning"]);
    expect(mid).not.toBeNull();
    expect((mid!.message.actions ?? []).map((a) => a.label)).not.toContain(
      "➕ Log other (1)"
    );

    vi.setSystemTime(new Date(`${td}T19:00:00.000Z`));
    const after = buildIntakeReminderForSlots(p, ["Morning"]);
    expect(after).not.toBeNull();
    expect((after!.message.actions ?? []).map((a) => a.label)).toContain(
      "➕ Log other (1)"
    );
  });
});

describe("the composed one-tap riding a send follows it too (#5321)", () => {
  // A SEND NEITHER FALSIFYING PASS NAMED, found by re-deriving the call graph for the
  // amendment rather than re-reading the diff. `pendingDayDoses` was disclosed as "the
  // day ledger and the bulk tap's write set" — both true, both in-app. It also reaches
  // a message:
  //
  //   pendingDayDoses → getPendingRoutineDoses (queries/usual-routine.ts)
  //                   → getUsualRoutineOffer   (same file)
  //                   → mintUsualRoutineAttachment (notifications/usual-routine-attach.ts)
  //                   → attachUsualRoutine, from notifications/tick.ts and the
  //                     reconcile sweep — a keyboard on a pushed message.
  //
  // The attachment NAMES the doses one tap will write, and that tap writes: the handler
  // runs `logUsualRoutineCore`, which marks each dose taken and decrements on-hand
  // supply. So before this conversion a message could offer, in one button, a dose the
  // medications page was holding — and spend real stock on it.
  //
  // The food half is the gate (no habitual food offer, no control at all), so the
  // fixture builds one: twelve mornings of the same two groups, today deliberately
  // empty. The dose rides.
  function tapFood(
    profileId: number,
    group: string,
    date: string,
    hhmmss: string
  ): void {
    db.prepare(
      `INSERT INTO food_daily_totals (profile_id, date, group_key, servings) VALUES (?, ?, ?, 1)
         ON CONFLICT(profile_id, date, group_key) DO UPDATE SET servings = servings + 1`
    ).run(profileId, date, group);
    db.prepare(
      `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at)
       VALUES (?, ?, ?, ?)`
    ).run(profileId, group, date, `${date}T${hhmmss}Z`);
  }

  it("keeps a held dose out of the button's bundle until the session ends", () => {
    const p = newProfile();
    const td = today(p);
    for (let d = 1; d <= 12; d++) {
      const day = shiftDateStr(td, -d);
      tapFood(p, "berries", day, "07:00:00");
      tapFood(p, "fermented", day, "07:05:00");
    }
    seedItem(p, "Recovery tablet", "post_workout");
    // A session inside the Morning food window (00:00-11:00, lib/food-slot.ts), because
    // the food half is slot-anchored: both readings have to be asked of the window the
    // habit was built in, or the second one is measuring a missing breakfast offer
    // rather than the dose gate.
    logWorkout(p, td, "09:00", "10:00");

    // Mid-session: the food half still stands, so the button is still offered — and the
    // dose the page holds is not in what it would write.
    vi.setSystemTime(new Date(`${td}T08:00:00.000Z`));
    const slot = currentFoodSlotWindow(p).slot;
    expect(pageDueNames(p)).toEqual([]);
    const mid = mintUsualRoutineAttachment(p, slot, td);
    expect(mid).not.toBeNull();
    // The SENTENCE the message says and the COUNT on its button, not the query behind
    // them: an offer may never name less than the tap would write (#2460), so the line
    // and the count are the promise, and they are what a reader is held to.
    expect(mid!.line).not.toContain("Recovery tablet");
    expect(mid!.label).toContain("(2)");

    // After the recorded end, same window: the dose joins the bundle the same tap writes.
    vi.setSystemTime(new Date(`${td}T10:30:00.000Z`));
    const after = mintUsualRoutineAttachment(
      p,
      currentFoodSlotWindow(p).slot,
      td
    );
    expect(after).not.toBeNull();
    expect(after!.line).toContain("Recovery tablet");
    expect(after!.label).toContain("(3)");
  });
});

describe("the subscribed calendar feed follows it too (#5321)", () => {
  // THE THIRD REACH OF `scheduledDoseRows`, and the other one neither pass named. The
  // digest and the page rows are both inside the app; this leaves it. `dose` is one of
  // the ten feed categories (lib/calendar-ics.ts), so a profile that opted its doses
  // into the ICS feed publishes them to whatever calendar client subscribes:
  //
  //   scheduledDoseRows → doseItems (queries/upcoming/intake-safety.ts)
  //                     → collectUpcoming (queries/upcoming/generators.ts)
  //                     → feedEligibleSignals (app/api/calendar/[token]/route.ts)
  //                     → the served .ics body
  //
  // Asserted on the SERVED BODY rather than on `collectUpcoming`, for the same reason
  // the sends above are asserted on their messages: the feed is the artifact a third
  // party reads, and a query's return value cannot say what left the instance.
  //
  // Not a push, so it is not in the send list — it is a pull the subscriber's client
  // makes. It is guarded anyway because it is content that leaves the app, and because
  // an .ics is cached by the client for as long as it feels like.
  it("does not publish a held dose, then publishes it", async () => {
    const p = newProfile();
    const td = today(p);
    seedItem(p, "Recovery tablet", "post_workout");
    logWorkout(p, td, "17:00", "18:00");
    const token = mintCalendarFeedToken(p);
    // Doses are OPT-IN: the default feed carries appointments only.
    setCalendarFeedOptions(p, {
      categories: ["appointment", "dose"],
      reminders: false,
      pastWindowDays: 30,
      futureWindowDays: null,
    });

    const body = async (): Promise<string> => {
      const res = await calendarFeedGET(
        new Request(`http://x/api/calendar/${token}`),
        { params: Promise.resolve({ token }) }
      );
      return await res.text();
    };

    // The feed REDACTS the item (`SUMMARY:Medication / supplement dose`, the Minimal
    // detail level), so the assertion is on whether the event is published at all —
    // which is the whole question here, and the redaction is why nobody would have
    // noticed the wrong answer by reading a calendar.
    const doseEvents = async (): Promise<number> =>
      (await body()).split("SUMMARY:Medication / supplement dose").length - 1;

    vi.setSystemTime(new Date(`${td}T09:00:00.000Z`));
    expect(pageDueNames(p)).toEqual([]);
    expect(await doseEvents()).toBe(0);

    vi.setSystemTime(new Date(`${td}T19:00:00.000Z`));
    expect(pageDueNames(p)).toEqual(["Recovery tablet"]);
    expect(await doseEvents()).toBe(1);
  });
});
