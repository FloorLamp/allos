// DB INTEGRATION TIER — the tick's redundant heavy gathers, counted (#2118, #2111,
// #2249, #2283).
//
// `lib/request-cache.ts` degrades React's `cache()` to identity outside a Next request,
// so the hourly tick had no memoization anywhere and re-ran the same profile's heaviest
// reads several times per tick: the preventive assessment from the nudge planner, from
// the digest's `collectUpcoming`, and AGAIN inside the reconcile sweep for every live
// preventive-carrying pointer; the medication-family safety state from the redose
// notice, from the digest's over-max finding, and from the quick-log gather.
//
// A comment cannot prove a memo, and an output assertion cannot see repetition, so what
// is pinned here is the WORK ITSELF: every one of those gathers issues a statement with
// a signature only it has, and this file counts those statements across a realistic
// multi-call tick with and without a tick scope open. The pre-fix counts (5 and 3) are
// asserted as a floor on the unscoped run, so the test fails if the redundancy is
// reintroduced AND fails if the memo silently stops applying.
//
// #2249 adds the third: the Dynamic digest tick's 30-night sleep-ARRIVAL join, which
// one tick ran TWICE for the same profile — once for the deadline, once for the
// evidence line the decision writes — and which every pre-floor tick paid for before
// `planDigestTick` could decline. Both halves are counted here: one gather on a
// re-check tick, and ZERO on a tick that short-circuits before the floor.
//
// #2283 adds the pair the SEND tick repeats. The digest asks its questions twice by
// construction — a decide phase and, on the tick that resolves to "send", a build
// phase — and two of their shared inputs were real gathers with nothing bridging the
// phases: the session list behind "has last night landed?" and the broken-provider
// list behind `providerHealthy`. Counted on the ordinary morning send.
//
// Behaviour preservation is asserted alongside every count: the scoped run's answers
// must equal the unscoped run's, item for item. And because a memo over a SAFETY
// counter is only as safe as its lifetime, the last block pins the lifetime: a scope
// closes with its profile (a throw included), and the next scope re-reads the ledger.
//
// Every value is synthetic — fake meds, a fake HA webhook URL, a fake bot token.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

vi.mock("@/lib/notifications/telegram-api", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/notifications/telegram-api")>();
  return {
    ...actual,
    answerCallbackQuery: vi.fn(async () => {}),
    editMessageTextRaw: vi.fn(async () => {}),
    editMessageReplyMarkupRaw: vi.fn(async () => {}),
    sendMessageRaw: vi.fn(async () => 4242),
  };
});

import { db, today } from "@/lib/db";
import {
  getNotifySchedule,
  setProfileHomeAssistant,
  setProfileSetting,
  setTelegramBotConfig,
  setTimezone,
  setProfileBirthdate,
  setProfileSex,
} from "@/lib/settings";
import { DIGEST_MODE_KEY } from "@/lib/settings/notifications";
import { shiftDateStr, utcInstant, utcSqlString } from "@/lib/date";
import {
  collectUpcoming,
  getMedicationFamilyStates,
  getPrnMedicationsForQuickLog,
  getPrnOverMaxItems,
  recordPreventiveDone,
} from "@/lib/queries";
import { getSleepArrivals, getSleepSessions } from "@/lib/queries/metrics";
import { getIntegrationAttention } from "@/lib/queries/integrations";
import { now as clockNow } from "@/lib/clock";
import {
  gatherDigestInput,
  planProfileDigestTick,
} from "@/lib/notifications/digest-data";
import type { DigestInput } from "@/lib/notifications/digest";
import type { DigestTickAction } from "@/lib/notifications/digest-schedule";
import { assessProfilePreventive } from "@/lib/queries/upcoming/preventive";
import { runPreventive } from "@/lib/notifications/preventive";
import { runRedoseNotices } from "@/lib/notifications/redose";
import { reconcileProfileMessages } from "@/lib/notifications/reconcile";
import { recordMessagePointer } from "@/lib/notifications/message-pointers";
import { runInTickScope, inTickScope } from "@/lib/tick-cache";

const HA_URL = "http://homeassistant.local:8123/api/webhook/allos-tick-scope";

// ── statement counting ───────────────────────────────────────────────────────
//
// Each gather prepares its statements inline on every call (there is no prepared-
// statement cache in the query layer), so counting prepares of a signature counts
// evaluations of the gather that owns it.
//
// The signatures are chosen to be unique to the gather under test:
//   • the override SELECT — issued only by getPreventiveOverrides, whose only caller
//     is assessProfilePreventive.
//   • the family-member projection — issued only by getActiveMedicationFamilies, at
//     the head of getMedicationFamilyStates.
function countPrepares(signature: RegExp): { calls: () => number } {
  const [counter] = countPrepareSet(signature);
  return counter;
}

// Several signatures, ONE spy. `vi.spyOn` returns the SAME spy for a method that is
// already spied, so two independent countPrepares calls would leave the second
// binding its call-through to the spy itself and recursing until the stack ends. A
// tick that repeats two different gathers has to count both at once anyway.
function countPrepareSet(...signatures: RegExp[]): { calls: () => number }[] {
  const counts = signatures.map(() => 0);
  // Captured BEFORE the spy replaces the method, so calling through can't recurse.
  const real = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    signatures.forEach((s, i) => {
      if (s.test(sql)) counts[i]++;
    });
    return real(sql);
  }) as typeof db.prepare);
  return signatures.map((_, i) => ({ calls: () => counts[i] }));
}

const PREVENTIVE_SIGNATURE = /SELECT rule_key AS ruleKey, kind/;
const FAMILY_SIGNATURE =
  /SELECT id, name, rxcui, rxcui_ingredients, max_daily_count/;
//   • the arrival join — issued only by getSleepArrivals (#2249), whose callers in a
//     tick are the Dynamic deadline and the decision's own evidence line.
const ARRIVAL_SIGNATURE =
  /SELECT ms\.end_time AS endTime, MIN\(r\.created_at\)/;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function configureHA(profileId: number): void {
  setProfileHomeAssistant(profileId, {
    enabled: true,
    webhookUrl: HA_URL,
    secret: "",
    disabledKinds: [],
  });
}

function stubFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

// ── the preventive fixture ───────────────────────────────────────────────────
//
// A ~46-year-old male whose recorded preventive history lapsed in 2012, so the
// assessor emits genuinely overdue items (a profile with NOTHING on record is in the
// never-recorded `setup` state, which is outside `actionable` and never nudges).
// Plus three live Telegram pointers carrying preventive keyboards — the per-pointer
// multiplier #2118 measured, which is the part that grows with a chatty household.
const PREVENTIVE_RULES = [
  "adult_physical",
  "blood_pressure",
  "lipid_screening",
];

function seedPreventiveProfile(name: string): number {
  const p = newProfile(name);
  setProfileBirthdate(p, "1980-01-01");
  setProfileSex(p, "male");
  for (const rule of PREVENTIVE_RULES)
    recordPreventiveDone(p, rule, "2012-03-05");
  setTelegramBotConfig({
    telegramBotToken: "tick-scope-test-token",
    telegramMode: "poll",
  });
  configureHA(p);
  let messageId = 8100;
  for (const rule of PREVENTIVE_RULES) {
    recordMessagePointer({
      profileId: p,
      chatId: "555010",
      messageId: messageId++,
      kind: `preventive-${rule}`,
      date: today(p),
      keyboard: [
        [
          { text: "Done", callback_data: `pvdone:${p}:${rule}` },
          { text: "Not for me", callback_data: `pvna:${p}:${rule}` },
        ],
      ],
    });
  }
  return p;
}

// One profile's tick, as far as the preventive assessment is concerned: the nudge
// planner, the digest's aggregation, and the live-message sweep.
async function preventiveTickCalls(profileId: number): Promise<string[]> {
  const date = today(profileId);
  await runPreventive(profileId, "TickScope", date);
  // A preventive assessment reaches Upcoming as a `visit` or a `screening` row, each
  // keyed by its catalog rule (lib/preventive-upcoming).
  const upcoming = collectUpcoming(profileId, date)
    .filter((u) => u.domain === "visit" || u.domain === "screening")
    .map((u) => u.key);
  await reconcileProfileMessages(profileId);
  return upcoming.sort();
}

describe("assessProfilePreventive is evaluated ONCE per profile per tick (#2118)", () => {
  beforeEach(() => {
    stubFetch();
  });

  it("unscoped: the planner, the digest and EVERY live pointer each pay for it", async () => {
    const p = seedPreventiveProfile("TickPrevBaseline");
    const counter = countPrepares(PREVENTIVE_SIGNATURE);
    await preventiveTickCalls(p);
    // planner (1) + digest (1) + one per preventive-carrying pointer (3).
    expect(counter.calls()).toBeGreaterThanOrEqual(5);
  });

  it("scoped: the same tick evaluates it exactly once", async () => {
    const p = seedPreventiveProfile("TickPrevScoped");
    const counter = countPrepares(PREVENTIVE_SIGNATURE);
    await runInTickScope(() => preventiveTickCalls(p));
    expect(counter.calls()).toBe(1);
  });

  it("the scoped tick reaches the SAME verdicts as the unscoped one", async () => {
    // Two identically-seeded profiles rather than two runs of one profile: the first
    // run writes per-rule send markers and edits pointers, so only a fresh subject
    // compares like with like.
    const bare = seedPreventiveProfile("TickPrevCompareA");
    const scoped = seedPreventiveProfile("TickPrevCompareB");

    const bareKeys = await preventiveTickCalls(bare);
    const scopedKeys = await runInTickScope(() => preventiveTickCalls(scoped));
    // The Upcoming keys carry their profile id nowhere, so they compare directly.
    expect(scopedKeys).toEqual(bareKeys);
    expect(scopedKeys.length).toBeGreaterThan(0);

    // And the assessment itself is value-identical inside and outside a scope.
    const outside = assessProfilePreventive(scoped, today(scoped));
    const inside = await runInTickScope(async () =>
      assessProfilePreventive(scoped, today(scoped))
    );
    expect(inside.actionable.map((a) => a.key)).toEqual(
      outside.actionable.map((a) => a.key)
    );
  });

  it("a memo is per (profile, day): two profiles in one scope are two evaluations", async () => {
    const a = seedPreventiveProfile("TickPrevKeyA");
    const b = seedPreventiveProfile("TickPrevKeyB");
    const counter = countPrepares(PREVENTIVE_SIGNATURE);
    await runInTickScope(async () => {
      assessProfilePreventive(a, today(a));
      assessProfilePreventive(a, today(a));
      assessProfilePreventive(b, today(b));
      // A different day is a different question, memoized separately.
      assessProfilePreventive(a, "2020-01-01");
    });
    expect(counter.calls()).toBe(3);
  });
});

// ── the medication-family fixture ────────────────────────────────────────────
//
// The #1027 two-ibuprofen family: OTC ibuprofen (confirmed 6h interval / max 4, redose
// notice opted in) plus Rx ibuprofen 800 mg, with one administration an hour ago. That
// one administration is what makes the redose notice reach the gather at all.
function seedMed(
  profileId: number,
  name: string,
  opts: {
    amount?: string;
    redoseNotice?: number;
    minInterval?: number | null;
    maxDaily?: number | null;
  } = {}
): { itemId: number; doseId: number } {
  const {
    amount = "200 mg",
    redoseNotice = 0,
    minInterval = null,
    maxDaily = null,
  } = opts;
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, redose_notice,
            min_interval_hours, max_daily_count)
         VALUES (?, ?, 1, 'medication', 'daily', 'may', ?, ?, ?)`
      )
      .run(profileId, name, redoseNotice, minInterval, maxDaily).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, ?, 'anytime', 'any', 0)`
      )
      .run(itemId, amount).lastInsertRowid
  );
  return { itemId, doseId };
}

function logAdministration(
  itemId: number,
  doseId: number,
  date: string,
  hoursAgo: number,
  amount: string
): void {
  const recordedAt = utcSqlString(new Date(Date.now() - hoursAgo * 3_600_000));
  db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, recorded_at, status, amount)
     VALUES (?, ?, ?, ?, 'taken', ?)`
  ).run(doseId, itemId, date, recordedAt, amount);
}

function seedFamilyProfile(name: string): {
  profileId: number;
  otcItemId: number;
} {
  const p = newProfile(name);
  configureHA(p);
  const otc = seedMed(p, "Ibuprofen", {
    amount: "200 mg",
    redoseNotice: 1,
    minInterval: 6,
    maxDaily: 4,
  });
  const rx = seedMed(p, "Ibuprofen 800 mg", { amount: "800 mg" });
  const date = today(p);
  logAdministration(otc.itemId, otc.doseId, date, 1, "200 mg");
  logAdministration(rx.itemId, rx.doseId, date, 3, "800 mg");
  return { profileId: p, otcItemId: otc.itemId };
}

// The three call sites that reach the family gather in one tick: the redose notice,
// the digest's over-max finding (through collectUpcoming), and the quick-log gather.
async function familyTickCalls(profileId: number): Promise<{
  overMax: number;
  quickLogCount: number | null;
  itemId: number;
}> {
  const date = today(profileId);
  await runRedoseNotices(profileId, "TickScope", date);
  const overMax = getPrnOverMaxItems(profileId, date).length;
  const quick = getPrnMedicationsForQuickLog(profileId);
  const ibuprofen = quick.find((q) => q.name === "Ibuprofen");
  return {
    overMax,
    quickLogCount: ibuprofen?.familyCount ?? null,
    itemId: ibuprofen?.id ?? -1,
  };
}

describe("getMedicationFamilyStates is evaluated ONCE per profile per tick (#2111)", () => {
  beforeEach(() => {
    stubFetch();
  });

  it("unscoped: the redose notice, the digest and the quick-log gather each pay for it", async () => {
    const { profileId } = seedFamilyProfile("TickFamBaseline");
    const counter = countPrepares(FAMILY_SIGNATURE);
    await familyTickCalls(profileId);
    expect(counter.calls()).toBeGreaterThanOrEqual(3);
  });

  it("scoped: the same tick evaluates it exactly once", async () => {
    const { profileId } = seedFamilyProfile("TickFamScoped");
    const counter = countPrepares(FAMILY_SIGNATURE);
    await runInTickScope(() => familyTickCalls(profileId));
    expect(counter.calls()).toBe(1);
  });

  it("the scoped tick reaches the SAME family counters as the unscoped one", async () => {
    const bare = seedFamilyProfile("TickFamCompareA");
    const scoped = seedFamilyProfile("TickFamCompareB");
    const bareOut = await familyTickCalls(bare.profileId);
    const scopedOut = await runInTickScope(() =>
      familyTickCalls(scoped.profileId)
    );
    expect(scopedOut.overMax).toBe(bareOut.overMax);
    // The family spans both ibuprofen items, so the count is 2 either way.
    expect(scopedOut.quickLogCount).toBe(bareOut.quickLogCount);
    expect(scopedOut.quickLogCount).toBe(2);
  });
});

// ── the sleep-arrival fixture (#2249) ────────────────────────────────────────
//
// A Dynamic 07:00 digest whose profile is still sleep-tracking but has NOT yet
// received last night: 13 measurable nights waking on each of the previous 13 days
// and nothing waking today. That is exactly the state the re-check window exists for
// — `digestSleepPendingTrace` answers `pending`, so the plan reaches the window, the
// deadline decides how long it may stay there, and the decision writes its evidence
// line. Two arrival reads, one tick, one profile.
const ARRIVAL_TZ = "UTC";
const ARRIVAL_PROVIDER = "health-connect";
const ARRIVAL_FLOOR = 7 * 60;
const ARRIVAL_NIGHTS = 13;

function seedArrivalNight(
  profileId: number,
  wakeDay: string,
  wakeMinute: number,
  lagMin: number
): void {
  const end = new Date(
    `${wakeDay}T${String(Math.floor(wakeMinute / 60)).padStart(2, "0")}:${String(
      wakeMinute % 60
    ).padStart(2, "0")}:00Z`
  );
  const start = new Date(end.getTime() - 420 * 60_000);
  const arrived = new Date(end.getTime() + lagMin * 60_000);
  const sampleId = Number(
    db
      .prepare(
        `INSERT INTO metric_samples
           (profile_id, source, origin, metric, date, start_time, end_time, value)
         VALUES (?, ?, NULL, 'sleep_min', ?, ?, ?, 420)`
      )
      .run(
        profileId,
        ARRIVAL_PROVIDER,
        wakeDay,
        utcInstant(start),
        utcInstant(end)
      ).lastInsertRowid
  );
  const eventId = Number(
    db
      .prepare(
        `INSERT INTO integration_sync_events (profile_id, provider, at, ok, inserted)
         VALUES (?, ?, ?, 1, 1)`
      )
      .run(profileId, ARRIVAL_PROVIDER, utcInstant(arrived)).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO integration_sync_rows
       (event_id, target_table, target_id, disposition, created_at)
     VALUES (?, 'metric_samples', ?, 'inserted', ?)`
  ).run(eventId, sampleId, utcInstant(arrived));
}

function seedArrivalProfile(name: string): number {
  const p = newProfile(name);
  setTimezone(p, ARRIVAL_TZ);
  const td = today(p);
  for (let back = 1; back <= ARRIVAL_NIGHTS; back++) {
    // Wake times walk a few minutes so the sample is a distribution rather than a
    // single repeated clock reading; the lag is what the statistic measures.
    seedArrivalNight(
      p,
      shiftDateStr(td, -back),
      6 * 60 + 30 + (back % 5) * 3,
      30 + (back % 7) * 5
    );
  }
  setProfileSetting(p, "notify_digest_hour", "07:00");
  setProfileSetting(p, DIGEST_MODE_KEY, "dynamic");
  return p;
}

/** One profile's digest decision for this tick, exactly as scripts/notify.ts asks it. */
function digestTickAt(profileId: number, currentMinute: number) {
  return planProfileDigestTick(
    profileId,
    getNotifySchedule(profileId),
    currentMinute,
    15,
    today(profileId)
  );
}

describe("the Dynamic digest tick gathers sleep arrivals ONCE, and not before the floor (#2249)", () => {
  it("unscoped: a re-check tick pays for the deadline AND the evidence line", () => {
    const p = seedArrivalProfile("TickArrivalBaseline");
    const counter = countPrepares(ARRIVAL_SIGNATURE);
    // 07:15 — at or past the floor, before the deadline, no failed attempt on record.
    expect(digestTickAt(p, ARRIVAL_FLOOR + 15)).toBe("wait");
    expect(counter.calls()).toBeGreaterThanOrEqual(2);
  });

  it("scoped: the same tick gathers exactly once", async () => {
    const p = seedArrivalProfile("TickArrivalScoped");
    const counter = countPrepares(ARRIVAL_SIGNATURE);
    const action = await runInTickScope(async () =>
      digestTickAt(p, ARRIVAL_FLOOR + 15)
    );
    // The DECISION is untouched — this issue changes only when and how often the
    // inputs are computed.
    expect(action).toBe("wait");
    expect(counter.calls()).toBe(1);
  });

  it("a tick before the floor gathers NOTHING, scope or no scope", () => {
    // The lazy half. At a 15-minute cadence and an 07:00 floor this is ~28 ticks a
    // day that used to pay for a 30-night join to reach a decision that never
    // consults it.
    const p = seedArrivalProfile("TickArrivalPreFloor");
    const counter = countPrepares(ARRIVAL_SIGNATURE);
    for (let now = 0; now < ARRIVAL_FLOOR; now += 15)
      expect(digestTickAt(p, now)).toBe("idle");
    expect(counter.calls()).toBe(0);
  });

  it("a STATIC profile never gathers, at any minute of the day", () => {
    const p = seedArrivalProfile("TickArrivalStatic");
    setProfileSetting(p, DIGEST_MODE_KEY, "static");
    const counter = countPrepares(ARRIVAL_SIGNATURE);
    for (let now = 0; now < 1440; now += 15) digestTickAt(p, now);
    expect(counter.calls()).toBe(0);
  });

  it("the memo is per (profile, night limit), and dies with the scope", async () => {
    const a = seedArrivalProfile("TickArrivalKeyA");
    const b = seedArrivalProfile("TickArrivalKeyB");
    const counter = countPrepares(ARRIVAL_SIGNATURE);
    await runInTickScope(async () => {
      getSleepArrivals(a);
      getSleepArrivals(a);
      getSleepArrivals(b);
      // A different window is a different question, memoized separately.
      getSleepArrivals(a, 7);
    });
    expect(counter.calls()).toBe(3);
    // The next scope re-reads: a memo whose lifetime is a scope cannot outlive it.
    await runInTickScope(async () => getSleepArrivals(a));
    expect(counter.calls()).toBe(4);
  });
});

// ── the send-triggering digest tick (#2283) ──────────────────────────────────
//
// The digest asks its questions TWICE by construction: a DECIDE phase
// (`planProfileDigestTick` → `digestSleepPendingTrace` → `logDigestTick`) and, on the
// tick that resolves to "send", a BUILD phase (`gatherDigestInput`). Two of the inputs
// they share are real gathers — the session list behind "has last night landed?" and
// the broken-provider list behind `providerHealthy` — and nothing bridged the phases.
//
// The fixture is the ORDINARY send: a Dynamic 07:00 digest whose last night HAS
// landed, past the floor, before the deadline, with no failed attempt on record. That
// is the tick scripts/notify.ts:820-823 runs every morning.
const SEND_FLOOR = 7 * 60;
const SEND_TZ = "UTC";
const SEND_SLEEP_SOURCE = "oura";
// Weather is the broken provider because its silence tolerance is a plain declared
// number of hours (12 polls × its hourly cadence), so "no success inside it" is a
// fixture the clock cannot make flaky.
const SEND_BROKEN_PROVIDER = "weather";
const SEND_TOLERANCE_HOURS = 12;
const SEND_SYNC_ERROR = "weather fetch failed (503)";

//   • the sleep-session window scan — issued by readSleepSessions ONLY on the
//     row-capped path, i.e. only by getSleepSessions (#2283). The since/range readers
//     pass a cutoff and skip it, so this counts the one reader under test.
const SLEEP_SESSION_SIGNATURE =
  /SELECT date FROM metric_samples\s+WHERE profile_id = \? AND metric = 'sleep_min'/;
//   • the DISTINCT-provider scan at the head of getLatestSyncEventPerProvider, whose
//     only caller is getImportIssues — which inside a tick is reached only through
//     getIntegrationAttention (#2283). Anchored past the profile predicate so it
//     cannot also match the recent-changes digest's own DISTINCT-provider read, which
//     asks a different question (`AND ok = 1 AND at <= ?`) of the same table.
const INTEGRATION_ATTENTION_SIGNATURE =
  /SELECT DISTINCT provider AS source_id FROM integration_sync_events\s+WHERE profile_id = \?\s*$/;

function seedSendNight(
  profileId: number,
  wakeDay: string,
  wakeMinute: number
): void {
  const end = new Date(
    `${wakeDay}T${String(Math.floor(wakeMinute / 60)).padStart(2, "0")}:${String(
      wakeMinute % 60
    ).padStart(2, "0")}:00Z`
  );
  const start = new Date(end.getTime() - 420 * 60_000);
  db.prepare(
    `INSERT INTO metric_samples
       (profile_id, source, origin, metric, date, start_time, end_time, value)
     VALUES (?, ?, NULL, 'sleep_min', ?, ?, ?, 420)`
  ).run(
    profileId,
    SEND_SLEEP_SOURCE,
    wakeDay,
    utcInstant(start),
    utcInstant(end)
  );
}

function seedSendProfile(name: string): number {
  const p = newProfile(name);
  setTimezone(p, SEND_TZ);
  const td = today(p);
  // `back = 0` is the night that woke TODAY — the whole difference from the #2249
  // fixture above, and what turns the re-check window's answer from "wait" into
  // "send". No provenance rows: with no measurable arrivals the deadline falls back
  // to floor + 60, so the tick under test sits inside the re-check window by
  // construction rather than by whatever the arrival sample happens to say.
  for (let back = 0; back <= 13; back++)
    seedSendNight(p, shiftDateStr(td, -back), 6 * 60 + 30 + (back % 5) * 3);
  setProfileSetting(p, "notify_digest_hour", "07:00");
  setProfileSetting(p, DIGEST_MODE_KEY, "dynamic");

  // A provider that has genuinely stopped: connected, a recorded failure, and no
  // success inside its tolerance — the one shape that escalates onto the attention
  // list both phases read.
  db.prepare(
    `INSERT INTO integration_connections (profile_id, provider, status)
     VALUES (?, ?, 'connected')`
  ).run(p, SEND_BROKEN_PROVIDER);
  const at = (hoursAgo: number) =>
    utcInstant(new Date(clockNow().getTime() - hoursAgo * 3600_000));
  db.prepare(
    `INSERT INTO integration_sync_events
       (profile_id, provider, at, ok, inserted, error)
     VALUES (?, ?, ?, 1, 1, NULL)`
  ).run(p, SEND_BROKEN_PROVIDER, at(SEND_TOLERANCE_HOURS + 1));
  db.prepare(
    `INSERT INTO integration_sync_events
       (profile_id, provider, at, ok, inserted, error)
     VALUES (?, ?, ?, 0, NULL, ?)`
  ).run(p, SEND_BROKEN_PROVIDER, at(1), SEND_SYNC_ERROR);
  return p;
}

/** Both phases of one profile's digest tick, in the order scripts/notify.ts runs them. */
function digestSendTick(profileId: number): {
  action: DigestTickAction;
  input: DigestInput | null;
} {
  const action = planProfileDigestTick(
    profileId,
    getNotifySchedule(profileId),
    SEND_FLOOR + 15,
    15,
    today(profileId)
  );
  return {
    action,
    input:
      action === "send"
        ? gatherDigestInput(profileId, "Digest Send Tick")
        : null,
  };
}

describe("a send-triggering digest tick gathers sleep sessions and integration attention ONCE (#2283)", () => {
  it("unscoped: decide and build each pay for both gathers", () => {
    const p = seedSendProfile("TickSendBaseline");
    const [sleep, attention] = countPrepareSet(
      SLEEP_SESSION_SIGNATURE,
      INTEGRATION_ATTENTION_SIGNATURE
    );
    const { action, input } = digestSendTick(p);

    expect(action).toBe("send");
    // The answers the two gathers produced, so the scoped run below has something to
    // be identical to rather than merely cheaper than.
    expect(input?.sleep?.lastNightMin).toBe(420);
    expect(input?.todayGroups.flatMap((g) => g.items)).toContainEqual(
      expect.objectContaining({ domain: "integration" })
    );
    // Floors, in the house style: the counts observed on this fixture are 10 and 2.
    // The attention list is exactly the decide/build pair the issue names; the session
    // list is asked far more often than twice, because the build phase alone reaches it
    // through the sleep signal, the Sleep section, the SRI and the derived-situation
    // resolver. Either number rising is fine; either falling below the pair means the
    // gather stopped being asked at all.
    expect(sleep.calls()).toBeGreaterThanOrEqual(2);
    expect(attention.calls()).toBeGreaterThanOrEqual(2);
  });

  it("scoped: the same tick gathers each exactly once, for the same answers", async () => {
    const p = seedSendProfile("TickSendScoped");
    const [sleep, attention] = countPrepareSet(
      SLEEP_SESSION_SIGNATURE,
      INTEGRATION_ATTENTION_SIGNATURE
    );
    const { action, input } = await runInTickScope(async () =>
      digestSendTick(p)
    );

    // The MESSAGE is untouched — this issue changes only how often its inputs are
    // computed.
    expect(action).toBe("send");
    expect(input?.sleep?.lastNightMin).toBe(420);
    expect(input?.todayGroups.flatMap((g) => g.items)).toContainEqual(
      expect.objectContaining({ domain: "integration" })
    );
    expect(sleep.calls()).toBe(1);
    expect(attention.calls()).toBe(1);
  });

  it("each memo is per profile and dies with the scope", async () => {
    const a = seedSendProfile("TickSendKeyA");
    const b = seedSendProfile("TickSendKeyB");
    const [sleep, attention] = countPrepareSet(
      SLEEP_SESSION_SIGNATURE,
      INTEGRATION_ATTENTION_SIGNATURE
    );
    await runInTickScope(async () => {
      getSleepSessions(a);
      getSleepSessions(a);
      getSleepSessions(b);
      // A different row cap is a different question, memoized separately.
      getSleepSessions(a, 7);
      getIntegrationAttention(a);
      getIntegrationAttention(a);
      getIntegrationAttention(b);
    });
    expect(sleep.calls()).toBe(3);
    expect(attention.calls()).toBe(2);

    // The next scope re-reads both: a memo whose lifetime is a scope cannot outlive
    // it, which is what lets the tick's own pull pass write these rows before the
    // scope's first read and still be seen.
    await runInTickScope(async () => {
      getSleepSessions(a);
      getIntegrationAttention(a);
    });
    expect(sleep.calls()).toBe(4);
    expect(attention.calls()).toBe(3);
  });
});

// ── the lifetime, which is the whole safety argument ─────────────────────────
describe("a tick scope's memo cannot outlive its tick", () => {
  it("a NEW scope re-reads the ledger a previous scope had memoized", async () => {
    const { profileId, otcItemId } = seedFamilyProfile("TickFamLifetime");
    const date = today(profileId);
    const first = await runInTickScope(async () =>
      getMedicationFamilyStates(profileId, date).get(otcItemId)
    );
    expect(first?.countToday).toBe(2);

    // A dose confirmed between ticks — the write that must never be missed.
    const dose = db
      .prepare("SELECT id FROM intake_item_doses WHERE item_id = ? LIMIT 1")
      .get(otcItemId) as { id: number };
    logAdministration(otcItemId, dose.id, date, 0, "200 mg");

    const second = await runInTickScope(async () =>
      getMedicationFamilyStates(profileId, date).get(otcItemId)
    );
    expect(second?.countToday).toBe(3);
    // And with no scope at all, every read is fresh.
    expect(
      getMedicationFamilyStates(profileId, date).get(otcItemId)?.countToday
    ).toBe(3);
  });

  it("WITHIN one scope the snapshot is stable — which is why the tick may not write these inputs", async () => {
    // The honest statement of the bound: a memo IS a snapshot, so a write inside the
    // scope is invisible to it. That is safe only because `tick()` performs no such
    // write — dose confirms and preventive overrides arrive through Server Actions and
    // Telegram taps, which run in the web request or the sidecar's separate `poll`
    // mode, never inside the scope scripts/notify.ts opens. This test states the rule
    // it depends on, so a future tick step that DOES write one of these inputs fails
    // here instead of silently reading its own stale snapshot.
    const { profileId, otcItemId } = seedFamilyProfile("TickFamSnapshot");
    const date = today(profileId);
    const dose = db
      .prepare("SELECT id FROM intake_item_doses WHERE item_id = ? LIMIT 1")
      .get(otcItemId) as { id: number };

    await runInTickScope(async () => {
      expect(
        getMedicationFamilyStates(profileId, date).get(otcItemId)?.countToday
      ).toBe(2);
      logAdministration(otcItemId, dose.id, date, 0, "200 mg");
      expect(
        getMedicationFamilyStates(profileId, date).get(otcItemId)?.countToday
      ).toBe(2);
    });
    // The moment the scope closes, the write is visible again.
    expect(
      getMedicationFamilyStates(profileId, date).get(otcItemId)?.countToday
    ).toBe(3);
  });

  it("a profile tick that THROWS still closes its scope", async () => {
    expect(inTickScope()).toBe(false);
    await expect(
      runInTickScope(async () => {
        expect(inTickScope()).toBe(true);
        throw new Error("profile tick failed");
      })
    ).rejects.toThrow("profile tick failed");
    expect(inTickScope()).toBe(false);
  });
});
