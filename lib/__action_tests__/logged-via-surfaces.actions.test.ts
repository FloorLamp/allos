// SERVER-ACTION TIER — the four WEB surfaces of `logged_via` (#3087), each driven
// END TO END through the real Server Action a browser posts to, plus the offline
// replay driven through its real route.
//
// WHY THIS IS NOT A UNIT TEST OF THE ENUM, and why the AC says it must not be. Three
// of these four surfaces post the SAME Server Action — the dashboard's weigh-in
// widget and the Trends page's add form both call `addBodyMetric`; the quick-log
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
import { LOGGED_VIA_FIELD } from "@/lib/logged-via";
import { SLEEP_METRIC } from "@/lib/vitals-input";
import { actAs, createLogin, createProfile } from "./harness";

import { markAttentionDose } from "@/app/(app)/actions";
import { addMeasurements } from "@/app/(app)/trends/measurement-actions";
import { saveSleepMoodEntry } from "@/app/(app)/sleep/actions";
import { logMedicationAdministration } from "@/app/(app)/medications/actions";
import { markTaken } from "@/app/(app)/upcoming/actions";
import { logPractice } from "@/app/(app)/wellness/actions";
import { addBodyMetric } from "@/app/(app)/trends/body-actions";
import { POST as replayPost } from "@/app/api/offline-replay/route";

function seat(name: string) {
  const login = createLogin();
  const profile = createProfile(name, login.id);
  actAs(login, profile);
  return { login, profile };
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
  it("a DASHBOARD-HERO confirm on the attention card stores dashboard-hero", async () => {
    const { profile } = seat("lv hero");
    const date = today(profile.id);
    const doseId = dose(profile.id, "lv hero supplement");
    const fd = new FormData();
    fd.set("dose_id", String(doseId));
    const result = await markAttentionDose(fd);
    expect(result.ok).toBe(true);
    // The attention card is a single-surface action, so it names itself rather than
    // reading a posted field — nothing else mounts it.
    expect(doseOrigin(doseId, date)).toBe("dashboard-hero");
  });

  it("a QUICK-LOG sheet write stores quick-log, on the SAME action the page posts", async () => {
    const { profile } = seat("lv sheet");
    const date = today(profile.id);
    const doseId = dose(profile.id, "lv sheet supplement");
    const fd = new FormData();
    fd.set("dose_id", String(doseId));
    // What components/quick-entry/QuickDoseList.tsx sets.
    fd.set(LOGGED_VIA_FIELD, "quick-log");
    expect((await markTaken(fd)).ok).toBe(true);
    expect(doseOrigin(doseId, date)).toBe("quick-log");
  });

  it("a PAGE form stores page — the same action, with no claim posted", async () => {
    const { profile } = seat("lv page");
    const date = today(profile.id);
    const doseId = dose(profile.id, "lv page supplement");
    const fd = new FormData();
    fd.set("dose_id", String(doseId));
    // The Upcoming page's inline confirm posts no surface field: `page` is the
    // action's own home, and the fallback is what an older client gets too.
    expect((await markTaken(fd)).ok).toBe(true);
    expect(doseOrigin(doseId, date)).toBe("page");
  });

  it("a DASHBOARD-WIDGET control stores dashboard-widget", async () => {
    const { profile } = seat("lv widget");
    const date = today(profile.id);
    const fd = new FormData();
    fd.set("date", date);
    fd.set("weight", "80");
    fd.set("weight_unit", "kg");
    // What components/dashboard/WeightQuickAdd.tsx sets.
    fd.set(LOGGED_VIA_FIELD, "dashboard-widget");
    await addBodyMetric(fd);
    const row = weightOrigin(profile.id, date);
    expect(row?.logged_via).toBe("dashboard-widget");
    // And `source` keeps its own meaning beside it: no importer produced this row.
    expect(row?.source).toBeNull();
  });

  it("the practice button's four mountings are told apart by the post alone", async () => {
    // components/practices/LogPracticeButton.tsx renders on the Wellness page, the
    // protocols row, the quick-log sheet and the backfill launcher, all posting
    // `logPractice`. This is the case the column exists for.
    const { profile } = seat("lv practice");

    const sheet = new FormData();
    sheet.set("practice", "lv sheet practice");
    sheet.set(LOGGED_VIA_FIELD, "quick-log");
    expect((await logPractice(sheet)).kind).toBe("logged");
    expect(practiceOrigin(profile.id, "lv sheet practice")).toBe("quick-log");

    const card = new FormData();
    card.set("practice", "lv card practice");
    card.set(LOGGED_VIA_FIELD, "dashboard-widget");
    expect((await logPractice(card)).kind).toBe("logged");
    expect(practiceOrigin(profile.id, "lv card practice")).toBe(
      "dashboard-widget"
    );

    const page = new FormData();
    page.set("practice", "lv page practice");
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
      const fd = new FormData();
      fd.set("practice", practice);
      fd.set(LOGGED_VIA_FIELD, claim);
      expect((await logPractice(fd)).kind).toBe("logged");
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
    const fd = new FormData();
    fd.set("date", date);
    fd.set("systolic", "118");
    fd.set("diastolic", "76");
    fd.set("spo2", "97");
    await addMeasurements(fd);

    const origins = vitalOrigins(profile.id, date);
    expect(Object.keys(origins).length).toBeGreaterThan(0);
    for (const [name, via] of Object.entries(origins)) {
      expect(via, name).toBe("page");
    }
  });

  it("gives ONE submission ONE answer across its two write cores", async () => {
    // The body half (`insertBodyMetric`) and the vitals half (`insertVitals`) are two
    // cores serving one form, twenty-seven lines apart in one action. They stamped
    // `page` and `offline-replay` respectively, so a single tap on Save produced two
    // rows that disagree about where the person was standing.
    const { profile } = seat("lv vitals sitting");
    const date = today(profile.id);
    const fd = new FormData();
    fd.set("date", date);
    fd.set("weight", "80");
    fd.set("weight_unit", "kg");
    fd.set("temperature", "98.6");
    fd.set("temp_unit", "F");
    // The quick-log sheet's mounting of the same form (#3087) — which is also what
    // proves the value is READ rather than hard-coded on either side.
    fd.set(LOGGED_VIA_FIELD, "quick-log");
    await addMeasurements(fd);

    expect(weightOrigin(profile.id, date)?.logged_via).toBe("quick-log");
    const origins = vitalOrigins(profile.id, date);
    expect(Object.keys(origins).length).toBeGreaterThan(0);
    for (const [name, via] of Object.entries(origins)) {
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
    const fd = new FormData();
    fd.set("date", date);
    fd.set("sleep_hours", "7.5");
    expect((await saveSleepMoodEntry(fd)).ok).toBe(true);
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
      const fd = new FormData();
      fd.set("id", String(itemId));
      if (claim) fd.set(LOGGED_VIA_FIELD, claim);
      expect((await logMedicationAdministration(fd)).ok).toBe(true);
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
          ],
        }),
      })
    );
    expect(res.status).toBe(200);
    expect(practiceOrigin(profile.id, "lv replayed practice")).toBe(
      "offline-replay"
    );
  });

  it("stamps a replayed VITALS sitting too — the one caller of that core that IS a replay", async () => {
    // The other half of the vitals fix, and the reason it had to be a parameter
    // rather than a deletion: `insertVitals` has three callers, two of them online
    // Server Actions, and exactly this one is the replay. Driven through the real
    // route so the answer comes from the queue's own path.
    const { profile } = seat("lv replay vitals");
    const date = today(profile.id);
    const res = await replayPost(
      new Request("http://x/api/offline-replay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intents: [
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
    const origins = vitalOrigins(profile.id, date);
    expect(Object.keys(origins).length).toBeGreaterThan(0);
    for (const [name, via] of Object.entries(origins)) {
      expect(via, name).toBe("offline-replay");
    }
  });
});
