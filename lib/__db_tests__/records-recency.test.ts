// DB INTEGRATION TIER — records-recency asks (#2164 + #2176) end to end, over the
// fixtures the issues were measured on: a Takeout import that covered through a date and
// stopped, with the phone exporter still pushing everything Fitbit DOES forward; and a
// manual-upload household whose newest lab collection date is over a year old.
//
// What this file exists to pin:
//
//   • the clock reads DATA, not events — an import of an OLD archive, and a backfill of
//     OLD lab results, move nothing and answer nothing;
//   • a frontier-advancing refresh closes the ask, and a later drift re-raises it under
//     a NEW key;
//   • one ask per problem — a portal-mapped profile gets #1757's ask, never this one;
//   • no clinical base at all raises nothing (that is onboarding's territory);
//   • the reach is exactly Upcoming + the digest line its banding yields: registered
//     dedupe prefix, coaching tier, NOT on the "Needs attention" hero, and a single
//     dismissal silences the page and the digest together;
//   • the Fitbit vendor scores stay engine-inert — the ask reads their DATE, and the
//     verdict is unchanged by their VALUE.

import { describe, it, expect, beforeEach } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { collectUpcoming, dismissFinding } from "@/lib/queries";
import {
  archiveRefreshItems,
  clinicalRecencyItems,
  archiveExclusiveFrontier,
  clinicalFrontier,
  portalOwnsRecordsAsk,
} from "@/lib/queries/upcoming/records-recency";
import {
  RECORDS_RECENCY_PREFIX,
  archiveRecencySource,
  clinicalRecencyHorizonDays,
  recordsRecencyDedupeKey,
} from "@/lib/records-recency";
import { archiveRefreshFor } from "@/lib/integrations/archive-refresh";
import {
  dedupeKeyHasKnownPrefix,
  tierForDedupeKey,
} from "@/lib/rule-finding-prefixes";
import { groupUpcoming } from "@/lib/upcoming";
import { attentionCardItems } from "@/lib/attention";
import { buildUpcomingDigest } from "@/lib/notifications/upcoming-digest";
import {
  bindPortalIdentity,
  createPortal,
  createPortalAccount,
  accountsForPortal,
} from "@/lib/portals";

const TAKEOUT = "fitbit-takeout";
const HORIZON = archiveRefreshFor(TAKEOUT)!.facet.horizonDays;

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function bodyMetric(
  profileId: number,
  date: string,
  source: string,
  cols: { weight_kg?: number; body_fat_pct?: number; resting_hr?: number }
): void {
  db.prepare(
    `INSERT INTO body_metrics (profile_id, date, weight_kg, body_fat_pct, resting_hr, source)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    profileId,
    date,
    cols.weight_kg ?? null,
    cols.body_fat_pct ?? null,
    cols.resting_hr ?? null,
    source
  );
}

function metricSample(
  profileId: number,
  date: string,
  source: string,
  metric: string,
  value: number
): void {
  db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    profileId,
    source,
    metric,
    date,
    `${date}T00:00`,
    `${date}T23:59`,
    value
  );
}

function labResult(
  profileId: number,
  collectedOn: string,
  name = "Ferritin",
  value = 82
): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, value_num, unit, canonical_name)
     VALUES (?, ?, 'lab', ?, ?, ?, 'ng/mL', ?)`
  ).run(profileId, collectedOn, name, String(value), value, name);
}

// ---------------------------------------------------------------------------
// #2164 — the archive leg
// ---------------------------------------------------------------------------

interface Takeout {
  profileId: number;
  today: string;
  frontier: string;
  scoreValue: number;
}

// The measured shape: archive-exclusive streams ending `daysBehind` days ago, with the
// phone exporter still pushing everything Fitbit DOES forward, right up to today.
function takeoutProfile(
  tag: string,
  daysBehind: number,
  scoreValue = 84
): Takeout {
  const profileId = makeProfile(`Takeout ${tag}`);
  const t = today(profileId);
  const frontier = shiftDateStr(t, -daysBehind);
  bodyMetric(profileId, frontier, TAKEOUT, {
    weight_kg: 71.4,
    body_fat_pct: 19.2,
  });
  bodyMetric(profileId, shiftDateStr(frontier, -3), TAKEOUT, {
    weight_kg: 71.8,
  });
  metricSample(profileId, frontier, TAKEOUT, "fitbit_sleep_score", scoreValue);
  metricSample(profileId, frontier, TAKEOUT, "fitbit_readiness_score", 71);
  // Health Connect is CURRENT and carries none of the exclusive streams — the whole
  // reason no connection-level detector can see this gap.
  bodyMetric(profileId, t, "health-connect", { resting_hr: 52 });
  metricSample(profileId, t, "health-connect", "steps", 9120);
  return { profileId, today: t, frontier, scoreValue };
}

describe("#2164 — the archive refresh ask", () => {
  it("stays silent while the archive's own data is inside the declared horizon", () => {
    const f = takeoutProfile("fresh", HORIZON);
    expect(archiveRefreshItems(f.profileId, f.today)).toEqual([]);
  });

  it("rises one day past the horizon, keyed on the newest archive-sourced DATA date", () => {
    const f = takeoutProfile("rise", HORIZON + 1);
    const items = archiveRefreshItems(f.profileId, f.today);
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe(
      recordsRecencyDedupeKey(archiveRecencySource(TAKEOUT), f.frontier)
    );
    expect(items[0].domain).toBe("records-recency");
    expect(items[0].href).toBe("/integrations/fitbit-takeout");
    expect(items[0].detail).toContain(f.frontier);
    // Names only the streams that have actually delivered — all four here.
    expect(items[0].detail).toContain(
      "weight, body fat, sleep score and readiness score"
    );
  });

  it("names only the exclusive streams the profile actually has", () => {
    const profileId = makeProfile("Scale-less");
    const t = today(profileId);
    const frontier = shiftDateStr(t, -(HORIZON + 10));
    metricSample(profileId, frontier, TAKEOUT, "fitbit_sleep_score", 80);
    const items = archiveRefreshItems(profileId, t);
    expect(items).toHaveLength(1);
    expect(items[0].detail).toContain("sleep score reach allos only");
    expect(items[0].detail).not.toContain("weight");
  });

  it("is exempt by construction for a profile that never imported an archive", () => {
    const profileId = makeProfile("No archive");
    const t = today(profileId);
    bodyMetric(profileId, t, "health-connect", { weight_kg: 70 });
    expect(
      archiveExclusiveFrontier(profileId, TAKEOUT, [
        {
          label: "weight",
          selector: { table: "body_metrics", column: "weight_kg" },
        },
      ])
    ).toEqual({ frontier: null, labels: [] });
    expect(archiveRefreshItems(profileId, t)).toEqual([]);
  });

  it("IMPORTING AN OLD ARCHIVE does not answer it — the clock is the data, not the event", () => {
    const f = takeoutProfile("stale-import", HORIZON + 20);
    const before = archiveRefreshItems(f.profileId, f.today);
    expect(before).toHaveLength(1);

    // A fresh import run that happens to carry only rows OLDER than the frontier —
    // exactly what re-importing last spring's export looks like.
    bodyMetric(f.profileId, shiftDateStr(f.frontier, -40), TAKEOUT, {
      weight_kg: 73.1,
    });

    const after = archiveRefreshItems(f.profileId, f.today);
    expect(after).toHaveLength(1);
    // Same key: the episode is unchanged, so a dismissal filed against it still holds.
    expect(after[0].key).toBe(before[0].key);
  });

  it("closes on a frontier-ADVANCING import, and re-rises a horizon later under a new key", () => {
    const f = takeoutProfile("advance", HORIZON + 5);
    const first = archiveRefreshItems(f.profileId, f.today)[0];
    expect(first).toBeDefined();

    // A genuinely fresh export lands, covering through yesterday.
    const caughtUp = shiftDateStr(f.today, -1);
    bodyMetric(f.profileId, caughtUp, TAKEOUT, { weight_kg: 70.9 });
    expect(archiveRefreshItems(f.profileId, f.today)).toEqual([]);

    // …and the drift resumes. Asking from a later day is the same as time passing.
    const later = shiftDateStr(f.today, HORIZON + 2);
    const again = archiveRefreshItems(f.profileId, later);
    expect(again).toHaveLength(1);
    expect(again[0].key).not.toBe(first.key);
    expect(again[0].key).toBe(
      recordsRecencyDedupeKey(archiveRecencySource(TAKEOUT), caughtUp)
    );
  });

  it("keeps the Fitbit vendor scores ENGINE-INERT: the date decides, the value never does", () => {
    const low = takeoutProfile("score-low", HORIZON + 7, 12);
    const high = takeoutProfile("score-high", HORIZON + 7, 99);
    const a = archiveRefreshItems(low.profileId, low.today)[0];
    const b = archiveRefreshItems(high.profileId, high.today)[0];
    const aDetail = a.detail ?? "";
    const bDetail = b.detail ?? "";
    expect(a.title).toBe(b.title);
    expect(aDetail.replace(low.frontier, "F")).toBe(
      bDetail.replace(high.frontier, "F")
    );
    expect(aDetail).not.toContain("12");
    expect(bDetail).not.toContain("99");
  });
});

// ---------------------------------------------------------------------------
// #2176 — the manual-upload leg
// ---------------------------------------------------------------------------

interface Manual {
  profileId: number;
  today: string;
  frontier: string;
  horizon: number;
}

function manualProfile(tag: string, daysOld: number): Manual {
  const profileId = makeProfile(`Manual ${tag}`);
  const t = today(profileId);
  const horizon = clinicalRecencyHorizonDays(null);
  const frontier = shiftDateStr(t, -daysOld);
  labResult(profileId, frontier, "Ferritin", 82);
  labResult(profileId, shiftDateStr(frontier, -180), "Hemoglobin", 14.1);
  return { profileId, today: t, frontier, horizon };
}

function portalFor(profileId: number, tag: string): void {
  const portal = createPortal(`Portal ${tag}`, "mychart");
  if (!portal.ok) throw new Error("fixture portal");
  expect(createPortalAccount(portal.id, `Login${tag}`).ok).toBe(true);
  const account = accountsForPortal(portal.id).find(
    (a) => a.name === `Login${tag}`
  )!;
  expect(bindPortalIdentity(account.id, `PATIENT ${tag}`, profileId).ok).toBe(
    true
  );
}

describe("#2176 — the manual-upload records ask", () => {
  it("stays silent inside the horizon the preventive catalog implies", () => {
    const f = manualProfile("fresh", clinicalRecencyHorizonDays(null));
    expect(clinicalRecencyItems(f.profileId, f.today)).toEqual([]);
  });

  it("rises past the horizon, keyed on the newest COLLECTION date", () => {
    const f = manualProfile("stale", clinicalRecencyHorizonDays(null) + 1);
    const items = clinicalRecencyItems(f.profileId, f.today);
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe(
      recordsRecencyDedupeKey("clinical-records", f.frontier)
    );
    expect(clinicalFrontier(f.profileId)).toBe(f.frontier);
    expect(items[0].detail).toContain(f.frontier);
    // BOTH deep links (#2176): the upload flow, and the portal that retires the ask.
    expect(items[0].href).toBe("/data?section=import");
    expect(items[0].altAction?.href).toBe("/integrations/patient-portals");
  });

  it("a BACKFILL of old results does not clear it and does not move the key", () => {
    const f = manualProfile("backfill", clinicalRecencyHorizonDays(null) + 30);
    const before = clinicalRecencyItems(f.profileId, f.today)[0];

    // A shoebox of decade-old paper results, photographed this afternoon. The upload is
    // today; every collection date is older than the frontier.
    for (const back of [400, 900, 1400]) {
      labResult(f.profileId, shiftDateStr(f.frontier, -back), "Glucose", 91);
    }

    const after = clinicalRecencyItems(f.profileId, f.today);
    expect(after).toHaveLength(1);
    expect(after[0].key).toBe(before.key);
  });

  it("a LATE-UPLOADED recent result clears it", () => {
    const f = manualProfile("late", clinicalRecencyHorizonDays(null) + 30);
    expect(clinicalRecencyItems(f.profileId, f.today)).toHaveLength(1);
    // Collected six weeks ago, only photographed today.
    labResult(f.profileId, shiftDateStr(f.today, -42), "Ferritin", 90);
    expect(clinicalRecencyItems(f.profileId, f.today)).toEqual([]);
  });

  it("does not fire for a profile with no clinical base at all", () => {
    const profileId = makeProfile("Never uploaded");
    const t = today(profileId);
    expect(clinicalFrontier(profileId)).toBeNull();
    expect(clinicalRecencyItems(profileId, t)).toEqual([]);
  });

  it("yields to #1757: a portal-mapped profile gets the portal ask, never this one", () => {
    const f = manualProfile("portal", clinicalRecencyHorizonDays(null) + 60);
    expect(clinicalRecencyItems(f.profileId, f.today)).toHaveLength(1);
    portalFor(f.profileId, "Rec2176");
    expect(portalOwnsRecordsAsk(f.profileId)).toBe(true);
    expect(clinicalRecencyItems(f.profileId, f.today)).toEqual([]);
  });

  it("does not leak across profiles", () => {
    const stale = manualProfile("scopeA", clinicalRecencyHorizonDays(null) + 5);
    const other = makeProfile("Manual scopeB");
    expect(clinicalRecencyItems(other, today(other))).toEqual([]);
    expect(clinicalFrontier(other)).toBeNull();
    expect(clinicalRecencyItems(stale.profileId, stale.today)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Reach — the same ceiling for both legs
// ---------------------------------------------------------------------------

describe("reach: rows only, coaching tier, never a send", () => {
  it("registers its dedupe prefix at the coaching tier", () => {
    const f = takeoutProfile("reach", HORIZON + 3);
    const item = archiveRefreshItems(f.profileId, f.today)[0];
    expect(item.key.startsWith(RECORDS_RECENCY_PREFIX)).toBe(true);
    expect(dedupeKeyHasKnownPrefix(item.key)).toBe(true);
    expect(tierForDedupeKey(item.key)).toBe("coaching");
  });

  it("surfaces on Upcoming and as the digest's named line, and never on the hero", () => {
    const f = takeoutProfile("digest", HORIZON + 9);
    const items = collectUpcoming(f.profileId, f.today);
    const mine = items.filter((i) => i.domain === "records-recency");
    expect(mine).toHaveLength(1);

    // The hero is the one surface a user cannot choose not to look at.
    expect(
      attentionCardItems(items, f.today).some(
        (i) => i.domain === "records-recency"
      )
    ).toBe(false);

    const digest = buildUpcomingDigest("Test", groupUpcoming(items, f.today));
    const named = digest?.syncIssues.find((s) => s.title === mine[0].title);
    expect(named).toBeDefined();
    expect(named?.because).toBe(mine[0].because);
    // No deadline is invented for an ask that never expires.
    expect(named?.dueText).toBeNull();
  });

  it("one dismissal silences the page and the digest together", () => {
    const f = takeoutProfile("dismiss", HORIZON + 12);
    const before = collectUpcoming(f.profileId, f.today).filter(
      (i) => i.domain === "records-recency"
    );
    expect(before).toHaveLength(1);

    dismissFinding(f.profileId, before[0].key);

    const after = collectUpcoming(f.profileId, f.today);
    expect(after.some((i) => i.domain === "records-recency")).toBe(false);
    const digest = buildUpcomingDigest("Test", groupUpcoming(after, f.today));
    expect(
      digest?.syncIssues.some((s) => s.title === before[0].title) ?? false
    ).toBe(false);
  });

  it("a dismissal covers only THIS episode — the next frontier is a new ask", () => {
    const f = takeoutProfile("episode", HORIZON + 4);
    const first = collectUpcoming(f.profileId, f.today).filter(
      (i) => i.domain === "records-recency"
    )[0];
    dismissFinding(f.profileId, first.key);
    expect(
      collectUpcoming(f.profileId, f.today).some(
        (i) => i.domain === "records-recency"
      )
    ).toBe(false);

    // A real refresh, then a new drift.
    const caughtUp = shiftDateStr(f.today, -2);
    bodyMetric(f.profileId, caughtUp, TAKEOUT, { weight_kg: 70.2 });
    const later = shiftDateStr(f.today, HORIZON + 3);
    const again = collectUpcoming(f.profileId, later).filter(
      (i) => i.domain === "records-recency"
    );
    expect(again).toHaveLength(1);
    expect(again[0].key).not.toBe(first.key);
  });

  it("both legs can be open at once, as two independent asks", () => {
    const f = takeoutProfile("both", HORIZON + 15);
    labResult(
      f.profileId,
      shiftDateStr(f.today, -(clinicalRecencyHorizonDays(null) + 40)),
      "Ferritin",
      70
    );
    const mine = collectUpcoming(f.profileId, f.today).filter(
      (i) => i.domain === "records-recency"
    );
    expect(mine).toHaveLength(2);
    expect(new Set(mine.map((i) => i.key)).size).toBe(2);
  });
});
