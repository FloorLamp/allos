// DB INTEGRATION TIER — the tick's two redundant heavy gathers, counted (#2118, #2111).
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
  setProfileHomeAssistant,
  setTelegramBotConfig,
  setUserBirthdate,
  setUserSex,
} from "@/lib/settings";
import { utcSqlString } from "@/lib/date";
import {
  collectUpcoming,
  getMedicationFamilyStates,
  getPrnMedicationsForQuickLog,
  getPrnOverMaxItems,
  recordPreventiveDone,
} from "@/lib/queries";
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
  let n = 0;
  // Captured BEFORE the spy replaces the method, so calling through can't recurse.
  const real = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    if (signature.test(sql)) n++;
    return real(sql);
  }) as typeof db.prepare);
  return { calls: () => n };
}

const PREVENTIVE_SIGNATURE = /SELECT rule_key AS ruleKey, kind/;
const FAMILY_SIGNATURE =
  /SELECT id, name, rxcui, rxcui_ingredients, max_daily_count/;

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
  setUserBirthdate(p, "1980-01-01");
  setUserSex(p, "male");
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
