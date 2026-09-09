// DB INTEGRATION TIER — one act id across every table a composed write touches (#5082).
//
// The pair below is the whole criterion, and BOTH halves are load-bearing. A test that
// only asserted the stamp would pass against a writer that stamps everything — and a
// writer that stamps everything destroys the reading the Day ledger depends on, where a
// row with NO bundle means "stated on its own" (lib/day-ledger.ts). So the null case is
// not a completeness nicety; it is the other half of the same claim.
//
// The stamped assertion counts DISTINCT ids across the tap's rows rather than checking
// that each row has some id: "they were one act" is a statement about the SET, and four
// rows each carrying their own fresh bundle would satisfy the per-row form.
//
// Fixtures are synthetic throwaway rows (per-file temp DB via setup.ts). No PHI.

import { describe, it, expect, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import { logFoodServingCore } from "@/lib/food-log-write";
import { logUsualRoutineCore } from "@/lib/usual-routine-write";
import { markDoseTaken } from "@/lib/queries/intake/adherence";
import {
  getRecentCorrectionBundles,
  readCorrectionBundle,
  restampCorrectionBundle,
} from "@/lib/bundle-time-correction";
import {
  correctionBundleBinding,
  dropMessagePointer,
  messagePointerAt,
  recordMessagePointer,
  syncMessagePointerKeyboard,
} from "@/lib/notifications/message-pointers";
import { slotSessionForKeyboard } from "@/lib/notifications/intake";
import { mintOffer } from "@/lib/notifications/offer-store";
import { getRecentFoodTaps } from "@/lib/queries/nutrition";

// A prior day's serving, seeded straight into the two stores the offer reads, so the
// habit exists without going through the writer under test.
function priorTap(profileId: number, group: string, date: string, at: string) {
  db.prepare(
    `INSERT INTO food_daily_totals (profile_id, date, group_key, servings) VALUES (?, ?, ?, 1)
       ON CONFLICT(profile_id, date, group_key) DO UPDATE SET servings = servings + 1`
  ).run(profileId, date, group);
  db.prepare(
    `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at)
     VALUES (?, ?, ?, ?)`
  ).run(profileId, group, date, `${date}T${at}Z`);
}

function seedDose(profileId: number, name: string): number {
  // SQLite defaults keep real time; both lifetime bounds must cover the frozen day
  // and the prior day reached by the midnight correction case.
  const createdAt = `${shiftDateStr(today(profileId), -1)} 00:00:00`;
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, active, obligation, condition, created_at)
         VALUES (?, ?, 'supplement', 1, 'should', 'daily', ?)`
      )
      .run(profileId, name, createdAt).lastInsertRowid
  );
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, created_at)
         VALUES (?, '1 scoop', 'morning', 'any', 0, ?)`
      )
      .run(itemId, createdAt).lastInsertRowid
  );
}

// Twelve mornings of fermented + berries, two Morning-declared doses, today empty — the
// #2458 ledger shape in miniature, UTC so the profile's local day IS the frozen one.
function seedMorning(tag: string) {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(tag)
      .lastInsertRowid
  );
  setTimezone(profileId, "UTC");
  const anchor = today(profileId);
  for (let d = 1; d <= 12; d++) {
    const date = shiftDateStr(anchor, -d);
    priorTap(profileId, "fermented", date, "08:00:00");
    priorTap(profileId, "berries", date, "08:05:00");
  }
  return {
    profileId,
    anchor,
    creatine: seedDose(profileId, `${tag} Creatine`),
    collagen: seedDose(profileId, `${tag} Collagen`),
  };
}

// Every bundle id the day's rows carry, one row per table so a half that wrote nothing
// is visible as a zero rather than hidden inside a distinct-count of one.
function bundlesOn(profileId: number, date: string) {
  const food = db
    .prepare(
      `SELECT bundle_id FROM food_log_events WHERE profile_id = ? AND date = ?`
    )
    .all(profileId, date) as { bundle_id: string | null }[];
  const doses = db
    .prepare(
      `SELECT l.bundle_id FROM intake_item_logs l
         JOIN intake_item_doses d ON d.id = l.dose_id
         JOIN intake_items s ON s.id = d.item_id
        WHERE s.profile_id = ? AND l.date = ?`
    )
    .all(profileId, date) as { bundle_id: string | null }[];
  return {
    food: food.map((r) => r.bundle_id),
    doses: doses.map((r) => r.bundle_id),
  };
}

// The real usual writer receives the original pointer; the other host has its
// own initial footprint and never receives a second usual token. No scoop is
// present to accidentally join the two hosts through a separate protein tap.
function seedChatAct(sourceKind: "food" | "dose") {
  const seeded = seedMorning(`act-${sourceKind}-source`);
  const { profileId, anchor, creatine, collagen } = seeded;
  const chatId = String(5415000 + profileId);
  const offerId = mintOffer(profileId, "usual-routine", anchor, {
    window: "Morning",
    groups: ["berries", "fermented"],
    doseIds: [creatine, collagen],
  });
  const footprint = (kind: "food" | "dose") => [
    [
      {
        text: kind,
        callback_data:
          kind === "food"
            ? `food:${profileId}:Morning:${anchor}:berries`
            : `all:${profileId}:Morning:${anchor}`,
      },
    ],
  ];
  const targetKind: "food" | "dose" = sourceKind === "food" ? "dose" : "food";
  recordMessagePointer({
    profileId,
    chatId,
    messageId: 54151,
    kind: sourceKind,
    date: anchor,
    keyboard: [
      [{ text: "Your usual", callback_data: `usual:${profileId}:${offerId}` }],
      ...footprint(sourceKind),
    ],
  });
  recordMessagePointer({
    profileId,
    chatId,
    messageId: 54152,
    kind: targetKind,
    date: anchor,
    keyboard: footprint(targetKind),
  });
  const source = messagePointerAt(profileId, chatId, 54151)!;
  expect(
    logUsualRoutineCore(
      profileId,
      "Morning",
      anchor,
      ["berries", "fermented"],
      [creatine, collagen],
      "telegram-nudge",
      source.id
    ).kind
  ).toBe("logged");
  const bundle = getRecentCorrectionBundles(
    profileId,
    targetKind,
    new Date()
  )[0];
  const token = `${targetKind}time:${profileId}:${bundle.burst.fromId}:30`;
  // Both initial sets can now be consumed; only receipt_keyboard retains them.
  syncMessagePointerKeyboard(profileId, chatId, 54151, []);
  syncMessagePointerKeyboard(profileId, chatId, 54152, [
    [{ text: "−30m", callback_data: token }],
  ]);
  return { ...seeded, chatId, source, targetKind, bundle, token, footprint };
}

describe("the usual act's captured correction hosts (#5415)", () => {
  it.each(["food", "dose"] as const)(
    "binds a no-scoop act from its %s source to the other consumed host",
    (sourceKind) => {
      vi.setSystemTime(new Date("2026-08-18T09:42:17Z"));
      const { profileId, chatId, source, targetKind, bundle, token } =
        seedChatAct(sourceKind);
      const proof = correctionBundleBinding(
        profileId,
        targetKind,
        bundle,
        { chatId, messageId: 54152 },
        slotSessionForKeyboard,
        token
      )!;
      expect(proof.source.id).toBe(source.id);
      expect(bundle.members).toHaveLength(4);
      expect(proof.stillBound(bundle)).toBe(true);
      // The current exact token is required even though the underlying act exists.
      syncMessagePointerKeyboard(profileId, chatId, 54152, []);
      expect(proof.stillBound(bundle)).toBe(false);
      syncMessagePointerKeyboard(profileId, chatId, 54152, [
        [{ text: "−30m", callback_data: token }],
      ]);
      expect(proof.stillBound(bundle)).toBe(true);
      // A source prune cannot be replaced by a same-location, same-offer pointer.
      dropMessagePointer(profileId, source.id);
      recordMessagePointer({
        profileId,
        chatId,
        messageId: source.messageId,
        kind: source.kind,
        date: source.date,
        keyboard: source.receiptKeyboard,
      });
      expect(proof.stillBound(bundle)).toBe(false);
      const current = readCorrectionBundle(profileId, {
        domain: targetKind,
        id: bundle.burst.fromId,
      })!;
      expect(
        correctionBundleBinding(
          profileId,
          targetKind,
          current,
          { chatId, messageId: 54152 },
          slotSessionForKeyboard,
          token
        )
      ).toBeNull();
    }
  );

  it("selects only the newest matching food context and refuses a missing initial receipt", () => {
    vi.setSystemTime(new Date("2026-08-18T09:42:17Z"));
    const { profileId, anchor, chatId, bundle, token, footprint } =
      seedChatAct("dose");
    const ref = { chatId, messageId: 54152 };
    const proof = correctionBundleBinding(
      profileId,
      "food",
      bundle,
      ref,
      slotSessionForKeyboard,
      token
    )!;
    recordMessagePointer({
      profileId,
      chatId,
      messageId: 54153,
      kind: "food",
      date: anchor,
      keyboard: [
        [
          {
            text: "Evening",
            callback_data: `food:${profileId}:Evening:${anchor}:berries`,
          },
        ],
      ],
    });
    expect(proof.stillBound(bundle)).toBe(true);
    recordMessagePointer({
      profileId,
      chatId,
      messageId: 54154,
      kind: "food",
      date: anchor,
      keyboard: footprint("food"),
    });
    expect(proof.stillBound(bundle)).toBe(false);
    const next = { chatId, messageId: 54154 };
    expect(
      correctionBundleBinding(
        profileId,
        "food",
        bundle,
        next,
        slotSessionForKeyboard
      )
    ).not.toBeNull();
    // The legacy fallback to live keyboard is not an immutable initial receipt.
    for (const receipt of [null, "invalid-json"]) {
      db.prepare(
        "UPDATE notify_messages SET receipt_keyboard = ? WHERE profile_id = ? AND message_id = ?"
      ).run(receipt, profileId, 54154);
      expect(
        correctionBundleBinding(
          profileId,
          "food",
          bundle,
          next,
          slotSessionForKeyboard
        )
      ).toBeNull();
      expect(proof.stillBound(bundle)).toBe(true);
    }
  });

  it("keeps both host anchors discoverable while the latest member keeps the whole act fresh", () => {
    vi.setSystemTime(new Date("2026-08-18T09:42:17Z"));
    const { profileId, bundle } = seedChatAct("dose");
    // The real usual writer calls the food and dose writers in sequence. Pin that
    // one-second gap so the food stamp is outside the floor and the dose inside.
    db.prepare(
      `UPDATE intake_item_logs SET recorded_at = '2026-08-18T09:42:18Z'
      WHERE bundle_id = ? AND dose_id IN (
        SELECT d.id FROM intake_item_doses d JOIN intake_items i ON i.id = d.item_id
        WHERE i.profile_id = ?)`
    ).run(bundle.id, profileId);
    vi.setSystemTime(new Date("2026-08-18T10:42:17.500Z"));
    for (const domain of ["food", "dose"] as const) {
      const candidates = getRecentCorrectionBundles(
        profileId,
        domain,
        new Date()
      );
      expect(candidates.map((candidate) => candidate.id)).toEqual([bundle.id]);
      expect(candidates[0].members).toHaveLength(4);
    }
  });

  it("discovers complete acts beyond the recent-row cap and refuses a current ineligible sibling", () => {
    vi.setSystemTime(new Date("2026-08-18T09:42:17Z"));
    const { profileId, anchor, creatine, collagen } =
      seedMorning("act-candidate-cap");
    const unrelated = db.prepare(`INSERT INTO food_log_events
      (profile_id, group_key, date, recorded_at, logged_via)
      VALUES (?, 'dark_leafy_greens', ?, '2026-08-18T09:41:00Z', 'telegram-nudge')`);
    for (let i = 0; i < 101; i++) unrelated.run(profileId, anchor);
    expect(
      logUsualRoutineCore(
        profileId,
        "Morning",
        anchor,
        ["berries", "fermented"],
        [creatine, collagen],
        "telegram-nudge"
      ).kind
    ).toBe("logged");
    expect(
      getRecentFoodTaps(profileId, new Date()).some(
        (tap) => tap.bundleId != null
      )
    ).toBe(false);
    const [bundle] = getRecentCorrectionBundles(profileId, "food", new Date());
    expect(bundle.members).toHaveLength(4);
    db.prepare(
      "UPDATE intake_item_logs SET status = 'skipped' WHERE dose_id = ?"
    ).run(creatine);
    expect(getRecentCorrectionBundles(profileId, "food", new Date())).toEqual(
      []
    );
  });
});

describe("one usual tap, one act id (#5082)", () => {
  it.each(["food", "dose"] as const)(
    "corrects the complete usual act from its %s anchor",
    (domain) => {
      vi.setSystemTime(new Date("2026-08-18T09:42:17Z"));
      const { profileId, anchor, creatine, collagen } = seedMorning(
        `act-${domain}`
      );
      expect(
        logUsualRoutineCore(
          profileId,
          "Morning",
          anchor,
          ["berries", "fermented"],
          [creatine, collagen],
          "page"
        ).kind
      ).toBe("logged");
      const food = db
        .prepare(
          "SELECT id FROM food_log_events WHERE profile_id = ? AND date = ? ORDER BY id"
        )
        .all(profileId, anchor) as { id: number }[];
      const dose = db
        .prepare("SELECT id FROM intake_item_logs WHERE dose_id = ?")
        .get(creatine) as { id: number };
      // Reproduce the split current clocks, rather than correcting equal tap stamps.
      db.prepare(
        "UPDATE intake_item_logs SET occurred_at = ? WHERE id = ?"
      ).run("2026-08-18T07:42:17Z", dose.id);
      logFoodServingCore(profileId, "berries", anchor, "page");
      const selected = { domain, id: domain === "food" ? food[0].id : dose.id };
      const before = readCorrectionBundle(profileId, selected)!;
      const outcome = restampCorrectionBundle(
        profileId,
        selected,
        before.id,
        { kind: "chip", minutesBack: 30 },
        new Date(),
        () => true
      );
      expect(outcome).toMatchObject({
        kind: "restamped",
        foodCount: 2,
        doseCount: 2,
      });
      const after = readCorrectionBundle(profileId, selected)!;
      expect(after.members.map((m) => m.statedAt)).toEqual(
        Array(4).fill("2026-08-18T07:12:17Z")
      );
      const servings = db
        .prepare(
          "SELECT occurred_at, meal_slot, time_source FROM food_log_events WHERE profile_id = ? AND bundle_id = ?"
        )
        .all(profileId, before.id);
      expect(servings).toEqual(
        Array(2).fill({
          occurred_at: "2026-08-18T07:12:17Z",
          meal_slot: null,
          time_source: "stated",
        })
      );
      const independent = db
        .prepare(
          "SELECT occurred_at FROM food_log_events WHERE profile_id = ? AND date = ? AND bundle_id IS NULL"
        )
        .all(profileId, anchor);
      expect(independent).toEqual([{ occurred_at: null }]);
    }
  );

  it("rolls back food day counters and rows when a later domain refuses", () => {
    vi.setSystemTime(new Date("2026-08-18T00:10:17Z"));
    const { profileId, anchor, creatine, collagen } =
      seedMorning("act-rollback");
    expect(
      logUsualRoutineCore(
        profileId,
        "Morning",
        anchor,
        ["berries", "fermented"],
        [creatine, collagen],
        "page"
      ).kind
    ).toBe("logged");
    const food = db
      .prepare(
        "SELECT id FROM food_log_events WHERE profile_id = ? AND date = ? ORDER BY id"
      )
      .all(profileId, anchor) as { id: number }[];
    const selected = { domain: "food" as const, id: food[0].id };
    const before = readCorrectionBundle(profileId, selected)!;
    const counters = () =>
      db
        .prepare(
          "SELECT date, group_key, servings FROM food_daily_totals WHERE profile_id = ? ORDER BY date, group_key"
        )
        .all(profileId);
    const originalCounters = counters();
    // A later refusal must escape the outer transaction, not commit its earlier
    // food work. The trigger supplies that race at a synchronous DB boundary.
    db.exec(`CREATE TEMP TRIGGER refuse_act_dose AFTER UPDATE OF occurred_at ON food_log_events
      WHEN NEW.id = ${food[0].id}
      BEGIN UPDATE intake_item_logs SET status = 'skipped' WHERE dose_id = ${creatine}; END`);
    try {
      expect(
        restampCorrectionBundle(
          profileId,
          selected,
          before.id,
          { kind: "chip", minutesBack: 30 },
          new Date(),
          () => true
        )
      ).toEqual({ kind: "no-burst" });
      expect(readCorrectionBundle(profileId, selected)).toEqual(before);
      expect(counters()).toEqual(originalCounters);
    } finally {
      db.exec("DROP TRIGGER refuse_act_dose");
    }
  });

  it("stamps the same bundle on its food rows and its dose rows", () => {
    const { profileId, anchor, creatine, collagen } = seedMorning("act-stamp");

    const outcome = logUsualRoutineCore(
      profileId,
      "Morning",
      anchor,
      ["berries", "fermented"],
      [creatine, collagen],
      "page"
    );
    expect(outcome.kind).toBe("logged");

    const { food, doses } = bundlesOn(profileId, anchor);
    // BOTH HALVES ACTUALLY WROTE. Without this the distinct-count below would be
    // satisfied by a tap that logged doses and no servings at all — the exact shape
    // this issue exists to fix, passing its own test.
    expect([food.length, doses.length]).toEqual([2, 2]);
    const ids = new Set([...food, ...doses]);
    expect(ids.size).toBe(1);
    // Sixteen hex characters, because that is what `newBundle` mints (lib/bundle.ts)
    // and what the ledger's collapse key relies on being true of every bundle.
    expect([...ids][0]).toMatch(/^[0-9a-f]{16}$/);
  });

  // A single write composed nothing, so it records nothing — which is what keeps
  // "no bundle" readable as "stated on its own" rather than as "written before the
  // column existed".
  it("writes NULL for a single serving add and a single dose confirm", () => {
    const { profileId, anchor, creatine } = seedMorning("act-null");

    expect(logFoodServingCore(profileId, "berries", anchor, "page").kind).toBe(
      "logged"
    );
    expect(markDoseTaken(profileId, creatine, null, anchor, "page")).toBe(
      "logged"
    );

    expect(bundlesOn(profileId, anchor)).toEqual({
      food: [null],
      doses: [null],
    });
  });
});
