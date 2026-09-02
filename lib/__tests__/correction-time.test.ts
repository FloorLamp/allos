import { describe, it, expect } from "vitest";
import {
  burstFrom,
  burstLabel,
  burstLocalDay,
  burstSubject,
  chipInstant,
  collapseBursts,
  correctionBursts,
  correctionTokenAnchor,
  chipFloor,
  chipLabel,
  chipOffers,
  chipTarget,
  correctionAtToken,
  correctionDayDate,
  offeredHourInstant,
  pickerHourLabel,
  pickerPrevDayHourOptions,
  CHIP_FLOOR_HOURS_BACK,
  CORRECTION_CHIP_MINUTES,
  isBurstFresh,
  isOfferedHour,
  MAX_CORRECTION_ROWS,
  offeredHours,
  parseCorrectionAtToken,
  parseCorrectionChipToken,
  PICKER_FIRST_HOURS_BACK,
  PICKER_LAST_HOURS_BACK,
  pickerHourOptions,
  statedHourInstant,
  type TapEvent,
} from "@/lib/correction-time";
import {
  correctableBursts,
  correctionActions,
  correctionBodyStatement,
  correctionOffScopeStatement,
  correctionPickerActions,
  correctionPickerTitle,
  FOOD_TIME_PREFIXES,
  DOSE_TIME_PREFIXES,
  PRACTICE_TIME_PREFIXES,
  openPickerAnchor,
} from "@/lib/notifications/correction-rows";
import { burstsForMessage, FRESH_SEND_BINDING } from "@/lib/correction-time";
import { zonedDateParts } from "@/lib/date";
import { statedHoursOnDate } from "@/lib/stated-time";

// The pure model behind #2019's eating-time chips and #2020's dose-time twin. No DB, no
// clock: every function takes its `now`, so the burst window, the cross-midnight day rule
// and the render-vs-tap independence are all fixture-pinnable.

const TZ = "Europe/Berlin"; // UTC+2 in August

function tap(id: number, iso: string, label = "Salmon"): TapEvent {
  return { id, tapAt: iso, label };
}

// A tap that has already been corrected: the ledger holds `statedAt`, the audit stamp
// still holds the tap.
function corrected(
  id: number,
  tapIso: string,
  statedIso: string,
  label = "Salmon"
): TapEvent {
  return { id, tapAt: tapIso, statedAt: statedIso, label };
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
    expect(burstLabel(lone, TZ, new Date("2026-08-05T19:30:00Z"))).toBe(
      "Salmon 20:11"
    );

    const [many] = collapseBursts([
      tap(1, "2026-08-05T19:02:00Z", "Salmon"),
      tap(2, "2026-08-05T19:08:00Z", "Berries"),
    ]);
    // Four groups will not fit on a button; the span is what identifies the burst.
    expect(many.label).toBe("");
    expect(burstLabel(many, TZ, new Date("2026-08-05T19:30:00Z"))).toBe(
      "×2 21:02–21:08"
    );
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
    const events = [
      tap(1, "2026-08-05T18:00:00Z"),
      tap(2, "2026-08-05T18:05:00Z"),
    ];
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

describe("chips — the label IS the stored value (#2206)", () => {
  const NOW = new Date("2026-08-05T19:30:00Z"); // 21:30 local

  it("moves each row back from its OWN instant, keeping the burst's spread", () => {
    const a = chipInstant("2026-08-05T19:02:00Z", 120);
    const b = chipInstant("2026-08-05T19:08:00Z", 120);
    expect(a.toISOString()).toBe("2026-08-05T17:02:00.000Z");
    expect(b.toISOString()).toBe("2026-08-05T17:08:00.000Z");
    // Six minutes apart before, six minutes apart after.
    expect(b.getTime() - a.getTime()).toBe(6 * 60_000);
  });

  it("labels every chip with the local time chipInstant computes for it", () => {
    // The whole point: no surface re-derives an offset, and no user does arithmetic.
    // Sampled across the day so an off-by-a-timezone label cannot hide in one hour.
    for (const h of [0, 3, 9, 13, 21, 23]) {
      const tapAt = `2026-08-05T${String(h).padStart(2, "0")}:41:00Z`;
      const burst = collapseBursts([tap(1, tapAt)])[0];
      const now = new Date(new Date(tapAt).getTime() + 10 * 60_000);
      for (const offer of chipOffers(burst, now, TZ)) {
        const at = chipInstant(burst.atStartAt, offer.minutesBack);
        expect(offer.at.toISOString()).toBe(at.toISOString());
        expect(offer.label.startsWith(zonedDateParts(TZ, at).hhmm)).toBe(true);
      }
    }
  });

  it("states the real local time across a DST fall-back, where an offset lies", () => {
    // Europe/Berlin falls back at 03:00 local on 2026-10-25: 01:00 UTC is 03:00 CEST,
    // 02:00 UTC is 02:00 CET. A tap at 03:10 local (01:10 UTC) is an hour and ten
    // minutes into the repeated hour.
    const burst = collapseBursts([tap(1, "2026-10-25T01:10:00Z")])[0];
    const now = new Date("2026-10-25T01:20:00Z");
    const labels = chipOffers(burst, now, TZ).map((o) => o.label);
    // −30m lands at 00:40 UTC = 02:40 CEST; −1h lands at 00:10 UTC = 02:10 CEST.
    expect(labels).toEqual(["02:40 · −30m", "02:10 · −1h"]);
    // AND THE ROW ITSELF READS 02:10, because the tap (01:10 UTC) is already past the
    // fall-back and 02:10 CET is the same wall time as 02:10 CEST an hour earlier. So
    // "−1h" is a claim the clock on the wall flatly contradicts, and only the absolute
    // label lets the user see which 02:10 they are choosing.
    expect(burstLabel(burst, TZ, now)).toBe("Salmon 02:10");
  });

  it("composes: a second tap counts back from the STORED instant, not the tap", () => {
    const row = { tapAt: "2026-08-05T19:02:00Z", statedAt: null };
    const once = chipTarget(row, 60, NOW)!;
    expect(once.toISOString()).toBe("2026-08-05T18:02:00.000Z");
    // The write stored that, so the second tap starts from it: two hours back, not one.
    const twice = chipTarget(
      { tapAt: row.tapAt, statedAt: once.toISOString() },
      60,
      NOW
    )!;
    expect(twice.toISOString()).toBe("2026-08-05T17:02:00.000Z");
    const thrice = chipTarget(
      { tapAt: row.tapAt, statedAt: twice.toISOString() },
      30,
      NOW
    )!;
    expect(thrice.toISOString()).toBe("2026-08-05T16:32:00.000Z");
  });

  it("drops the chips at the floor rather than walking past it", () => {
    const floor = chipFloor(NOW);
    expect(floor.toISOString()).toBe("2026-08-05T07:30:00.000Z");

    // Already corrected to twenty minutes above the floor: −30m would cross, −1h too.
    const deep = collapseBursts([
      corrected(1, "2026-08-05T19:02:00Z", "2026-08-05T07:50:00Z"),
    ])[0];
    expect(chipOffers(deep, NOW, TZ)).toEqual([]);
    expect(
      chipTarget({ tapAt: deep.startAt, statedAt: deep.atStartAt }, 30, NOW)
    ).toBeNull();

    // Forty minutes above the floor: the small chip still fits, the big one does not.
    const edge = collapseBursts([
      corrected(1, "2026-08-05T19:02:00Z", "2026-08-05T08:10:00Z"),
    ])[0];
    expect(chipOffers(edge, NOW, TZ).map((o) => o.minutesBack)).toEqual([30]);
  });

  it("bounds the chips by the same reach the picker has", () => {
    expect(CHIP_FLOOR_HOURS_BACK).toBe(PICKER_LAST_HOURS_BACK);
  });

  it("never lets a chip label collide with an hour the picker offers", () => {
    // The two vocabularies are both absolute now, so they must not name the same time
    // twice on one keyboard. An UNCORRECTED burst is the case a keyboard actually shows
    // beside a picker; sampled across the freshness window and the day.
    for (const h of [0, 5, 11, 17, 23]) {
      for (const ageMin of [0, 17, 43, 59]) {
        const now = new Date(`2026-08-05T${String(h).padStart(2, "0")}:37:00Z`);
        const tapAt = new Date(now.getTime() - ageMin * 60_000).toISOString();
        const burst = collapseBursts([tap(1, tapAt)])[0];
        const picker = new Set(pickerHourOptions(now, TZ));
        for (const offer of chipOffers(burst, now, TZ)) {
          expect(
            picker.has(zonedDateParts(TZ, offer.at).hhmm),
            `${offer.label} at ${now.toISOString()}`
          ).toBe(false);
        }
      }
    }
  });

  it("spells the offset as context, absolute first", () => {
    const at = new Date("2026-08-05T17:11:00Z");
    expect(chipLabel(at, TZ, 30)).toBe("19:11 · −30m");
    expect(chipLabel(at, TZ, 60)).toBe("19:11 · −1h");
  });
});

describe("the picker — absolute hours, the past twelve, never the future", () => {
  // 00:30 local (Berlin, UTC+2) — the case that motivated the picker: dinner at 19:00
  // tapped after midnight is −5.5h, past every chip.
  const NOW = new Date("2026-08-05T22:30:00Z");

  it("starts where the chips stop and runs to the ceiling", () => {
    const hours = pickerHourOptions(NOW, TZ);
    expect(hours).toEqual([
      "22:00",
      "21:00",
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
    // The last chip reaches one hour back, so the first offered hour is one past it —
    // the picker never re-offers what a chip already covers, and the two offers stay
    // contiguous now that the chips only reach an hour (#2206).
    expect(PICKER_FIRST_HOURS_BACK).toBe(
      Math.ceil(Math.max(...CORRECTION_CHIP_MINUTES) / 60) + 1
    );
  });

  it("never offers the future, at any hour of the day", () => {
    for (const h of [0, 3, 9, 13, 21, 23]) {
      const now = new Date(`2026-08-05T${String(h).padStart(2, "0")}:30:00Z`);
      for (const hhmm of pickerHourOptions(now, TZ)) {
        expect(
          statedHourInstant(hhmm, now, TZ)!.getTime(),
          `${hhmm} at ${now.toISOString()}`
        ).toBeLessThanOrEqual(now.getTime());
      }
    }
  });

  it("resolves an hour later than now to YESTERDAY — the cross-midnight day rule", () => {
    // 00:30 local on the 6th; "20:00" is later than the current hour, so it means the
    // 5th at 20:00 — which is exactly how someone answers 'when did you eat' after
    // midnight, and what re-dates the serving.
    const inst = statedHourInstant("20:00", NOW, TZ)!;
    expect(inst.toISOString()).toBe("2026-08-05T18:00:00.000Z");
  });

  it("resolves an hour earlier than now to TODAY", () => {
    const now = new Date("2026-08-05T18:30:00Z"); // 20:30 local
    expect(statedHourInstant("16:00", now, TZ)!.toISOString()).toBe(
      "2026-08-05T14:00:00.000Z"
    );
  });

  it("is independent of the delay between rendering and tapping", () => {
    // THE PROPERTY THE RELATIVE FORM FAILS. A `−5h` button computes its offset at TAP
    // time, so hesitating two minutes lands two minutes off; an absolute hour cannot.
    const rendered = new Date("2026-08-05T18:30:00Z");
    const tapped = new Date("2026-08-05T18:32:00Z");
    expect(statedHourInstant("16:00", rendered, TZ)!.toISOString()).toBe(
      statedHourInstant("16:00", tapped, TZ)!.toISOString()
    );
  });

  it("refuses an hour that is no longer on offer", () => {
    // An instant-keyed domain: the burst bounds nothing, only the clock does.
    const burst = collapseBursts([tap(1, "2026-08-05T22:20:00Z")])[0];
    expect(isOfferedHour("20:00", burst, NOW, TZ)).toBe(true);
    // 00:00 is the hour just gone at 00:30 local — never offered, because the chips
    // cover the first hour. 11:00 is past the twelve-hour ceiling.
    expect(isOfferedHour("00:00", burst, NOW, TZ)).toBe(false);
    expect(isOfferedHour("11:00", burst, NOW, TZ)).toBe(false);
  });
});

describe("tokens — ids only, and the shapes both domains share", () => {
  it("round-trips a chip token and refuses an offset nobody offers", () => {
    const t = `${FOOD_TIME_PREFIXES.chip}:3:412:30`;
    expect(parseCorrectionChipToken(t, FOOD_TIME_PREFIXES.chip)).toEqual({
      profileId: 3,
      fromId: 412,
      minutesBack: 30,
    });
    // A forged offset is refused rather than clamped into something plausible — and so
    // is a retired one: 120 was a chip before #2206 dropped to two.
    expect(
      parseCorrectionChipToken(
        `${FOOD_TIME_PREFIXES.chip}:3:412:24000`,
        FOOD_TIME_PREFIXES.chip
      )
    ).toBeNull();
    expect(
      parseCorrectionChipToken(
        `${FOOD_TIME_PREFIXES.chip}:3:412:120`,
        FOOD_TIME_PREFIXES.chip
      )
    ).toBeNull();
    // A dose token is not a food token.
    expect(parseCorrectionChipToken(t, DOSE_TIME_PREFIXES.chip)).toBeNull();
  });

  it("round-trips the picker's steps, HH:MM colons and the day marker included", () => {
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
      step: { kind: "at", hhmm: "19:00", day: "today" },
    });
    // The day level's own step, and an hour QUALIFIED by the previous day (#3010) — the
    // marker rides the tail in front of the hour, which the rejoin already handles.
    expect(parseCorrectionAtToken(`${at}:3:412:prev`, at)).toEqual({
      profileId: 3,
      fromId: 412,
      step: { kind: "prev" },
    });
    expect(
      parseCorrectionAtToken(`${at}:3:412:p:2026-08-05:19:00`, at)
    ).toEqual({
      profileId: 3,
      fromId: 412,
      step: {
        kind: "at",
        hhmm: "19:00",
        day: "prev",
        date: "2026-08-05",
      },
    });
    expect(parseCorrectionAtToken(`${at}:3:412:29:00`, at)).toBeNull();
    expect(
      parseCorrectionAtToken(`${at}:3:412:p:2026-08-05:29:00`, at)
    ).toBeNull();
    // A day marker with no day is not a shape this grammar knows (#3010): the day is
    // spelled out so it can be COMPARED at tap time rather than re-resolved.
    expect(parseCorrectionAtToken(`${at}:3:412:p:19:00`, at)).toBeNull();
    expect(parseCorrectionAtToken(`${at}:3:412:q:19:00`, at)).toBeNull();
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
    expect(
      correctionTokenAnchor("food:3:Evening:2026-08-05:salmon", [
        DOSE_TIME_PREFIXES.chip,
        DOSE_TIME_PREFIXES.at,
      ])
    ).toBeNull();
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

  it("puts the named picker button first, then the two chips, on ONE row", () => {
    const actions = correctionActions(FOOD_TIME_PREFIXES, 3, bursts, TZ, NOW);
    // Absolute first, offset as context — the same vocabulary the picker speaks.
    expect(actions.map((a) => a.label)).toEqual([
      "🕐 ×2 21:02–21:08",
      "20:32 · −30m",
      "20:02 · −1h",
    ]);
    // One row key, so the three buttons render side by side.
    expect(new Set(actions.map((a) => a.row)).size).toBe(1);
    // The label button IS the picker's opener.
    expect(actions[0].data).toBe("foodtimeat:3:11:open");
    expect(actions[1].data).toBe("foodtime:3:11:30");
    expect(actions[2].data).toBe("foodtime:3:11:60");
  });

  it("states the STORED time and marks a corrected row (#2206 item 2)", () => {
    const corrections = correctionBursts(
      [corrected(11, "2026-08-05T19:02:00Z", "2026-08-05T18:02:00Z", "Salmon")],
      NOW
    );
    const actions = correctionActions(
      FOOD_TIME_PREFIXES,
      3,
      corrections,
      TZ,
      NOW
    );
    // 20:02 local, not the 21:02 it was tapped at — the chat states what the ledger
    // holds, and the marker says the tap time is no longer what this row means.
    expect(actions[0].label).toBe("🕐 Salmon 20:02 (corrected)");
    // And the chips count on from there: another hour back is 19:02, not 20:02 again.
    expect(actions.map((a) => a.label).slice(1)).toEqual([
      "19:32 · −30m",
      "19:02 · −1h",
    ]);
    // The re-render adds no button — the row is the same three it always was.
    expect(actions).toHaveLength(3);
  });

  it("leaves the picker as the only path once the chips hit the floor", () => {
    const deep = correctionBursts(
      [corrected(11, "2026-08-05T19:02:00Z", "2026-08-05T07:40:00Z", "Salmon")],
      NOW
    );
    const actions = correctionActions(FOOD_TIME_PREFIXES, 3, deep, TZ, NOW);
    expect(actions).toHaveLength(1);
    expect(actions[0].data).toBe("foodtimeat:3:11:open");
  });

  it("keys rows by anchor so two bursts never collapse onto one", () => {
    const two = correctionBursts(
      [tap(11, "2026-08-05T19:02:00Z"), tap(20, "2026-08-05T19:25:00Z")],
      NOW
    );
    const actions = correctionActions(FOOD_TIME_PREFIXES, 3, two, TZ, NOW);
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
      TZ,
      NOW
    ).map((a) => a.data!);
    expect(openPickerAnchor(chipTokens, FOOD_TIME_PREFIXES)).toBeNull();
  });
});

// ---- #2264: a correction row renders only on the message that produced it ----
//
// The burst carries its message provenance — shared by every member, since #3092
// partitions the grouping by it — and `burstsForMessage` is the one filter every render
// site applies: an attributed burst renders on its own message and nowhere else (the
// wrong-subject case fails closed — its chips would restamp servings the message never
// mentioned), while an unattributed burst (a web one-tap, an offline replay, a pruned
// message row) rides only the NEWEST live message of its domain, never an older one.
describe("message attribution (#2264, #3092)", () => {
  const NOW = new Date("2026-08-05T19:30:00Z");

  function tapFrom(id: number, iso: string, messageRef: number | null) {
    return { id, tapAt: iso, messageRef, label: "Salmon" };
  }

  // A burst is ONE MESSAGE'S ERROR (#3092, superseding #2264's cross-message clause):
  // two live dose reminders answered minutes apart are two errors, so `collapseBursts`
  // partitions by `messageRef` before the gap rule runs.
  it("keeps two taps minutes apart from two messages as TWO bursts, each carrying its own", () => {
    const bursts = collapseBursts([
      tapFrom(1, "2026-08-05T05:00:00Z", 41),
      tapFrom(2, "2026-08-05T05:05:00Z", 55),
    ]);
    expect(bursts).toHaveLength(2);
    expect(bursts[0].ids).toEqual([1]);
    expect(bursts[0].messageRef).toBe(41);
    expect(bursts[1].ids).toEqual([2]);
    expect(bursts[1].messageRef).toBe(55);
  });

  it("still collapses the same two taps when one message produced both", () => {
    const bursts = collapseBursts([
      tapFrom(1, "2026-08-05T05:00:00Z", 41),
      tapFrom(2, "2026-08-05T05:05:00Z", 41),
    ]);
    expect(bursts).toHaveLength(1);
    expect(bursts[0].ids).toEqual([1, 2]);
    expect(bursts[0].messageRef).toBe(41);
  });

  it("never joins an unattributed tap to an attributed one, in either order", () => {
    for (const [refA, refB] of [
      [41, null],
      [null, 41],
    ] as const) {
      const bursts = collapseBursts([
        tapFrom(1, "2026-08-05T05:00:00Z", refA),
        tapFrom(2, "2026-08-05T05:05:00Z", refB),
      ]);
      expect(bursts, `${refA} then ${refB}`).toHaveLength(2);
      expect(bursts[0].messageRef).toBe(refA);
      expect(bursts[1].messageRef).toBe(refB);
    }
  });

  it("groups taps interleaved A, B, A inside one window as TWO bursts, A's members together", () => {
    // Partition-then-gap, not flush-on-change: a flush-on-change rule would give three.
    const bursts = collapseBursts([
      tapFrom(1, "2026-08-05T05:00:00Z", 41),
      tapFrom(2, "2026-08-05T05:04:00Z", 55),
      tapFrom(3, "2026-08-05T05:08:00Z", 41),
    ]);
    expect(bursts).toHaveLength(2);
    const a = bursts.find((b) => b.messageRef === 41)!;
    const b = bursts.find((b) => b.messageRef === 55)!;
    expect(a.ids).toEqual([1, 3]);
    expect(b.ids).toEqual([2]);
  });

  it("re-sorts bursts ascending by tap start, so the newest-first cap picks the newest", () => {
    // Message 41's partition is enumerated first, but its second burst starts LAST —
    // concatenated partitions would leave it out of order and the cap would pick wrong.
    const events = [
      tapFrom(1, "2026-08-05T17:40:00Z", 41),
      tapFrom(2, "2026-08-05T18:00:00Z", 55),
      tapFrom(3, "2026-08-05T18:20:00Z", 41),
    ];
    const bursts = collapseBursts(events);
    expect(bursts.map((b) => b.fromId)).toEqual([1, 2, 3]);
    // All three are fresh; MAX_CORRECTION_ROWS = 2, so the profile-wide newest-first
    // cap takes exactly the two newest — across partitions.
    expect(
      correctionBursts(events, new Date("2026-08-05T18:30:00Z")).map(
        (b) => b.fromId
      )
    ).toEqual([3, 2]);
  });

  it("renders a burst on its own message and never on a sibling", () => {
    const bursts = collapseBursts([tapFrom(1, "2026-08-05T19:02:00Z", 41)]);
    expect(
      burstsForMessage(bursts, { messageRef: 41, isNewest: true })
    ).toHaveLength(1);
    expect(
      burstsForMessage(bursts, { messageRef: 41, isNewest: false })
    ).toHaveLength(1);
    // The sibling — even the NEWEST sibling — shows nothing: newest-ness is the
    // unattributed sub-rule, never a license to adopt a foreign burst.
    expect(
      burstsForMessage(bursts, { messageRef: 99, isNewest: true })
    ).toHaveLength(0);
    // A message with no pointer row at all fails closed.
    expect(
      burstsForMessage(bursts, { messageRef: null, isNewest: false })
    ).toHaveLength(0);
  });

  it("rides an unattributed burst on the newest live message only", () => {
    const bursts = collapseBursts([tapFrom(1, "2026-08-05T19:02:00Z", null)]);
    expect(
      burstsForMessage(bursts, { messageRef: 41, isNewest: true })
    ).toHaveLength(1);
    expect(FRESH_SEND_BINDING.isNewest).toBe(true);
    expect(burstsForMessage(bursts, FRESH_SEND_BINDING)).toHaveLength(1);
    // An OLDER message — the reported 7:30-shows-12:42 case — shows nothing.
    expect(
      burstsForMessage(bursts, { messageRef: 41, isNewest: false })
    ).toHaveLength(0);
  });

  it("filters BEFORE the cap, so a foreign burst cannot displace a message's own", () => {
    // Three fresh bursts: two foreign, one owned — the owned one is the OLDEST, so a
    // cap applied before the filter would have evicted it.
    const events = [
      tapFrom(1, "2026-08-05T18:40:00Z", 41),
      tapFrom(10, "2026-08-05T19:00:00Z", 99),
      tapFrom(20, "2026-08-05T19:20:00Z", 98),
    ];
    const own = correctionBursts(events, NOW, {
      messageRef: 41,
      isNewest: false,
    });
    expect(own).toHaveLength(1);
    expect(own[0].fromId).toBe(1);
    // And with no binding, the profile-wide set still caps at MAX_CORRECTION_ROWS.
    expect(correctionBursts(events, NOW)).toHaveLength(MAX_CORRECTION_ROWS);
  });

  it("a fresh send carries only the unattributed bursts", () => {
    const events = [
      tapFrom(1, "2026-08-05T19:00:00Z", 41),
      tapFrom(10, "2026-08-05T19:20:00Z", null),
    ];
    const fresh = correctionBursts(events, NOW, FRESH_SEND_BINDING);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].fromId).toBe(10);
  });

  it("an unattributed rider never displaces the message's own burst under the cap (#3092)", () => {
    // The message's own tap, then two web taps — three fresh bursts against a cap of
    // two. A plain newest-first cap would seat the two riders and drop the one claim
    // this message is actually about.
    const events = [
      tapFrom(1, "2026-08-05T19:00:00Z", 55),
      tapFrom(10, "2026-08-05T19:05:00Z", null),
      tapFrom(20, "2026-08-05T19:22:00Z", null),
    ];
    const rows = correctionBursts(events, NOW, {
      messageRef: 55,
      isNewest: true,
    });
    // The own burst keeps its row, the newest rider fills the other, and the seated
    // set still renders newest first.
    expect(rows.map((b) => b.fromId)).toEqual([20, 1]);
  });

  it("riders fill only the rows the message's own bursts leave", () => {
    const events = [
      tapFrom(1, "2026-08-05T18:50:00Z", 55),
      // 20 minutes later: past the gap, so a second own burst.
      tapFrom(2, "2026-08-05T19:10:00Z", 55),
      tapFrom(10, "2026-08-05T19:15:00Z", null),
    ];
    const rows = correctionBursts(events, NOW, {
      messageRef: 55,
      isNewest: true,
    });
    expect(rows.map((b) => b.fromId)).toEqual([2, 1]);
  });
});

// ---- #2264 bug 1: the body states the stored time ----------------------------
//
// The label button carries `×4 12:42 (corrected)` and Telegram clips it to `×4 12:4…`
// on a phone — so once a burst is corrected, the BODY becomes the statement of record.
// Built from the SAME burstLabel computation as the button, never a second phrasing,
// for both domains (the helper is domain-blind, like the whole module).
describe("correctionBodyStatement (#2264)", () => {
  const NOW = new Date("2026-08-05T19:30:00Z");

  it("says nothing while no burst is corrected — today's copy stands", () => {
    const bursts = correctionBursts([tap(1, "2026-08-05T19:02:00Z")], NOW);
    expect(correctionBodyStatement(bursts, TZ, NOW)).toBeNull();
  });

  it("names the stored instant of a corrected lone tap, via burstLabel", () => {
    const bursts = correctionBursts(
      [corrected(1, "2026-08-05T19:02:00Z", "2026-08-05T18:02:00Z", "Salmon")],
      NOW
    );
    const statement = correctionBodyStatement(bursts, TZ, NOW);
    expect(statement).toBe("🕐 Recorded: Salmon 20:02 (corrected)");
    // One computation: the sentence embeds exactly what the label button states.
    expect(statement).toContain(burstLabel(bursts[0], TZ, NOW));
  });

  it("covers the multi-burst case and skips the uncorrected sibling", () => {
    const bursts = correctionBursts(
      [
        corrected(1, "2026-08-05T18:50:00Z", "2026-08-05T17:50:00Z", "Salmon"),
        // 25 minutes later — a second burst, NOT corrected: it contributes nothing.
        tap(10, "2026-08-05T19:15:00Z", "Berries"),
      ],
      NOW
    );
    expect(bursts).toHaveLength(2);
    expect(correctionBodyStatement(bursts, TZ, NOW)).toBe(
      "🕐 Recorded: Salmon 19:50 (corrected)"
    );
  });

  it("joins two corrected bursts on one line, newest first (MAX_CORRECTION_ROWS)", () => {
    const bursts = correctionBursts(
      [
        corrected(1, "2026-08-05T18:50:00Z", "2026-08-05T17:50:00Z", "Salmon"),
        corrected(10, "2026-08-05T19:15:00Z", "2026-08-05T18:45:00Z", "Nuts"),
      ],
      NOW
    );
    expect(bursts).toHaveLength(MAX_CORRECTION_ROWS);
    expect(correctionBodyStatement(bursts, TZ, NOW)).toBe(
      "🕐 Recorded: Nuts 20:45 (corrected) · Salmon 19:50 (corrected)"
    );
  });

  it("states the DAY when the corrected instant is not today's (#3010)", () => {
    // A burst corrected to 18:00 YESTERDAY read `Leafy greens 18:00 (corrected)` on both
    // surfaces, which is this evening to anyone reading it. The day level makes a
    // day-crossing correction the normal case rather than a post-midnight edge, so the
    // half of the result that was unstated has to be stated (#2206).
    const bursts = correctionBursts(
      [
        corrected(
          1,
          "2026-08-05T19:02:00Z",
          "2026-08-04T16:00:00Z",
          "Leafy greens"
        ),
      ],
      NOW
    );
    expect(burstLabel(bursts[0], TZ, NOW)).toBe(
      "Leafy greens 18:00 yest (corrected)"
    );
    // And the #2264 statement of record says it too, from the same computation.
    expect(correctionBodyStatement(bursts, TZ, NOW)).toBe(
      "🕐 Recorded: Leafy greens 18:00 yest (corrected)"
    );
  });

  it("marks a day further back by its date rather than calling it yesterday", () => {
    // A domain whose reach exceeds one day (a dose's `occurred_at` can move as much as
    // 47h59m back) must not be told "yest" about the day before that.
    const bursts = correctionBursts(
      [
        corrected(
          1,
          "2026-08-05T19:02:00Z",
          "2026-08-03T16:00:00Z",
          "Ibuprofen"
        ),
      ],
      NOW
    );
    expect(burstLabel(bursts[0], TZ, NOW)).toBe(
      "Ibuprofen 18:00 08-03 (corrected)"
    );
  });

  it("speaks both domains' vocabularies unchanged — the labels are the bursts' own", () => {
    // A dose burst is the same shape with a dose label; the statement embeds
    // burstLabel verbatim either way, so the two chats cannot drift.
    const bursts = correctionBursts(
      [
        corrected(
          7,
          "2026-08-05T19:00:00Z",
          "2026-08-05T17:00:00Z",
          "Ibuprofen"
        ),
      ],
      NOW
    );
    expect(correctionBodyStatement(bursts, TZ, NOW)).toBe(
      `🕐 Recorded: ${burstLabel(bursts[0], TZ, NOW)}`
    );
  });
});

// ---- #2875: a DAY-KEYED domain may only be offered answers its own core accepts ----
//
// THE RENDER HALF of the cross-midnight refusal. `restampPracticeLogsCore` refuses an
// answer that lands on another profile-local day; the chips and the picker are shared,
// and THE DAY RULE they are built on does the opposite — "an offered hour LATER than the
// current local time is yesterday's". Left domain-blind, that combination shipped a
// keyboard whose buttons the write core was guaranteed to refuse: at 00:20 local BOTH
// chips ("23:50 · −30m", "23:20 · −1h") and every one of the eleven picker hours resolve
// to yesterday, which is 100% of the affordance dead in exactly the hour the stored time
// is most wrong. The write half was pinned when it shipped; this is the half that was not.
describe("a day-keyed domain's offers stay on the burst's own day (#2875)", () => {
  // A Berlin LOCAL wall time as an instant (UTC+2 in August), so the fixtures read as
  // the clock the user is looking at rather than as an offset done by hand.
  const local = (hhmm: string, day = 6) =>
    new Date(
      Date.UTC(2026, 7, day, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3))) -
        2 * 60 * 60_000
    );

  // A practice tap, which is a DAY-KEYED row: it carries the profile-local day the
  // ledger files it under, exactly as `getRecentPracticeTaps` reads it off
  // `practice_logs.date`. `day` defaults to the day the instant composes back to, which
  // is what an ordinary zone gives; the DST-at-midnight case below passes its own,
  // because that is precisely where the two stop agreeing.
  function practiceTap(
    id: number,
    at: Date,
    label = "Sauna",
    day = zonedDateParts(TZ, at).date
  ): TapEvent {
    return { id, tapAt: at.toISOString(), localDay: day, label };
  }

  // Resolve every offer a keyboard actually carries, exactly as the handler would.
  function resolvedDays(
    burst: ReturnType<typeof collapseBursts>[number],
    now: Date,
    prefixes: typeof PRACTICE_TIME_PREFIXES
  ): string[] {
    const days: string[] = [];
    for (const a of correctionActions(prefixes, 3, [burst], TZ, now)) {
      const chip = parseCorrectionChipToken(a.data, prefixes.chip);
      if (!chip) continue;
      const at = chipTarget({ tapAt: burst.atStartAt }, chip.minutesBack, now);
      expect(at, `chip ${a.label} resolved to nothing`).not.toBeNull();
      days.push(zonedDateParts(TZ, at!).date);
    }
    for (const a of correctionPickerActions(prefixes, 3, burst, now, TZ)) {
      const parsed = parseCorrectionAtToken(a.data, prefixes.at);
      if (parsed?.step.kind !== "at") continue;
      const at = statedHourInstant(parsed.step.hhmm, now, TZ);
      expect(at, `hour ${parsed.step.hhmm} resolved to nothing`).not.toBeNull();
      days.push(zonedDateParts(TZ, at!).date);
    }
    return days;
  }

  it("offers nothing at all in the hour after local midnight", () => {
    // The reproduction from the review, to the minute: a sauna tapped at 00:20 local.
    const now = local("00:25");
    const burst = collapseBursts([practiceTap(41, local("00:20"))])[0];

    const { shown, offScope } = correctableBursts(
      PRACTICE_TIME_PREFIXES,
      [burst],
      now,
      TZ
    );
    expect(shown).toEqual([]);
    expect(offScope).toEqual([burst]);

    // No row is drawn — not a label button, not a chip.
    expect(
      correctionActions(PRACTICE_TIME_PREFIXES, 3, [burst], TZ, now)
    ).toEqual([]);
    // And the body says where the correction belongs instead of staying silent.
    expect(correctionOffScopeStatement(offScope, TZ)).toBe(
      "🕐 Sauna — moving this would change its day — correct it in the app"
    );
  });

  it("leaves the two instant-keyed domains untouched at the same instant", () => {
    // The bound is the DOMAIN's, not the clock's: food re-dates the serving and dose
    // keeps its adherence day, so both still offer the full set here.
    const now = local("00:25");
    const burst = collapseBursts([
      tap(41, local("00:20").toISOString(), "Salmon"),
    ])[0];
    for (const prefixes of [FOOD_TIME_PREFIXES, DOSE_TIME_PREFIXES]) {
      expect(correctableBursts(prefixes, [burst], now, TZ).shown).toEqual([
        burst,
      ]);
      expect(
        correctionActions(prefixes, 3, [burst], TZ, now).map((a) => a.label)
      ).toEqual(["🕐 Salmon 00:20", "23:50 · −30m", "23:20 · −1h"]);
      // The recent hours, the `Yesterday →` step (#3010) and `↩︎ Back`.
      expect(correctionPickerActions(prefixes, 3, burst, now, TZ)).toHaveLength(
        pickerHourOptions(now, TZ).length + 2
      );
    }
  });

  it("never offers an answer on another day, at any hour of the day", () => {
    // THE PROPERTY, swept. Every chip and every picker hour a practice keyboard carries,
    // resolved the way the handler resolves it, lands on the day the row is filed under.
    for (const h of [0, 1, 2, 3, 6, 9, 12, 15, 18, 21, 23]) {
      for (const ageMin of [0, 12, 41, 58]) {
        const now = local(`${String(h).padStart(2, "0")}:37`);
        const tapAt = new Date(now.getTime() - ageMin * 60_000);
        const burst = collapseBursts([practiceTap(41, tapAt)])[0];
        const day = burstLocalDay(burst);
        expect(day, `burst at ${tapAt.toISOString()}`).not.toBeNull();
        for (const resolved of resolvedDays(
          burst,
          now,
          PRACTICE_TIME_PREFIXES
        )) {
          expect(resolved, `offer at ${now.toISOString()}`).toBe(day);
        }
      }
    }
  });

  it("offers a burst that straddles midnight nothing, because one instant cannot be two days", () => {
    // BURST_GAP_MIN collapses a 23:58 tap and a 00:03 tap into one burst, and a burst is
    // ONE error: the picker writes a single instant onto every row, and no single instant
    // is on both days.
    const now = local("00:20");
    const straddle = collapseBursts([
      practiceTap(41, local("23:58", 5)),
      practiceTap(42, local("00:03")),
    ])[0];
    expect(burstLocalDay(straddle)).toBeNull();
    expect(
      correctableBursts(PRACTICE_TIME_PREFIXES, [straddle], now, TZ).shown
    ).toEqual([]);
    expect(offeredHours(straddle, now, TZ, true)).toEqual([]);
    expect(chipOffers(straddle, now, TZ, true)).toEqual([]);
  });

  it("asks the picker's question honestly when the day leaves no hour to pick", () => {
    // Roughly 01:00–02:00 local: a −30m chip still stays on today, but the picker's own
    // reach starts two hours back and every hour it can name is yesterday's. The title
    // says so rather than presenting a grid of nothing.
    const now = local("01:40");
    const burst = collapseBursts([practiceTap(41, local("01:35"))])[0];
    expect(chipOffers(burst, now, TZ, true).map((o) => o.minutesBack)).toEqual([
      30, 60,
    ]);
    expect(offeredHours(burst, now, TZ, true)).toEqual([]);
    const picker = correctionPickerActions(
      PRACTICE_TIME_PREFIXES,
      3,
      burst,
      now,
      TZ
    );
    expect(picker.map((a) => a.label)).toEqual(["↩︎ Back"]);
    expect(correctionPickerTitle("when was this", burst, TZ, [])).toBe(
      "🕐 Sauna — no earlier hour left on this day — correct it in the app"
    );
    // A domain that always has hours passes none and asks its ordinary question.
    expect(correctionPickerTitle("when did you eat", burst, TZ)).toBe(
      "🕐 Sauna — when did you eat?"
    );
  });

  // ---- the bound reads the day the WRITE CORE enforces ----------------------
  //
  // `restampPracticeLogsCore` refuses on `zonedDateParts(tz, resolved).date !== row.date`
  // — the STORED COLUMN. Deriving the bound's day from the composed instant instead looks
  // equivalent and is not: `zonedWallTimeToUtc` cannot round-trip the day in a zone whose
  // DST starts at local midnight, because the first hour of that day never happens. Swept
  // across every IANA zone × 2024–2027, five zones do this — America/Havana,
  // America/Santiago, America/Asuncion, America/Coyhaique and Atlantic/Azores — and there
  // the composed day is YESTERDAY's while the core still enforces the column. Bounding by
  // the composed day therefore offers chips whose every tap answers "crosses-day": the
  // defect the bound exists to prevent, one derivation over.

  it("takes the burst's day from the stored column, not from the composed instant", () => {
    // Havana, 2026-03-08: the clock jumps 00:00 → 01:00, so "00:30" is a wall time that
    // date does not contain. The ledger still files the session under 2026-03-08 — the
    // string the core compares against — while the composed instant reads back as
    // 2026-03-07 23:30.
    const HAV = "America/Havana";
    const at = new Date("2026-03-08T04:30:00Z");
    expect(zonedDateParts(HAV, at).date).toBe("2026-03-07");

    const burst = collapseBursts([
      {
        id: 41,
        tapAt: at.toISOString(),
        localDay: "2026-03-08",
        label: "Sauna",
      },
    ])[0];
    expect(burstLocalDay(burst)).toBe("2026-03-08");

    // So every offer is dropped before it is drawn, because every one of them resolves
    // onto 2026-03-07 and the core would answer `crosses-day`.
    const now = new Date("2026-03-08T05:00:00Z");
    expect(chipOffers(burst, now, HAV, true)).toEqual([]);
    expect(offeredHours(burst, now, HAV, true)).toEqual([]);
    expect(
      correctionActions(PRACTICE_TIME_PREFIXES, 3, [burst], HAV, now)
    ).toEqual([]);
    expect(
      correctableBursts(PRACTICE_TIME_PREFIXES, [burst], now, HAV).offScope
    ).toEqual([burst]);
  });

  it("gives a burst whose members are filed under different days no day at all", () => {
    // Two stored days inside one BURST_GAP_MIN window — what `logPracticeSession`'s
    // backdated write produces. One correction cannot be two answers.
    const spread = collapseBursts([
      practiceTap(41, local("12:00")),
      practiceTap(42, local("12:05"), "Sauna", "2026-08-05"),
    ])[0];
    expect(spread.count).toBe(2);
    expect(burstLocalDay(spread)).toBeNull();
    expect(chipOffers(spread, local("12:10"), TZ, true)).toEqual([]);
  });

  it("refuses a burst that mixes an affected row with an ordinary one on the same filed day", () => {
    // The case that keeps ONE test against the earliest row exact. Both sessions are
    // filed under 2026-03-08; the first is filed at "00:45", an hour Havana skips, so it
    // composes to 03-07 23:45 while the second composes cleanly to 03-08 01:00. The
    // affected row is therefore the EARLIER instant, which is the row `chipStaysOnDay`
    // already tests — and the core refuses the whole burst for it.
    const HAV = "America/Havana";
    const burst = collapseBursts([
      {
        id: 41,
        tapAt: "2026-03-08T04:45:00Z",
        localDay: "2026-03-08",
        label: "",
      },
      {
        id: 42,
        tapAt: "2026-03-08T05:00:00Z",
        localDay: "2026-03-08",
        label: "",
      },
    ])[0];
    expect(burst.count).toBe(2);
    expect(burstLocalDay(burst)).toBe("2026-03-08");
    expect(zonedDateParts(HAV, new Date(burst.atStartAt)).date).toBe(
      "2026-03-07"
    );
    expect(
      chipOffers(burst, new Date("2026-03-08T05:30:00Z"), HAV, true)
    ).toEqual([]);
  });

  it("leaves an instant-keyed burst with no day, and offers it everything anyway", () => {
    // Food and dose file under no day at all, so the bound has nothing to read — and is
    // never consulted for them. `dayKeyed: false` is what guarantees that; a missing day
    // fails CLOSED, which would be the wrong answer for these two.
    const now = local("00:25");
    const burst = collapseBursts([
      tap(41, local("00:20").toISOString(), "Salmon"),
    ])[0];
    expect(burstLocalDay(burst)).toBeNull();
    expect(chipOffers(burst, now, TZ).map((o) => o.minutesBack)).toEqual([
      30, 60,
    ]);
    expect(chipOffers(burst, now, TZ, true)).toEqual([]);
  });
});

// ---- The DAY LEVEL (issue #3010) -------------------------------------------
//
// The picker was eleven hours measured from NOW, at every hour of the day, so at 08:00
// its floor was 20:00 yesterday and an 18:00 dinner could not be corrected the next
// morning at all. These are the pure half of the day + hour pair that fixes it.

describe("the picker's day level (#3010)", () => {
  // 08:00 local on 2026-08-06 — the owner's own instant: the morning after an 18:00
  // dinner, with the picker's old floor two hours short of it.
  const MORNING = new Date("2026-08-06T06:00:00Z");
  const morningBurst = collapseBursts([
    tap(41, "2026-08-06T05:55:00Z", "Salmon"),
  ])[0];

  it("THE REPORT: 18:00 yesterday is reachable at 08:00, and was not before", () => {
    // Level one is where it always was — eleven hours, floor 20:00 yesterday.
    expect(pickerHourOptions(MORNING, TZ)).toHaveLength(11);
    expect(pickerHourOptions(MORNING, TZ)).not.toContain("18:00");
    // Level two reaches it, and resolves it to the instant the dinner actually happened.
    expect(offeredHours(morningBurst, MORNING, TZ, false, "prev")).toContain(
      "18:00"
    );
    expect(
      offeredHourInstant("18:00", "prev", MORNING, TZ)?.toISOString()
    ).toBe("2026-08-05T16:00:00.000Z");
  });

  it("level one is unchanged and carries the step down to yesterday", () => {
    const actions = correctionPickerActions(
      FOOD_TIME_PREFIXES,
      3,
      morningBurst,
      MORNING,
      TZ
    );
    const hourTokens = actions
      .map((a) => a.data)
      .filter((d) => /:\d\d:00$/.test(String(d)) && !String(d).includes(":p:"));
    // Exactly the hours it offered before, in the same order.
    expect(
      actions.slice(0, 11).map((a) => String(a.label).replace(" yest", ""))
    ).toEqual(pickerHourOptions(MORNING, TZ));
    expect(hourTokens).toHaveLength(11);
    // Plus one Yesterday step, and Back last.
    expect(actions.map((a) => a.data)).toContain(
      `${FOOD_TIME_PREFIXES.at}:3:41:prev`
    );
    expect(actions[actions.length - 1].label).toContain("Back");
  });

  // ONE ROUTE TO EACH INSTANT (#3060 §3): level two is yesterday's `statedHoursOnDate`
  // — the web sheet's own enumeration — MINUS the instants level one already offers,
  // deduplicated by resolved instant. The two levels' instant sets are disjoint and
  // their union reaches every legal previous-day hour exactly once.
  const levelInstants = (now: Date, tz: string) => {
    const one = pickerHourOptions(now, tz).map((h) =>
      statedHourInstant(h, now, tz)!.toISOString()
    );
    const two = pickerPrevDayHourOptions(now, tz).map((h) =>
      offeredHourInstant(h, "prev", now, tz)!.toISOString()
    );
    return { one, two };
  };

  it("level two is yesterday minus what level one reaches, newest first", () => {
    const yesterday = statedHoursOnDate("2026-08-05", TZ, MORNING).map(
      (o) => o.hhmm
    );
    expect(yesterday).toHaveLength(24);
    // At 08:00 level one's tail is 23:00–20:00 yesterday; level two starts under it.
    expect(pickerPrevDayHourOptions(MORNING, TZ)).toEqual(
      [...yesterday].reverse().slice(4)
    );
    expect(pickerPrevDayHourOptions(MORNING, TZ)[0]).toBe("19:00");
    expect(offeredHours(morningBurst, MORNING, TZ, false, "prev")).toEqual(
      pickerPrevDayHourOptions(MORNING, TZ)
    );
  });

  it.each([
    // [label, now (UTC), tz] — the DST fixtures are where "HH:MM" and an instant part ways.
    ["08:00 Berlin, the owner's morning", MORNING, TZ],
    [
      "00:30 Berlin, level one entirely yesterday",
      new Date("2026-08-05T22:30:00Z"),
      TZ,
    ],
    [
      "10:00 New York on the fall-back day",
      new Date("2026-11-01T15:00:00Z"),
      "America/New_York",
    ],
    [
      "10:00 New York the day after fall-back",
      new Date("2026-11-02T15:00:00Z"),
      "America/New_York",
    ],
    [
      "10:00 New York the day after spring-forward",
      new Date("2026-03-09T14:00:00Z"),
      "America/New_York",
    ],
  ] as const)(
    "the two levels' instants are disjoint and jointly cover yesterday once — %s",
    (_label, now, tz) => {
      const { one, two } = levelInstants(now, tz);
      expect(new Set(two).size).toBe(two.length);
      expect(two.filter((iso) => one.includes(iso))).toEqual([]);
      // Every legal previous-day instant is reachable, on exactly one level.
      const prevDay = statedHoursOnDate(
        correctionDayDate("prev", now, tz),
        tz,
        now
      );
      for (const o of prevDay) {
        expect(
          Number(one.includes(o.iso)) + Number(two.includes(o.iso)),
          `${o.hhmm} ${o.iso}`
        ).toBe(1);
      }
    }
  );

  it("dedupes by INSTANT: on a fall-back day level one's 01:00 is today's, so yesterday's 01:00 stays", () => {
    const now = new Date("2026-11-01T15:00:00Z"); // 10:00 EST, fall-back day
    const NY = "America/New_York";
    expect(pickerHourOptions(now, NY)).toContain("01:00");
    // Yesterday's 01:00 is a different instant from anything level one offers, and a
    // wall-clock comparison would have dropped it.
    expect(pickerPrevDayHourOptions(now, NY)).toContain("01:00");
    // While 23:00 yesterday IS level one's floor, and is dropped.
    expect(pickerHourOptions(now, NY)).toContain("23:00");
    expect(pickerPrevDayHourOptions(now, NY)).not.toContain("23:00");
  });

  it("labels the hours that fall on a previous day, and only those", () => {
    const labelled = pickerHourOptions(MORNING, TZ).map((h) => ({
      h,
      label: pickerHourLabel(h, "today", MORNING, TZ),
    }));
    // At 08:00 the grid runs 06:00…02:00 (today) then 23:00…20:00 (YESTERDAY), and the
    // two halves used to be formatted identically.
    for (const { h, label } of labelled) {
      const today = Number(h.slice(0, 2)) <= 6;
      expect(label, h).toBe(today ? h : `${h} yest`);
    }
    // Level two's buttons say it too — each button states its own result (#2206).
    expect(pickerHourLabel("18:00", "prev", MORNING, TZ)).toBe("18:00 yest");
  });

  it("a day-qualified hour round-trips through the encoder and the parser", () => {
    const at = FOOD_TIME_PREFIXES.at;
    const token = correctionAtToken(at, 3, 41, {
      kind: "at",
      hhmm: "18:00",
      day: "prev",
      date: "2026-08-05",
    });
    expect(token).toBe(`${at}:3:41:p:2026-08-05:18:00`);
    expect(parseCorrectionAtToken(token, at)).toEqual({
      profileId: 3,
      fromId: 41,
      step: { kind: "at", hhmm: "18:00", day: "prev", date: "2026-08-05" },
    });
    // Still inside Telegram's 64-byte callback budget at realistic ids.
    expect(
      Buffer.byteLength(`${at}:999999:99999999:p:2026-08-05:18:00`, "utf8")
    ).toBeLessThanOrEqual(64);
    // A day marker with no date is not a shape this grammar knows.
    expect(parseCorrectionAtToken(`${at}:3:41:p:18:00`, at)).toBeNull();
    expect(
      parseCorrectionAtToken(`${at}:3:41:p:2026-8-5:18:00`, at)
    ).toBeNull();
  });

  it("a `p:` token whose LOCAL DAY HAS ROLLED is refused — the 24-hour drift (#3010)", () => {
    // Level two means "the day before now". A token minted at 23:55 for 20:00 yesterday
    // named 2026-08-04; ten minutes later it is a new local day, and a marker carrying
    // no date would re-resolve onto 2026-08-05 — a FULL 24 HOURS on, in the PAST, so
    // `judgeStatedAt`'s no-future refusal cannot catch it.
    const beforeMidnight = new Date("2026-08-05T21:55:00Z"); // 23:55 local
    const afterMidnight = new Date("2026-08-05T22:05:00Z"); // 00:05 local, next day
    const lateBurst = collapseBursts([
      {
        id: 41,
        tapAt: "2026-08-05T21:50:00Z",
        localDay: "2026-08-05",
        label: "Berries",
      },
    ])[0];

    // The instants the same wall time resolves to on either side of midnight: exactly
    // 24 hours apart, which is the size of the drift.
    const named = offeredHourInstant("20:00", "prev", beforeMidnight, TZ)!;
    const rolled = offeredHourInstant("20:00", "prev", afterMidnight, TZ)!;
    expect(rolled.getTime() - named.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(rolled.getTime()).toBeLessThan(afterMidnight.getTime());

    // Offered when the token was minted…
    expect(
      isOfferedHour(
        "20:00",
        lateBurst,
        beforeMidnight,
        TZ,
        false,
        "prev",
        "2026-08-04"
      )
    ).toBe(true);
    // …and refused ten minutes later, because level two is no longer showing that day.
    expect(
      isOfferedHour(
        "20:00",
        lateBurst,
        afterMidnight,
        TZ,
        false,
        "prev",
        "2026-08-04"
      )
    ).toBe(false);
    // The day it IS showing is accepted, so the refusal is about the roll and not about
    // the hour. At 00:05 level one itself reaches 20:00 yesterday (THE DAY RULE), so
    // level two no longer offers it (#3060 §3); 10:00 sits under level one's floor.
    expect(
      isOfferedHour(
        "10:00",
        lateBurst,
        afterMidnight,
        TZ,
        false,
        "prev",
        "2026-08-05"
      )
    ).toBe(true);
  });

  it("the handler admits exactly the day-qualified set the keyboard rendered", () => {
    // Every rendered button, re-derived the way the handler re-derives it — including
    // the day each level-two button was stamped with.
    const prevDate = correctionDayDate("prev", MORNING, TZ);
    for (const level of ["today", "prev"] as const) {
      for (const hhmm of offeredHours(
        morningBurst,
        MORNING,
        TZ,
        false,
        level
      )) {
        expect(
          isOfferedHour(
            hhmm,
            morningBurst,
            MORNING,
            TZ,
            false,
            level,
            level === "prev" ? prevDate : null
          ),
          `${level} ${hhmm}`
        ).toBe(true);
      }
    }
    // An hour legal on the OTHER level is refused on this one: 07:00 is in the future
    // today (so level one never offered it) and legal yesterday.
    expect(isOfferedHour("07:00", morningBurst, MORNING, TZ, false)).toBe(
      false
    );
    expect(
      isOfferedHour("07:00", morningBurst, MORNING, TZ, false, "prev", prevDate)
    ).toBe(true);
    // And a day marker cannot smuggle an hour past the FUTURE bound: level two is a
    // complete past day, so there is no hour it can reach that has not happened.
    for (const hhmm of offeredHours(morningBurst, MORNING, TZ, false, "prev")) {
      const at = offeredHourInstant(hhmm, "prev", MORNING, TZ);
      expect(at, hhmm).not.toBeNull();
      expect(at!.getTime(), hhmm).toBeLessThan(MORNING.getTime());
    }
  });

  it("both instant-keyed prefix families get the level together (#2020)", () => {
    for (const prefixes of [FOOD_TIME_PREFIXES, DOSE_TIME_PREFIXES]) {
      const tokens = correctionPickerActions(
        prefixes,
        3,
        morningBurst,
        MORNING,
        TZ
      ).map((a) => String(a.data));
      expect(tokens, prefixes.at).toContain(`${prefixes.at}:3:41:prev`);
      // Yesterday's 24 hours less the four level one already reaches at 08:00 (#3060 §3).
      expect(
        correctionPickerActions(prefixes, 3, morningBurst, MORNING, TZ, "prev")
          .map((a) => String(a.data))
          .filter((d) => d.includes(":p:")),
        prefixes.at
      ).toHaveLength(20);
    }
  });

  it("a DAY-KEYED domain is offered no yesterday step for a burst filed today (#2875)", () => {
    // The practice write core refuses an answer on another day, so level two has nothing
    // to give a session filed under today — and the step is simply not drawn. No special
    // case: the domain bound already answered.
    const practiceBurst = collapseBursts([
      {
        id: 41,
        tapAt: "2026-08-06T05:55:00Z",
        localDay: "2026-08-06",
        label: "Sauna",
      },
    ])[0];
    expect(offeredHours(practiceBurst, MORNING, TZ, true, "prev")).toHaveLength(
      0
    );
    expect(
      correctionPickerActions(
        PRACTICE_TIME_PREFIXES,
        3,
        practiceBurst,
        MORNING,
        TZ
      ).map((a) => String(a.data))
    ).not.toContain(`${PRACTICE_TIME_PREFIXES.at}:3:41:prev`);

    // The instant-keyed domains at the same instant, for contrast: they ABSORB the
    // crossing, so the same burst does get the step.
    expect(
      correctionPickerActions(
        FOOD_TIME_PREFIXES,
        3,
        practiceBurst,
        MORNING,
        TZ
      ).map((a) => String(a.data))
    ).toContain(`${FOOD_TIME_PREFIXES.at}:3:41:prev`);
  });
});
