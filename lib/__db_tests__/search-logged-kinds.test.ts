// DB INTEGRATION TIER — the record's seven logged kinds in global search (#5006).
//
// Search indexed every entity with a page and none of the rows people actually log, so
// "sauna" found the practice card and never this morning's session. Seven bounded reads
// now join the fan-out as ONE `logged` group, and only a live schema can prove the five
// things that matter:
//
//   1. each source returns AT MOST FIVE entries, newest first;
//   2. no entry ever crosses a profile — every fixture below is seeded on a SECOND
//      profile too, and that row is asserted findable from ITS OWN profile, so its
//      absence here is scoping rather than a fixture that could never have produced it;
//   3. the href is `/history?day=…&kind=…#timeline-entry-…` and its fragment RESOLVES —
//      checked against `gatherHistoryLog`'s own rows for that day, never a re-typed
//      string, because a drifted id spelling is a link that scrolls nowhere;
//   4. the entries sit ABOVE the practice that names them and above the kind's static
//      list entry ("Practice history");
//   5. the group is capped at FIVE ACROSS ALL KINDS, ranked date-first over the union —
//      the last describe seeds the fixture that can tell that apart from five per kind.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts. Synthetic,
// clearly fictional fixtures only (no PHI).

import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { searchAll } from "@/lib/queries";
import { gatherHistoryLog } from "@/lib/history";
import { zonedWallTimeToUtc } from "@/lib/date";
import { setLoginSetting, setProfileSetting } from "@/lib/settings";
import { timelineEntryAnchorId } from "@/lib/timeline-format";
import type { SearchHit } from "@/lib/search-rank";
import type { SearchLoggedKind } from "@/lib/queries/search-logged";

const TZ = "America/Los_Angeles";
// Six days, oldest first: one more than the bound, so "at most five, newest first" is
// observable rather than merely satisfied.
const DAYS = [
  "2026-08-24",
  "2026-08-25",
  "2026-08-26",
  "2026-08-27",
  "2026-08-28",
  "2026-08-29",
];
const NEWEST_FIVE = [...DAYS].slice(1).reverse();
// The other profile's day, distinct from every one of mine so a leak names itself.
const OTHER_DAY = "2026-07-04";

let mine = 0;
let other = 0;
let loginId = 0;

function newProfile(name: string): number {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setProfileSetting(profileId, "birthdate", "1985-01-01");
  setProfileSetting(profileId, "timezone", TZ);
  return profileId;
}

function newLogin(): number {
  const id = Number(
    db
      .prepare("INSERT INTO logins (username, password_hash) VALUES (?, 'x')")
      .run("searchlogged1").lastInsertRowid
  );
  setLoginSetting(id, "time_format", "12h");
  return id;
}

// One intake item per profile, so six doses are six administrations of ONE bottle
// rather than six bottles.
const itemByProfile = new Map<number, { itemId: number; doseId: number }>();
function doseItem(profileId: number): { itemId: number; doseId: number } {
  const held = itemByProfile.get(profileId);
  if (held) return held;
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, condition, obligation, active, source)
         VALUES (?, 'Ibuprofen', 'as needed', 'may', 1, 'manual')`
      )
      .run(profileId).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '200 mg', '08:00', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  const made = { itemId, doseId };
  itemByProfile.set(profileId, made);
  return made;
}

// A night stated in the PROFILE's own wall clock and stored as the instants that wall
// clock means — naive `${day}T23:38` strings would be host-UTC and the wake day this
// file asserts on would be the runner's, not the profile's (#1417).
function night(profileId: number, wakeDay: string): void {
  const bedDay = new Date(`${wakeDay}T00:00:00Z`);
  bedDay.setUTCDate(bedDay.getUTCDate() - 1);
  const start = zonedWallTimeToUtc(
    TZ,
    bedDay.toISOString().slice(0, 10),
    "23:38"
  )!.toISOString();
  const end = zonedWallTimeToUtc(TZ, wakeDay, "06:41")!.toISOString();
  db.prepare(
    `INSERT INTO metric_samples
       (profile_id, source, metric, date, started_at, ended_at, value)
     VALUES (?, 'oura', 'sleep_min', ?, ?, ?, 423)`
  ).run(profileId, wakeDay, start, end);
}

/**
 * One kind's fixture and the words a person would type for it.
 *
 * `query` is deliberately the DISPLAY vocabulary where the store keeps a slug — "sore
 * throat" and "leafy greens" match no stored `sore_throat`/`leafy_greens` substring, so
 * a source that only LIKE'd its column would come back empty here.
 */
interface LoggedFixture {
  kind: SearchLoggedKind;
  query: string;
  /** The row's title on the record, which is the hit's title. */
  title: string;
  seed: (profileId: number, day: string) => void;
}

const FIXTURES: LoggedFixture[] = [
  {
    kind: "dose",
    query: "ibuprofen",
    title: "Ibuprofen",
    seed: (profileId, day) => {
      const { itemId, doseId } = doseItem(profileId);
      db.prepare(
        `INSERT INTO intake_item_logs (item_id, dose_id, date, status, amount)
         VALUES (?, ?, ?, 'taken', '200 mg')`
      ).run(itemId, doseId, day);
    },
  },
  {
    kind: "food",
    query: "leafy greens",
    title: "Leafy greens",
    seed: (profileId, day) => {
      db.prepare(
        `INSERT INTO food_log_events (profile_id, date, group_key, meal_slot)
         VALUES (?, ?, 'leafy_greens', 'Midday')`
      ).run(profileId, day);
    },
  },
  {
    kind: "practice",
    query: "sauna",
    title: "Sauna",
    seed: (profileId, day) => {
      db.prepare(
        `INSERT INTO practice_logs (profile_id, date, practice, duration_min)
         VALUES (?, ?, 'Sauna', 20)`
      ).run(profileId, day);
    },
  },
  {
    kind: "symptom",
    query: "sore throat",
    title: "Sore throat",
    seed: (profileId, day) => {
      db.prepare(
        `INSERT INTO symptom_logs (profile_id, date, symptom, severity)
         VALUES (?, ?, 'sore_throat', 2)`
      ).run(profileId, day);
    },
  },
  {
    kind: "mood",
    query: "check-in",
    title: "Mood",
    seed: (profileId, day) => {
      db.prepare(
        `INSERT INTO mood_logs (profile_id, date, valence, energy)
         VALUES (?, ?, 3, 3)`
      ).run(profileId, day);
    },
  },
  {
    kind: "body",
    query: "weight",
    title: "Weight",
    seed: (profileId, day) => {
      db.prepare(
        `INSERT INTO body_metrics (profile_id, date, weight_kg)
         VALUES (?, ?, 70.4)`
      ).run(profileId, day);
    },
  },
  {
    kind: "sleep",
    query: "sleep",
    title: "Sleep",
    seed: (profileId, day) => night(profileId, day),
  },
];

// The one `logged` group. Every query below is chosen so exactly one kind matches it,
// which is what keeps a five-across-all-kinds cap from mixing two fixtures into one
// assertion — the cap's own fixture lives in its own describe, on its own profile.
function loggedHits(profileId: number, query: string): SearchHit[] {
  return (
    searchAll(profileId, query).find((g) => g.domain === "logged")?.hits ?? []
  );
}

function hitsOf(profileId: number, fixture: LoggedFixture): SearchHit[] {
  return loggedHits(profileId, fixture.query);
}

// The anchors the record actually renders on one day, for one kind — the row ids
// `HistoryRows` puts in `id={timelineEntryAnchorId(row.id)}`.
function anchorsOn(
  profileId: number,
  day: string,
  kind: SearchLoggedKind
): string[] {
  return gatherHistoryLog(profileId, {
    loginId,
    limit: 200,
    day,
    kind,
  }).rows.map((row) => timelineEntryAnchorId(row.id));
}

beforeAll(() => {
  mine = newProfile("SEARCHLOG-MINE");
  other = newProfile("SEARCHLOG-OTHER");
  loginId = newLogin();
  for (const fixture of FIXTURES) {
    for (const day of DAYS) fixture.seed(mine, day);
    // The SAME matching row on the other profile, one day of its own.
    fixture.seed(other, OTHER_DAY);
  }
});

describe("the logged kinds in global search (#5006)", () => {
  it.each(FIXTURES)(
    "$kind: the five newest matching entries, newest first",
    (fixture) => {
      const found = hitsOf(mine, fixture);
      expect(found.map((h) => h.date)).toEqual(NEWEST_FIVE);
      expect(found.map((h) => h.title)).toEqual(Array(5).fill(fixture.title));
    }
  );

  it.each(FIXTURES)(
    "$kind: every href opens the day scoped to the kind, on the row itself",
    (fixture) => {
      for (const hit of hitsOf(mine, fixture)) {
        const [href, fragment] = hit.href.split("#");
        expect(href).toBe(`/history?kind=${fixture.kind}&day=${hit.date}`);
        expect(fragment).toMatch(/^timeline-entry-/);
        // THE ANCHOR AGAINST THE RENDERED ROWS, not against a re-typed id: this is the
        // half that catches a spelling drift between the hit and the row.
        expect(anchorsOn(mine, hit.date!, fixture.kind)).toContain(fragment);
      }
    }
  );

  it.each(FIXTURES)(
    "$kind: the other profile's matching row is findable from ITS profile and never from mine",
    (fixture) => {
      // The fixture CAN produce this hit — without this half, an empty result below
      // would prove nothing about scoping.
      const theirs = hitsOf(other, fixture);
      expect(theirs.map((h) => h.date)).toEqual([OTHER_DAY]);

      const ours = hitsOf(mine, fixture);
      expect(ours).not.toHaveLength(0);
      expect(ours.map((h) => h.date)).not.toContain(OTHER_DAY);
      expect(ours.map((h) => h.key)).not.toContain(theirs[0].key);
      expect(anchorsOn(mine, OTHER_DAY, fixture.kind)).toEqual([]);
    }
  );

  it("ranks a newer entry above an older exact-title one", () => {
    // Date-first inside the logged group: "latest" is the question these answer, so a
    // year-old exact "Sauna" must not sit above this week's "Sauna, infrared".
    db.prepare(
      `INSERT INTO practice_logs (profile_id, date, practice, duration_min)
       VALUES (?, '2026-08-30', 'Sauna, infrared', 25)`
    ).run(mine);
    const found = loggedHits(mine, "sauna");
    expect(found[0].title).toBe("Sauna, infrared");
    expect(found[0].date).toBe("2026-08-30");
  });

  it("shows the entries above the practice that names them, and above its list entry", () => {
    const groups = searchAll(mine, "sauna").map((g) => g.domain);
    // The catalog entity is built from these very sessions (`getPracticeSearchRows`),
    // so this query really does render both groups — which is what makes the
    // comparison below an assertion about ORDER rather than about presence.
    expect(groups).toContain("practice");
    expect(groups.indexOf("logged")).toBeLessThan(groups.indexOf("practice"));
    // "Practice history" and the rest of the jump-to-page entries are the `page`
    // domain, and it is last — an entry never sits below the list it came from.
    expect(groups.indexOf("logged")).toBeLessThan(groups.indexOf("page"));
    expect(groups.indexOf("page")).toBe(groups.length - 1);
  });

  it("finds a body reading by the value as it is STORED, and never prints a unit", () => {
    // Canonical storage is kilograms and the conversion belongs to the render
    // boundary, so the hit is matchable on 70.4 and titled with the measure alone.
    const found = loggedHits(mine, "70.4");
    expect(found[0].title).toBe("Weight");
    expect(found[0].subtitle).toBe(`Reading · ${DAYS[DAYS.length - 1]}`);
  });
});

// THE CAP IS FIVE ACROSS ALL KINDS, RANKED DATE-FIRST OVER THE UNION (owner ruling,
// 2026-09-04) — and a fixture where each kind holds five or fewer matching rows cannot
// tell that apart from five per kind, or from a round-robin over the kinds. So: three
// kinds, SIX matching rows each, on days chosen so the union's newest five are three
// practice sessions and two doses. Five-per-kind returns fifteen rows; a round-robin
// reaches the symptom whose newest row is only sixth overall and drops the third
// session. Only the ruling's answer is the one asserted below.
describe("the five-across-all-kinds cap (#5006)", () => {
  const CAP_QUERY = "birch";
  const CAP_DAYS: Record<"practice" | "dose" | "symptom", string[]> = {
    practice: [
      "2026-08-31",
      "2026-08-30",
      "2026-08-29",
      "2026-08-20",
      "2026-08-19",
      "2026-08-18",
    ],
    dose: [
      "2026-08-28",
      "2026-08-27",
      "2026-08-17",
      "2026-08-16",
      "2026-08-15",
      "2026-08-14",
    ],
    symptom: [
      "2026-08-26",
      "2026-08-25",
      "2026-08-24",
      "2026-08-23",
      "2026-08-22",
      "2026-08-21",
    ],
  };
  let capper = 0;

  beforeAll(() => {
    capper = newProfile("SEARCHLOG-CAP");
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, condition, obligation, active, source)
           VALUES (?, 'Birch tonic', 'as needed', 'may', 1, 'manual')`
        )
        .run(capper).lastInsertRowid
    );
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, '5 ml', '08:00', 'any', 0)`
        )
        .run(itemId).lastInsertRowid
    );
    for (const day of CAP_DAYS.practice) {
      db.prepare(
        `INSERT INTO practice_logs (profile_id, date, practice, duration_min)
         VALUES (?, ?, 'Birch sauna', 20)`
      ).run(capper, day);
    }
    for (const day of CAP_DAYS.dose) {
      db.prepare(
        `INSERT INTO intake_item_logs (item_id, dose_id, date, status, amount)
         VALUES (?, ?, ?, 'taken', '5 ml')`
      ).run(itemId, doseId, day);
    }
    for (const day of CAP_DAYS.symptom) {
      db.prepare(
        `INSERT INTO symptom_logs (profile_id, date, symptom, severity)
         VALUES (?, ?, 'Birch pollen', 2)`
      ).run(capper, day);
    }
  });

  // The instrument, committed rather than thrown away: every kind really does hold
  // more matching rows than the cap, so a per-kind implementation really would return
  // a different answer here. Without this, the test below could pass against a fixture
  // that never reached the state it forbids.
  it("gives each kind more matching rows than the cap", () => {
    for (const [kind, days] of Object.entries(CAP_DAYS)) {
      expect(days.length, kind).toBeGreaterThan(5);
    }
  });

  it("returns the newest five of the union, not five of each kind", () => {
    const hits = loggedHits(capper, CAP_QUERY);
    expect(hits.map((h) => h.date)).toEqual([
      ...CAP_DAYS.practice.slice(0, 3),
      ...CAP_DAYS.dose.slice(0, 2),
    ]);
    // The kind lives in the SUBTITLE, which is the only place it lives now.
    expect(hits.map((h) => h.subtitle)).toEqual([
      `Practice · ${CAP_DAYS.practice[0]}`,
      `Practice · ${CAP_DAYS.practice[1]}`,
      `Practice · ${CAP_DAYS.practice[2]}`,
      `Dose · ${CAP_DAYS.dose[0]}`,
      `Dose · ${CAP_DAYS.dose[1]}`,
    ]);
    // The symptom matches this query on six days and reaches none of them: its newest
    // is sixth overall. A round-robin would have shown it.
    expect(hits.map((h) => h.title)).not.toContain("Birch pollen");
  });

  it("is one group, so a kind's own rows never get a group of their own", () => {
    const logged = searchAll(capper, CAP_QUERY).filter(
      (g) => g.domain === "logged"
    );
    expect(logged).toHaveLength(1);
    expect(logged[0].label).toBe("Logged");
    expect(logged[0].hits).toHaveLength(5);
  });
});
