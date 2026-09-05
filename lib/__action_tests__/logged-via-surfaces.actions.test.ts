// SERVER-ACTION TIER — the four WEB surfaces of `logged_via` (#3087), each driven
// END TO END through the real Server Action a browser posts to, plus the offline
// replay driven through its real route.
//
// WHY THIS IS NOT A UNIT TEST OF THE ENUM, and why the AC says it must not be. Three
// of these four surfaces post the SAME Server Action — the dashboard's weigh-in
// widget and the Trends page's add form both call `addMeasurements`; the quick-log
// sheet's dose list and the Upcoming page's inline confirm both call `markTaken`.
// A unit test of the vocabulary would pass with every one of them landing in the same
// bucket. The only thing that can tell them apart is the round trip: the mounting
// declares itself in the post, the action parses that claim against the web subset,
// and the row is read back.
//
// The two CHAT surfaces and the schema half live in
// lib/__db_tests__/logged-via-provenance.test.ts.

import { describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import { LOGGED_VIA_FIELD } from "@/lib/logged-via";
import { SLEEP_METRIC } from "@/lib/vitals-input";
import { actAs, createLogin, createProfile, fd } from "./harness";

import { logUsualRoutine, markAttentionDose } from "@/app/(app)/actions";
import { addMeasurements } from "@/app/(app)/trends/measurement-actions";
import { saveSleepMoodEntry } from "@/app/(app)/sleep/actions";
import { logMedicationAdministration } from "@/app/(app)/medications/actions";
import { markTaken } from "@/app/(app)/upcoming/actions";
import { logPractice } from "@/app/(app)/wellness/actions";
import { POST as replayPost } from "@/app/api/offline-replay/route";

function seat(name: string) {
  const login = createLogin();
  const profile = createProfile(name, login.id);
  actAs(login, profile);
  return { login, profile };
}

/** A pending MORNING dose — what the composed one-tap's dose half re-derives. */
function morningDose(profileId: number, name: string): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, active, obligation, condition)
         VALUES (?, ?, 'supplement', 1, 'should', 'daily')`
      )
      .run(profileId, name).lastInsertRowid
  );
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, sort)
         VALUES (?, '1', 'morning', 0)`
      )
      .run(itemId).lastInsertRowid
  );
}

/**
 * Twelve mornings of the same two food groups, which is what makes the composed
 * one-tap's FOOD half offer anything at all. Without a standing habit
 * `getUsualFoodOffer` is empty and the food half writes nothing — which is exactly how
 * a fixture that drives only the dose half can leave the food half's surface unpinned.
 */
function seedUsualFoodHabit(profileId: number, anchor: string): string[] {
  const groups = ["berries", "fermented"];
  for (let d = 1; d <= 12; d++) {
    const date = shiftDateStr(anchor, -d);
    for (const [i, group] of groups.entries()) {
      db.prepare(
        `INSERT INTO food_daily_totals (profile_id, date, group_key, servings)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(profile_id, date, group_key)
         DO UPDATE SET servings = servings + 1`
      ).run(profileId, date, group);
      db.prepare(
        `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at)
         VALUES (?, ?, ?, ?)`
      ).run(profileId, group, date, `${date}T08:0${i}:00Z`);
    }
  }
  return groups;
}

/** What the food half of the composed one-tap wrote, per group, for a date. */
function foodOrigins(profileId: number, date: string) {
  return db
    .prepare(
      `SELECT group_key, logged_via FROM food_log_events
        WHERE profile_id = ? AND date = ? ORDER BY group_key`
    )
    .all(profileId, date) as { group_key: string; logged_via: string | null }[];
}

/** A scheduled dose that nothing has been logged against yet. */
function dose(profileId: number, name: string): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, active, obligation)
         VALUES (?, ?, 'supplement', 1, 'should')`
      )
      .run(profileId, name).lastInsertRowid
  );
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, sort) VALUES (?, '1', 0)`
      )
      .run(itemId).lastInsertRowid
  );
}

function doseOrigin(doseId: number, date: string): string | null | undefined {
  return (
    db
      .prepare(
        `SELECT logged_via FROM intake_item_logs WHERE dose_id = ? AND date = ?`
      )
      .get(doseId, date) as { logged_via: string | null } | undefined
  )?.logged_via;
}

function practiceOrigin(
  profileId: number,
  practice: string
): string | null | undefined {
  return (
    db
      .prepare(
        `SELECT logged_via FROM practice_logs
          WHERE profile_id = ? AND practice = ? ORDER BY id DESC LIMIT 1`
      )
      .get(profileId, practice) as { logged_via: string | null } | undefined
  )?.logged_via;
}

function weightOrigin(profileId: number, date: string) {
  return db
    .prepare(
      `SELECT logged_via, source FROM body_metrics
        WHERE profile_id = ? AND date = ? ORDER BY id DESC LIMIT 1`
    )
    .get(profileId, date) as
    { logged_via: string | null; source: string | null } | undefined;
}

describe("each web surface stores its OWN value, through its own real action", () => {
  it("distinguishes the dashboard hero, quick-log sheet, and page dose surfaces", async () => {
    const { profile } = seat("lv dose surfaces");
    const date = today(profile.id);
    const hero = dose(profile.id, "lv hero supplement");
    const quick = dose(profile.id, "lv sheet supplement");
    const page = dose(profile.id, "lv page supplement");

    expect((await markAttentionDose(fd({ dose_id: hero }))).ok).toBe(true);
    // The attention card is a single-surface action, so it names itself rather than
    // reading a posted field — nothing else mounts it.
    expect(doseOrigin(hero, date)).toBe("dashboard-hero");

    // What components/quick-entry/QuickDoseList.tsx sets.
    expect(
      (await markTaken(fd({ dose_id: quick, [LOGGED_VIA_FIELD]: "quick-log" })))
        .ok
    ).toBe(true);
    expect(doseOrigin(quick, date)).toBe("quick-log");

    // The Upcoming page's inline confirm posts `page` — the value its region
    // resolves to, and the same one the action falls back to for an older client.
    expect((await markTaken(fd({ dose_id: page }))).ok).toBe(true);
    expect(doseOrigin(page, date)).toBe("page");
  });

  it("a DASHBOARD-WIDGET control stores dashboard-widget", async () => {
    const { profile } = seat("lv widget");
    const date = today(profile.id);
    // What a control inside the dashboard's LoggedViaSurface region sets.
    await addMeasurements(
      fd({
        date,
        weight: "80",
        weight_unit: "kg",
        [LOGGED_VIA_FIELD]: "dashboard-widget",
      })
    );
    const row = weightOrigin(profile.id, date);
    expect(row?.logged_via).toBe("dashboard-widget");
    // And `source` keeps its own meaning beside it: no importer produced this row.
    expect(row?.source).toBeNull();
  });

  it("the composed ONE-TAP is told apart by the post — it is on no attention card", async () => {
    // #2458's flagship write, and the case that shipped naming `dashboard-hero` with
    // no branch at all. `UsualRoutineControl` is mounted TWICE — the dashboard's
    // usual-routine atom and the phone dock's raised puck inside the quick-log sheet —
    // and neither is the attention card, whose meaning record reads "a confirm on the
    // attention card". So the surface has to ride the post like every other control
    // with more than one mounting.
    //
    // BOTH HALVES, because the tap is one tap and the column has to say so twice.
    // The earlier version of this drove only the dose half and rested on "both halves
    // take the same `loggedVia` argument by the core's signature" — which is exactly
    // the premise the previous round shipped on: replacing the food half's argument in
    // lib/usual-routine-write.ts with the literal `"dashboard-hero"` left every tier
    // green, because nothing anywhere read a food event's `logged_via` back on this
    // path. The food half needs a standing habit before it offers anything, which is
    // why the fixture is three lines longer rather than one assertion shorter.
    const { login, profile } = seat("lv usual");
    setTimezone(profile.id, "UTC");
    const date = today(profile.id);
    for (const [surface, name] of [
      ["dashboard-widget", "lv usual atom"],
      ["quick-log", "lv usual puck"],
    ] as const) {
      // A fresh profile per surface: the food half collapses once the window is
      // logged, so the second surface needs its own standing offer.
      const { profile: p } = seat(name);
      setTimezone(p.id, "UTC");
      const day = today(p.id);
      const groups = seedUsualFoodHabit(p.id, day);
      const doseId = morningDose(p.id, name);
      const posted = fd({
        meal_slot: "Morning",
        groups: groups.join(","),
        dose_ids: doseId,
        [LOGGED_VIA_FIELD]: surface,
      });
      expect((await logUsualRoutine(posted)).ok, surface).toBe(true);
      expect(doseOrigin(doseId, day), surface).toBe(surface);
      // THE FOOD HALF, read back off the per-tap ledger rows the same tap wrote.
      expect(foodOrigins(p.id, day), surface).toEqual(
        groups.map((group_key) => ({ group_key, logged_via: surface }))
      );
    }
    // And with nothing posted it falls back to the action's home, exactly as every
    // other reading action does — never to a surface of its own choosing.
    // Back in the seat: the loop above acted as a fresh profile per surface.
    actAs(login, profile);
    const bareGroups = seedUsualFoodHabit(profile.id, date);
    const bare = morningDose(profile.id, "lv usual bare");
    const barePost = fd({
      meal_slot: "Morning",
      groups: bareGroups.join(","),
      dose_ids: bare,
    });
    expect((await logUsualRoutine(barePost)).ok).toBe(true);
    expect(doseOrigin(bare, date)).toBe("page");
    expect(foodOrigins(profile.id, date)).toEqual(
      bareGroups.map((group_key) => ({ group_key, logged_via: "page" }))
    );
  });

  it("the practice button's four mountings are told apart by the post alone", async () => {
    // components/practices/LogPracticeButton.tsx renders on the Wellness page, the
    // protocols row, the quick-log sheet and the backfill launcher, all posting
    // `logPractice`. This is the case the column exists for.
    const { profile } = seat("lv practice");

    const sheet = fd({
      practice: "lv sheet practice",
      [LOGGED_VIA_FIELD]: "quick-log",
    });
    expect((await logPractice(sheet)).kind).toBe("logged");
    expect(practiceOrigin(profile.id, "lv sheet practice")).toBe("quick-log");

    const card = fd({
      practice: "lv card practice",
      [LOGGED_VIA_FIELD]: "dashboard-widget",
    });
    expect((await logPractice(card)).kind).toBe("logged");
    expect(practiceOrigin(profile.id, "lv card practice")).toBe(
      "dashboard-widget"
    );

    const page = fd({ practice: "lv page practice" });
    expect((await logPractice(page)).kind).toBe("logged");
    expect(practiceOrigin(profile.id, "lv page practice")).toBe("page");
  });

  it("REFUSES a forged claim from the browser and falls back to the action's home", async () => {
    // A post is attacker-controlled. `telegram-nudge` is exactly the value a later
    // analysis draws conclusions from ("does the nudge actually get used"), so a
    // browser must not be able to write it — and an unknown string must never be
    // stored at all.
    const { profile } = seat("lv forged");
    for (const [practice, claim] of [
      ["lv forged nudge", "telegram-nudge"],
      ["lv forged import", "import"],
      ["lv forged replay", "offline-replay"],
      ["lv forged junk", "not-a-surface"],
    ] as const) {
      const forged = fd({ practice, [LOGGED_VIA_FIELD]: claim });
      expect((await logPractice(forged)).kind).toBe("logged");
      expect(practiceOrigin(profile.id, practice), claim).toBe("page");
    }
  });
});

/** The vitals rows one measurements sitting wrote, by canonical name. */
function vitalOrigins(
  profileId: number,
  date: string
): Record<string, string | null> {
  const rows = db
    .prepare(
      `SELECT canonical_name, logged_via FROM medical_records
        WHERE profile_id = ? AND date = ?`
    )
    .all(profileId, date) as {
    canonical_name: string | null;
    logged_via: string | null;
  }[];
  return Object.fromEntries(
    rows.map((r) => [r.canonical_name ?? "?", r.logged_via])
  );
}

describe("the VITALS half of a sitting is on the same surface as its body half", () => {
  it("records the measurements form, NOT an offline replay, for an ONLINE submission", async () => {
    // THE DEFECT WAS A LITERAL AT THE CALL SITE, so this drives the real Server
    // Action rather than the core: `insertVitals` lives under lib/offline/ and used
    // to spell `offline-replay` inline, which meant every blood pressure, glucose,
    // SpO2 and temperature a person typed into the Trends form read back as a queued
    // write replayed after reconnect. Calling the core with a literal here would
    // reproduce nothing.
    const { profile } = seat("lv vitals online");
    const date = today(profile.id);
    await addMeasurements(
      fd({ date, systolic: "118", diastolic: "76", spo2: "97" })
    );

    const origins = vitalOrigins(profile.id, date);
    expect(Object.keys(origins).length).toBeGreaterThan(0);
    for (const [name, via] of Object.entries(origins)) {
      expect(via, name).toBe("page");
    }

    // The body half (`insertBodyMetric`) and the vitals half (`insertVitals`) are two
    // cores serving one form, twenty-seven lines apart in one action. They stamped
    // `page` and `offline-replay` respectively, so a single tap on Save produced two
    // rows that disagree about where the person was standing.
    const quickDate = shiftDateStr(date, -1);
    // The quick-log sheet's mounting of the same form (#3087) — which is also what
    // proves the value is READ rather than hard-coded on either side.
    await addMeasurements(
      fd({
        date: quickDate,
        weight: "80",
        weight_unit: "kg",
        temperature: "98.6",
        temp_unit: "F",
        [LOGGED_VIA_FIELD]: "quick-log",
      })
    );

    expect(weightOrigin(profile.id, quickDate)?.logged_via).toBe("quick-log");
    const quickOrigins = vitalOrigins(profile.id, quickDate);
    expect(Object.keys(quickOrigins).length).toBeGreaterThan(0);
    for (const [name, via] of Object.entries(quickOrigins)) {
      expect(via, name).toBe("quick-log");
    }
  });

  it("lets the SLEEP form through the same core without writing a tranche row", async () => {
    // The core's THIRD caller, and the second online one. Sleep has no canonical
    // reading identity, so the policy routes it to `metric_samples` — outside #3087's
    // first tranche, no `logged_via` column — which is why this leg wrote nothing
    // wrong even while the constant was hard-coded. It still has to pass an origin
    // now (the core takes one with no default), and this drives the real action to
    // show the submission lands and that the sitting adds nothing to any tranche
    // ledger it should not.
    const { profile } = seat("lv sleep");
    const date = today(profile.id);
    expect(
      (await saveSleepMoodEntry(fd({ date, sleep_hours: "7.5" }))).ok
    ).toBe(true);
    const sample = db
      .prepare(
        `SELECT value FROM metric_samples
          WHERE profile_id = ? AND date = ? AND metric = ?`
      )
      .get(profile.id, date, SLEEP_METRIC) as { value: number } | undefined;
    // Stored in MINUTES, the canonical unit for this metric.
    expect(sample?.value).toBe(450);
    expect(vitalOrigins(profile.id, date)).toEqual({});
  });
});

describe("a PRN administration is told apart by the surface that posted it", () => {
  it("records the command palette, the dashboard card and the page separately", async () => {
    // `logMedicationAdministration` hard-coded `page` with a comment naming the
    // medications page's own form — while `components/CommandPalette.tsx` and
    // `QuickLogPrnControl` (mounted on the DASHBOARD and in the illness cockpit)
    // both post it.
    const { profile } = seat("lv prn surfaces");
    const date = today(profile.id);
    const made: Record<string, number> = {};
    for (const [label, claim] of [
      ["lv prn palette", "quick-log"],
      ["lv prn dashboard", "dashboard-widget"],
      ["lv prn page", null],
    ] as const) {
      const itemId = Number(
        db
          .prepare(
            `INSERT INTO intake_items (profile_id, name, kind, active, obligation)
             VALUES (?, ?, 'medication', 1, 'may')`
          )
          .run(profile.id, label).lastInsertRowid
      );
      db.prepare(
        `INSERT INTO intake_item_doses (item_id, amount, sort) VALUES (?, '1', 0)`
      ).run(itemId);
      made[label] = itemId;
      const posted = fd({ id: itemId, [LOGGED_VIA_FIELD]: claim });
      expect((await logMedicationAdministration(posted)).ok).toBe(true);
    }
    const via = (itemId: number) =>
      (
        db
          .prepare(
            `SELECT logged_via FROM intake_item_logs
              WHERE item_id = ? AND date = ? ORDER BY id DESC LIMIT 1`
          )
          .get(itemId, date) as { logged_via: string | null } | undefined
      )?.logged_via;
    expect(via(made["lv prn palette"])).toBe("quick-log");
    expect(via(made["lv prn dashboard"])).toBe("dashboard-widget");
    expect(via(made["lv prn page"])).toBe("page");
  });
});

describe("an OFFLINE REPLAY records offline-replay — the REPLAY, deliberately, never the surface that queued the write", () => {
  it("stamps the replay even though some page's control captured the intent", async () => {
    // THE NAME OF THIS TEST IS THE ARGUMENT, and the choice is deliberate rather than
    // a shortcut. A queued intent carries no honest record of which control produced
    // it: the surfaces are several mountings of one action, the capture predates the
    // round trip, and the queue payload (lib/offline/queue.ts) does not carry one.
    // Inventing a surface at replay time would put a guess into the column whose
    // entire value is that it does not guess.
    //
    // It is also the USEFUL answer. "Do offline-queued writes ever actually land?"
    // was unanswerable before this column, and it is answerable now precisely because
    // the replay names itself instead of impersonating a page.
    const { profile } = seat("lv replay");
    const date = today(profile.id);
    const res = await replayPost(
      new Request("http://x/api/offline-replay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intents: [
            {
              key: `lv replay key ${profile.id}`,
              flow: "practice",
              date,
              profileId: profile.id,
              payload: { practice: "lv replayed practice" },
            },
            {
              key: `lv replay vitals key ${profile.id}`,
              flow: "vitals",
              date,
              profileId: profile.id,
              payload: {
                systolic: "122",
                diastolic: "78",
                glucose: null,
                glucoseUnit: null,
                spo2: null,
                temperature: null,
                tempUnit: null,
                sleepHours: null,
                hrv: null,
              },
            },
          ],
        }),
      })
    );
    expect(res.status).toBe(200);
    expect(practiceOrigin(profile.id, "lv replayed practice")).toBe(
      "offline-replay"
    );
    const origins = vitalOrigins(profile.id, date);
    expect(Object.keys(origins).length).toBeGreaterThan(0);
    for (const [name, via] of Object.entries(origins)) {
      expect(via, name).toBe("offline-replay");
    }
  });
});
