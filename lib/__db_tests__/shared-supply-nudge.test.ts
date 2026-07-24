// DB INTEGRATION TIER — the shared-supply-pool low-stock NUDGE (#1374). The load-
// bearing claim of the whole feature is "one bottle must never produce N
// notifications", and that is only observable end to end: the gather spans profiles,
// the episode marker is global, the fan-out resolves managing logins, and the
// suppression bus is per-profile. The pure tier sees none of it.
//
// SEAM: the same one lib/__db_tests__/notify-orchestrators.test.ts uses — configure a
// REAL Telegram channel and stub global fetch, so the real isConfigured gate, the real
// chokepoint, and the real dispatch marker fold all run. Every value is synthetic
// (fictional names, fake chat ids in the reserved 5550xxx range, a fake bot token).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import { setTelegramBotConfig, setLoginTelegram } from "@/lib/settings";
import {
  createSharedSupply,
  linkItemToPool,
  dismissFinding,
} from "@/lib/queries";
import {
  runPoolRefills,
  poolRefillMarker,
} from "@/lib/notifications/supply-pool";
import { poolRefillSignalKey } from "@/lib/refill-nudge";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}
function newLogin(username: string): number {
  return Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES (?, 'x', 'member')"
      )
      .run(username).lastInsertRowid
  );
}
function grant(loginId: number, profileId: number): void {
  db.prepare(
    `INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')
     ON CONFLICT(login_id, profile_id) DO NOTHING`
  ).run(loginId, profileId);
}
// A daily scheduled item consuming one unit a day, linked to `supplyId`.
function linkedItem(profileId: number, name: string, supplyId: number): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, priority, quantity_on_hand, qty_per_dose)
         VALUES (?, ?, 1, 'medication', 'daily', 'high', NULL, 1)`
      )
      .run(profileId, name).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 tablet', 'morning', 'any', 0)`
  ).run(itemId);
  linkItemToPool(profileId, itemId, supplyId);
  return itemId;
}

// Telegram sends only; the HA/push channels stay unconfigured so they never join.
function stubFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () =>
    Response.json({ ok: true, result: { message_id: 1 } })
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}
function telegramSends(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.includes("api.telegram.org") && u.includes("sendMessage"));
}

const alwaysWaking = (): boolean => true;

let unique = 0;
function tag(): string {
  return `sp${++unique}`;
}

beforeEach(() => {
  setTelegramBotConfig({
    telegramBotToken: "test-bot-token",
    telegramMode: "webhook",
  });
  // runPoolRefills is GLOBAL by design (one pass per tick over every pool), so this
  // file owns the whole shared_supplies table: reset it between tests so each case
  // observes exactly its own bottle. The e2e-hygiene lesson one tier down — never
  // count-assert against rows a neighbour seeded.
  db.prepare("UPDATE intake_items SET supply_id = NULL").run();
  db.prepare("DELETE FROM shared_supplies").run();
  db.prepare(
    "DELETE FROM settings WHERE key LIKE 'notify_last_pool_refill_%'"
  ).run();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("one bottle, one notification", () => {
  it("sends ONCE for a pool two profiles share under one caregiver login", () => {
    const t = tag();
    const parent = newProfile(`Ada Lovelace ${t}`);
    const child = newProfile(`Test Patient ${t}`);
    const login = newLogin(`caregiver_${t}`);
    grant(login, parent);
    grant(login, child);
    setLoginTelegram(login, {
      telegramEnabled: true,
      telegramChatId: `55501${t}`,
    });

    // 6 units, two daily consumers at 1 unit/day → 3 days left, under the default 10.
    const supplyId = createSharedSupply(
      {
        name: `Shared Ibuprofen ${t}`,
        strength: "200 mg",
        form: "tablet",
        lowSupplyDays: null,
        notes: null,
      },
      6
    );
    linkedItem(parent, `Ibuprofen ${t} A`, supplyId);
    linkedItem(child, `Ibuprofen ${t} B`, supplyId);

    const mock = stubFetch();
    return runPoolRefills((p) => today(p), alwaysWaking).then(async (res) => {
      expect(res.failed).toBe(false);
      // ONE message for ONE bottle — not one per linked member.
      expect(telegramSends(mock)).toHaveLength(1);
      // Episode marker is keyed on the POOL and lives in the global tier.
      expect(poolRefillMarker(supplyId)).toBeTruthy();

      // A second tick inside the same episode is silent.
      mock.mockClear();
      await runPoolRefills((p) => today(p), alwaysWaking);
      expect(telegramSends(mock)).toHaveLength(0);
    });
  });

  it("reaches a SPLIT caregiver set once each, never twice for the same login", async () => {
    const t = tag();
    const kidA = newProfile(`Test Patient ${t}A`);
    const kidB = newProfile(`Test Patient ${t}B`);
    const momLogin = newLogin(`mom_${t}`);
    const dadLogin = newLogin(`dad_${t}`);
    grant(momLogin, kidA);
    grant(dadLogin, kidB);
    setLoginTelegram(momLogin, {
      telegramEnabled: true,
      telegramChatId: `55502${t}`,
    });
    setLoginTelegram(dadLogin, {
      telegramEnabled: true,
      telegramChatId: `55503${t}`,
    });

    const supplyId = createSharedSupply(
      {
        name: `Split Bottle ${t}`,
        strength: null,
        form: null,
        lowSupplyDays: null,
        notes: null,
      },
      4
    );
    linkedItem(kidA, `Split Med ${t} A`, supplyId);
    linkedItem(kidB, `Split Med ${t} B`, supplyId);

    const mock = stubFetch();
    await runPoolRefills((p) => today(p), alwaysWaking);
    // Two genuinely different people, one message each — not a duplicate.
    expect(telegramSends(mock)).toHaveLength(2);
  });

  it("holds the nudge outside the anchor profile's waking window", async () => {
    const t = tag();
    const profileId = newProfile(`Ada Lovelace ${t}`);
    const login = newLogin(`night_${t}`);
    grant(login, profileId);
    setLoginTelegram(login, {
      telegramEnabled: true,
      telegramChatId: `55504${t}`,
    });
    const supplyId = createSharedSupply(
      {
        name: `Night Bottle ${t}`,
        strength: null,
        form: null,
        lowSupplyDays: null,
        notes: null,
      },
      2
    );
    linkedItem(profileId, `Night Med ${t}`, supplyId);

    const mock = stubFetch();
    await runPoolRefills(
      (p) => today(p),
      () => false
    );
    expect(telegramSends(mock)).toHaveLength(0);
    expect(poolRefillMarker(supplyId)).toBeUndefined();
  });
});

describe("suppression + episode lifecycle", () => {
  it("freezes the push when ANY linked member dismissed the pool finding", async () => {
    const t = tag();
    const parent = newProfile(`Ada Lovelace ${t}`);
    const child = newProfile(`Test Patient ${t}`);
    const login = newLogin(`suppressor_${t}`);
    grant(login, parent);
    grant(login, child);
    setLoginTelegram(login, {
      telegramEnabled: true,
      telegramChatId: `55505${t}`,
    });
    const supplyId = createSharedSupply(
      {
        name: `Suppressed Bottle ${t}`,
        strength: null,
        form: null,
        lowSupplyDays: null,
        notes: null,
      },
      4
    );
    linkedItem(parent, `Suppressed Med ${t} A`, supplyId);
    linkedItem(child, `Suppressed Med ${t} B`, supplyId);

    // Only the CHILD's bus carries the dismissal — "I ordered it" is a fact about the
    // bottle, so it must silence the whole household's phone, not just one member's.
    dismissFinding(child, poolRefillSignalKey(supplyId));

    const mock = stubFetch();
    await runPoolRefills((p) => today(p), alwaysWaking);
    expect(telegramSends(mock)).toHaveLength(0);
    // A suppressed episode is FROZEN, not cleared — no marker is written either.
    expect(poolRefillMarker(supplyId)).toBeUndefined();
  });

  it("sweeps the marker when the pool recovers, so the next low run re-fires", async () => {
    const t = tag();
    const profileId = newProfile(`Ada Lovelace ${t}`);
    const login = newLogin(`recover_${t}`);
    grant(login, profileId);
    setLoginTelegram(login, {
      telegramEnabled: true,
      telegramChatId: `55506${t}`,
    });
    const supplyId = createSharedSupply(
      {
        name: `Recovering Bottle ${t}`,
        strength: null,
        form: null,
        lowSupplyDays: null,
        notes: null,
      },
      3
    );
    linkedItem(profileId, `Recovering Med ${t}`, supplyId);

    const mock = stubFetch();
    await runPoolRefills((p) => today(p), alwaysWaking);
    expect(telegramSends(mock)).toHaveLength(1);
    expect(poolRefillMarker(supplyId)).toBeTruthy();

    // Refilled well above the threshold → episode over, marker cleared.
    db.prepare(
      "UPDATE shared_supplies SET quantity_on_hand = 200 WHERE id = ?"
    ).run(supplyId);
    mock.mockClear();
    await runPoolRefills((p) => today(p), alwaysWaking);
    expect(telegramSends(mock)).toHaveLength(0);
    expect(poolRefillMarker(supplyId)).toBeUndefined();

    // Low again → a fresh nudge, not silence.
    db.prepare(
      "UPDATE shared_supplies SET quantity_on_hand = 2 WHERE id = ?"
    ).run(supplyId);
    await runPoolRefills((p) => today(p), alwaysWaking);
    expect(telegramSends(mock)).toHaveLength(1);
  });
});
