import { describe, it, expect } from "vitest";
import {
  burstFrom,
  burstLabel,
  burstSubject,
  chipInstant,
  collapseBursts,
  correctionBursts,
  correctionTokenAnchor,
  CORRECTION_CHIP_HOURS,
  isBurstFresh,
  isOfferedHour,
  MAX_CORRECTION_ROWS,
  parseCorrectionAtToken,
  parseCorrectionChipToken,
  PICKER_FIRST_HOURS_BACK,
  PICKER_LAST_HOURS_BACK,
  pickerHourOptions,
  statedHourInstant,
  type TapEvent,
} from "@/lib/correction-time";
import {
  correctionActions,
  correctionPickerActions,
  FOOD_TIME_PREFIXES,
  DOSE_TIME_PREFIXES,
  openPickerAnchor,
} from "@/lib/notifications/correction-rows";

// The pure model behind #2019's eating-time chips and #2020's dose-time twin. No DB, no
// clock: every function takes its `now`, so the burst window, the cross-midnight day rule
// and the render-vs-tap independence are all fixture-pinnable.

const TZ = "Europe/Berlin"; // UTC+2 in August

function tap(id: number, iso: string, label = "Salmon"): TapEvent {
  return { id, tapAt: iso, label };
}

describe("collapseBursts — burst-mates share one error, so they share one row", () => {
  it("groups taps within the gap and splits on a wider one", () => {
    const bursts = collapseBursts([
      tap(1, "2026-08-05T19:02:00Z", "Salmon"),
      tap(2, "2026-08-05T19:05:00Z", "Leafy greens"),
      tap(3, "2026-08-05T19:08:00Z", "Berries"),
      // 40 minutes later: a different meal, a different error, a different row.
      tap(4, "2026-08-05T19:48:00Z", "Nuts"),
    ]);
    expect(bursts).toHaveLength(2);
    expect(bursts[0].ids).toEqual([1, 2, 3]);
    expect(bursts[0].fromId).toBe(1);
    expect(bursts[0].count).toBe(3);
    expect(bursts[0].startAt).toBe("2026-08-05T19:02:00Z");
    expect(bursts[0].endAt).toBe("2026-08-05T19:08:00Z");
    expect(bursts[1].ids).toEqual([4]);
  });

  it("chains across a long run as long as each step is inside the gap", () => {
    // 0, 10, 20, 30 minutes: no single step exceeds 15, so it is ONE meal being tapped
    // group by group rather than four separate ones.
    const bursts = collapseBursts([
      tap(1, "2026-08-05T19:00:00Z"),
      tap(2, "2026-08-05T19:10:00Z"),
      tap(3, "2026-08-05T19:20:00Z"),
      tap(4, "2026-08-05T19:30:00Z"),
    ]);
    expect(bursts).toHaveLength(1);
    expect(bursts[0].ids).toEqual([1, 2, 3, 4]);
  });

  it("orders by tap instant, with the row id breaking an identical-stamp tie", () => {
    const bursts = collapseBursts([
      tap(9, "2026-08-05T19:00:00Z"),
      tap(7, "2026-08-05T19:00:00Z"),
      tap(8, "2026-08-05T19:00:00Z"),
    ]);
    expect(bursts).toHaveLength(1);
    expect(bursts[0].ids).toEqual([7, 8, 9]);
    // The ANCHOR is the lowest id, which is what the token carries.
    expect(bursts[0].fromId).toBe(7);
  });

  it("names a lone tap by what it was and a burst by its span", () => {
    const [lone] = collapseBursts([tap(1, "2026-08-05T18:11:00Z", "Salmon")]);
    expect(lone.label).toBe("Salmon");
    expect(burstLabel(lone, TZ)).toBe("Salmon 20:11");

    const [many] = collapseBursts([
      tap(1, "2026-08-05T19:02:00Z", "Salmon"),
      tap(2, "2026-08-05T19:08:00Z", "Berries"),
    ]);
    // Four groups will not fit on a button; the span is what identifies the burst.
    expect(many.label).toBe("");
    expect(burstLabel(many, TZ)).toBe("×2 21:02–21:08");
    expect(burstSubject(many, TZ)).toBe("these 2 (21:02–21:08)");
  });
});

describe("freshness — the offer and the refusal are one predicate", () => {
  const NOW = new Date("2026-08-05T20:00:00Z");

  it("offers a burst inside the hour and drops it outside", () => {
    const fresh = collapseBursts([tap(1, "2026-08-05T19:30:00Z")])[0];
    const lapsed = collapseBursts([tap(2, "2026-08-05T18:30:00Z")])[0];
    expect(isBurstFresh(fresh, NOW)).toBe(true);
    expect(isBurstFresh(lapsed, NOW)).toBe(false);
  });

  it("keys freshness on the NEWEST tap, so a burst still being added to stays live", () => {
    // The first tap is 70 minutes old, the last is 5 — the meal is still happening.
    const burst = collapseBursts([
      tap(1, "2026-08-05T18:50:00Z"),
      tap(2, "2026-08-05T19:02:00Z"),
      tap(3, "2026-08-05T19:14:00Z"),
      tap(4, "2026-08-05T19:26:00Z"),
      tap(5, "2026-08-05T19:38:00Z"),
      tap(6, "2026-08-05T19:50:00Z"),
      tap(7, "2026-08-05T19:55:00Z"),
    ])[0];
    expect(burst.count).toBe(7);
    expect(isBurstFresh(burst, NOW)).toBe(true);
  });

  it("renders newest first and caps the rows", () => {
    // Three separate bursts (twenty minutes apart, so none of them chains), all inside
    // the hour before NOW.
    const events: TapEvent[] = [
      tap(1, "2026-08-05T19:05:00Z"),
      tap(2, "2026-08-05T19:25:00Z"),
      tap(3, "2026-08-05T19:45:00Z"),
    ];
    const rows = correctionBursts(events, NOW);
    expect(rows).toHaveLength(MAX_CORRECTION_ROWS);
    // Newest first: the row that needs correcting is the one on top.
    expect(new Date(rows[0].endAt).getTime()).toBeGreaterThan(
      new Date(rows[1].endAt).getTime()
    );
  });

  it("drops a burst whose taps have all aged out", () => {
    const events = [tap(1, "2026-08-05T18:00:00Z"), tap(2, "2026-08-05T18:05:00Z")];
    expect(correctionBursts(events, NOW)).toEqual([]);
  });
});

describe("burstFrom — the token carries an id, the ledger decides the set", () => {
  const events = [
    tap(11, "2026-08-05T19:02:00Z"),
    tap(12, "2026-08-05T19:05:00Z"),
    tap(13, "2026-08-05T19:50:00Z"),
  ];

  it("re-derives exactly the burst its anchor starts", () => {
    expect(burstFrom(events, 11)!.ids).toEqual([11, 12]);
    expect(burstFrom(events, 13)!.ids).toEqual([13]);
  });

  it("refuses an anchor that is gone or does not start a burst", () => {
    expect(burstFrom(events, 12)).toBeNull();
    expect(burstFrom(events, 999)).toBeNull();
  });
});

describe("chips — anchored to the tap, so a re-tap is idempotent", () => {
  it("moves each row back from its OWN tap, keeping the burst's spread", () => {
    const a = chipInstant("2026-08-05T19:02:00Z", 2);
    const b = chipInstant("2026-08-05T19:08:00Z", 2);
    expect(a.toISOString()).toBe("2026-08-05T17:02:00.000Z");
    expect(b.toISOString()).toBe("2026-08-05T17:08:00.000Z");
    // Six minutes apart before, six minutes apart after.
    expect(b.getTime() - a.getTime()).toBe(6 * 60_000);
  });

  it("lands on the same instant however many times it is tapped", () => {
    const once = chipInstant("2026-08-05T19:02:00Z", 2).toISOString();
    const twice = chipInstant("2026-08-05T19:02:00Z", 2).toISOString();
    // The offset is computed from `logged_at`, which nothing ever edits — so two people
    // tapping the same message cannot walk a serving four hours into the past.
    expect(twice).toBe(once);
  });
});

describe("the picker — absolute hours, the past twelve, never the future", () => {
  // 00:30 local (Berlin, UTC+2) — the case that motivated the picker: dinner at 19:00
  // tapped after midnight is −5.5h, past every chip.
  const NOW = new Date("2026-08-05T22:30:00Z");

  it("starts where the chips stop and runs to the ceiling", () => {
    const hours = pickerHourOptions(NOW, TZ);
    expect(hours).toEqual([
      "20:00",
      "19:00",
      "18:00",
      "17:00",
      "16:00",
      "15:00",
      "14:00",
      "13:00",
      "12:00",
    ]);
    expect(hours).toHaveLength(
      PICKER_LAST_HOURS_BACK - PICKER_FIRST_HOURS_BACK + 1
    );
    // The last chip is −3h, so the first offered hour is one past it — the picker never
    // re-offers what a chip already covers.
    expect(PICKER_FIRST_HOURS_BACK).toBe(
      CORRECTION_CHIP_HOURS[CORRECTION_CHIP_HOURS.length - 1] + 1
    );
  });

  it("never offers the future, at any hour of the day", () => {
    for (const h of [0, 3, 9, 13, 21, 23]) {
      const now = new Date(`2026-08-05T${String(h).padStart(2, "0")}:30:00Z`);
      for (const hhmm of pickerHourOptions(now, TZ)) {
        expect(
          statedHourInstant(hhmm, now, TZ).getTime(),
          `${hhmm} at ${now.toISOString()}`
        ).toBeLessThanOrEqual(now.getTime());
      }
    }
  });

  it("resolves an hour later than now to YESTERDAY — the cross-midnight day rule", () => {
    // 00:30 local on the 6th; "20:00" is later than the current hour, so it means the
    // 5th at 20:00 — which is exactly how someone answers 'when did you eat' after
    // midnight, and what re-dates the serving.
    const inst = statedHourInstant("20:00", NOW, TZ);
    expect(inst.toISOString()).toBe("2026-08-05T18:00:00.000Z");
  });

  it("resolves an hour earlier than now to TODAY", () => {
    const now = new Date("2026-08-05T18:30:00Z"); // 20:30 local
    expect(statedHourInstant("16:00", now, TZ).toISOString()).toBe(
      "2026-08-05T14:00:00.000Z"
    );
  });

  it("is independent of the delay between rendering and tapping", () => {
    // THE PROPERTY THE RELATIVE FORM FAILS. A `−5h` button computes its offset at TAP
    // time, so hesitating two minutes lands two minutes off; an absolute hour cannot.
    const rendered = new Date("2026-08-05T18:30:00Z");
    const tapped = new Date("2026-08-05T18:32:00Z");
    expect(statedHourInstant("16:00", rendered, TZ).toISOString()).toBe(
      statedHourInstant("16:00", tapped, TZ).toISOString()
    );
  });

  it("refuses an hour that is no longer on offer", () => {
    expect(isOfferedHour("20:00", NOW, TZ)).toBe(true);
    // Two hours later, 20:00 has slid past the twelve-hour ceiling of nothing — but
    // 01:00 (the hour just gone) was never offered, because the chips cover it.
    expect(isOfferedHour("01:00", NOW, TZ)).toBe(false);
    expect(isOfferedHour("23:00", NOW, TZ)).toBe(false);
  });
});

describe("tokens — ids only, and the shapes both domains share", () => {
  it("round-trips a chip token and refuses an offset nobody offers", () => {
    const t = `${FOOD_TIME_PREFIXES.chip}:3:412:120`;
    expect(parseCorrectionChipToken(t, FOOD_TIME_PREFIXES.chip)).toEqual({
      profileId: 3,
      fromId: 412,
      minutesBack: 120,
    });
    // A forged offset is refused rather than clamped into something plausible.
    expect(
      parseCorrectionChipToken(
        `${FOOD_TIME_PREFIXES.chip}:3:412:24000`,
        FOOD_TIME_PREFIXES.chip
      )
    ).toBeNull();
    // A dose token is not a food token.
    expect(parseCorrectionChipToken(t, DOSE_TIME_PREFIXES.chip)).toBeNull();
  });

  it("round-trips the picker's three steps, HH:MM colons included", () => {
    const at = DOSE_TIME_PREFIXES.at;
    expect(parseCorrectionAtToken(`${at}:3:412:open`, at)).toEqual({
      profileId: 3,
      fromId: 412,
      step: { kind: "open" },
    });
    expect(parseCorrectionAtToken(`${at}:3:412:back`, at)).toEqual({
      profileId: 3,
      fromId: 412,
      step: { kind: "back" },
    });
    // The tail carries its own colon, so it is rejoined rather than read positionally.
    expect(parseCorrectionAtToken(`${at}:3:412:19:00`, at)).toEqual({
      profileId: 3,
      fromId: 412,
      step: { kind: "at", hhmm: "19:00" },
    });
    expect(parseCorrectionAtToken(`${at}:3:412:29:00`, at)).toBeNull();
    expect(parseCorrectionAtToken(`${at}:3:0:19:00`, at)).toBeNull();
  });

  it("stays under Telegram's 64-byte callback cap at realistic ids", () => {
    const t = `${FOOD_TIME_PREFIXES.at}:999999:99999999:19:00`;
    expect(Buffer.byteLength(t, "utf8")).toBeLessThanOrEqual(64);
  });

  it("reads a token's anchor back for any of the four prefixes", () => {
    expect(
      correctionTokenAnchor(`${DOSE_TIME_PREFIXES.chip}:3:412:60`, [
        DOSE_TIME_PREFIXES.chip,
        DOSE_TIME_PREFIXES.at,
      ])
    ).toBe(412);
    expect(correctionTokenAnchor("food:3:Evening:2026-08-05:salmon", [
      DOSE_TIME_PREFIXES.chip,
      DOSE_TIME_PREFIXES.at,
    ])).toBeNull();
  });
});

describe("the rendered rows", () => {
  const NOW = new Date("2026-08-05T19:30:00Z");
  const bursts = correctionBursts(
    [
      tap(11, "2026-08-05T19:02:00Z", "Salmon"),
      tap(12, "2026-08-05T19:08:00Z", "Berries"),
    ],
    NOW
  );

  it("puts the named picker button first, then the three chips, on ONE row", () => {
    const actions = correctionActions(FOOD_TIME_PREFIXES, 3, bursts, TZ);
    expect(actions.map((a) => a.label)).toEqual([
      "🕐 ×2 21:02–21:08",
      "−1h",
      "−2h",
      "−3h",
    ]);
    // One row key, so the four buttons render side by side.
    expect(new Set(actions.map((a) => a.row)).size).toBe(1);
    // The label button IS the picker's opener.
    expect(actions[0].data).toBe("foodtimeat:3:11:open");
    expect(actions[1].data).toBe("foodtime:3:11:60");
  });

  it("keys rows by anchor so two bursts never collapse onto one", () => {
    const two = correctionBursts(
      [tap(11, "2026-08-05T19:02:00Z"), tap(20, "2026-08-05T19:25:00Z")],
      NOW
    );
    const actions = correctionActions(FOOD_TIME_PREFIXES, 3, two, TZ);
    expect(new Set(actions.map((a) => a.row)).size).toBe(2);
  });

  it("lays the picker out three per row and always offers a way back", () => {
    const actions = correctionPickerActions(
      DOSE_TIME_PREFIXES,
      3,
      bursts[0],
      NOW,
      TZ
    );
    expect(actions[actions.length - 1].label).toBe("↩︎ Back");
    const rows = new Map<string, number>();
    for (const a of actions.slice(0, -1))
      rows.set(a.row!, (rows.get(a.row!) ?? 0) + 1);
    for (const n of rows.values()) expect(n).toBeLessThanOrEqual(3);
  });

  it("reads an open picker back off a live keyboard, and only its own domain's", () => {
    const tokens = correctionPickerActions(
      FOOD_TIME_PREFIXES,
      3,
      bursts[0],
      NOW,
      TZ
    ).map((a) => a.data!);
    expect(openPickerAnchor(tokens, FOOD_TIME_PREFIXES)).toBe(11);
    expect(openPickerAnchor(tokens, DOSE_TIME_PREFIXES)).toBeNull();
    // A keyboard showing the CHIPS is not showing a picker.
    const chipTokens = correctionActions(
      FOOD_TIME_PREFIXES,
      3,
      bursts,
      TZ
    ).map((a) => a.data!);
    expect(openPickerAnchor(chipTokens, FOOD_TIME_PREFIXES)).toBeNull();
  });
});
