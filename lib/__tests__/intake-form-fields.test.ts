import { describe, expect, it } from "vitest";
import {
  emptyIntakeItemFormState,
  intakeItemFields,
  intakeItemFormData,
  intakeItemFormStateFrom,
  parseIntakeDoses,
  parseIntakeIngredients,
  parseIntakePairs,
  parseIntakePurposes,
  type IntakeItemFormState,
} from "@/lib/intake-form-fields";
import type { IntakeDose, IntakeItem, MedicationCourse } from "@/lib/types";

// The one write mapping (#3216), and the invariant the merge is most likely to break
// silently: THE FORM POSTS WHOLE. The merged form shows one editor at a time, so a
// value seeded into a fact whose editor was never opened must still reach the action.
// It does, structurally: this mapping is a pure function of the state and is never
// told which editor was open.

function med(over: Partial<IntakeItemFormState> = {}): IntakeItemFormState {
  return { ...emptyIntakeItemFormState("medication"), ...over };
}

function value(state: IntakeItemFormState, key: string): string | null {
  const hit = intakeItemFields(state).find(([k]) => k === key);
  return hit ? hit[1] : null;
}

describe("intake form field mapping (#3216)", () => {
  it("posts every seeded fact, whatever the person opened", () => {
    // The two-tap path: a pick seeded these, the person opened NO editor, pressed Add.
    const state = med({
      name: "Ibuprofen",
      brand: "Advil",
      obligation: "may",
      minIntervalHours: "6",
      maxDailyCount: "4",
      notes: "half a tablet on bad days",
      doses: [
        {
          amount: "200 mg",
          time_of_day: "",
          food_timing: "with_food",
          weekdays: [],
          start_date: "",
          end_date: "",
        },
      ],
    });
    expect(value(state, "name")).toBe("Ibuprofen");
    expect(value(state, "brand")).toBe("Advil");
    expect(value(state, "min_interval_hours")).toBe("6");
    expect(value(state, "max_daily_count")).toBe("4");
    expect(value(state, "notes")).toBe("half a tablet on bad days");
    expect(JSON.parse(value(state, "doses") ?? "[]")[0]).toMatchObject({
      amount: "200 mg",
      food_timing: "with_food",
    });
  });

  it("writes a CLEARED optional as a blank rather than omitting it", () => {
    // Omission and blank are the same to the action for a new item, but not for an
    // edit: clearing a note has to reach the action as an empty string or the old
    // note survives a save that looked like it removed it.
    const state = med({ id: 12, notes: "" });
    expect(value(state, "notes")).toBe("");
  });

  it("the redose trio is a PRN medication's only, so a flip cannot leave one armed", () => {
    const scheduled = med({
      obligation: "must",
      minIntervalHours: "6",
      maxDailyCount: "4",
      redoseNotice: true,
    });
    expect(value(scheduled, "min_interval_hours")).toBeNull();
    expect(value(scheduled, "max_daily_count")).toBeNull();
    expect(value(scheduled, "redose_notice")).toBeNull();
  });

  it("the redose opt-in needs BOTH confirmed numbers", () => {
    const half = med({
      obligation: "may",
      minIntervalHours: "6",
      redoseNotice: true,
    });
    expect(value(half, "redose_notice")).toBeNull();
    const both = med({
      obligation: "may",
      minIntervalHours: "6",
      maxDailyCount: "4",
      redoseNotice: true,
    });
    expect(value(both, "redose_notice")).toBe("1");
  });

  it("keeps kind-specific fields apart while posting shared child rows", () => {
    const supp: IntakeItemFormState = {
      ...emptyIntakeItemFormState("supplement"),
      prescriber: "Dr. Rivera",
      rx: true,
      stack: "D3 + K2",
    };
    expect(value(supp, "prescriber")).toBeNull();
    expect(value(supp, "rx")).toBeNull();
    // The stack stays supplement-only; composition and purpose rows belong to either
    // kind so an edit can preserve, change, or clear them after a flip (#3649).
    expect(value(supp, "stack")).toBe("D3 + K2");
    expect(value(supp, "ingredients")).toBe("[]");
    const flipped = med({
      ingredients: [{ name: "Zinc", amount: "5 mg" }],
      purposes: [{ kind: "goal", goalKey: "immunity" }],
    });
    expect(value(flipped, "stack")).toBeNull();
    expect(JSON.parse(value(flipped, "ingredients")!)).toEqual(
      flipped.ingredients
    );
    expect(JSON.parse(value(flipped, "purposes")!)).toEqual(flipped.purposes);
  });

  it("the situation only rides along while the condition is situational", () => {
    expect(
      value(med({ condition: "daily", situation: "Illness" }), "situation")
    ).toBe("");
    expect(
      value(
        med({ condition: "situational", situation: "Illness" }),
        "situation"
      )
    ).toBe("Illness");
  });

  it("ingredient CUIs are coupled to the code, so a cleared code strands nothing", () => {
    const withCode = med({ rxcui: "1234", rxcuiIngredients: ["5678"] });
    expect(value(withCode, "rxcui_ingredients")).toContain("5678");
    const cleared = med({ rxcui: "", rxcuiIngredients: ["5678"] });
    expect(value(cleared, "rxcui_ingredients")).toBe("");
  });

  it("escalation numbers ride only for a critical item", () => {
    expect(
      value(
        med({ critical: false, escalateAfterMin: "120" }),
        "escalate_after_min"
      )
    ).toBeNull();
    expect(
      value(
        med({ critical: true, escalateAfterMin: "120" }),
        "escalate_after_min"
      )
    ).toBe("120");
  });

  it("qty per dose never reaches the action as zero", () => {
    // Days-of-supply divides by it.
    expect(value(med({ qtyPerDose: "" }), "qty_per_dose")).toBe("1");
  });

  it("an id is posted only when there is one to update", () => {
    expect(value(med(), "id")).toBeNull();
    expect(value(med({ id: 7 }), "id")).toBe("7");
    // The stop date is an edit-only concept — a course cannot be retired before it
    // is opened.
    expect(value(med({ endDate: "2026-08-19" }), "end_date")).toBeNull();
    expect(value(med({ id: 7, endDate: "2026-08-19" }), "end_date")).toBe(
      "2026-08-19"
    );
  });

  it("the FormData carries exactly the mapped entries", () => {
    const state = med({ name: "Ibuprofen" });
    const fd = intakeItemFormData(state);
    for (const [k, v] of intakeItemFields(state)) expect(fd.get(k)).toBe(v);
  });
});

// ── The ONE seeding (#4664) ──────────────────────────────────────────────────
//
// `intakeItemFormStateFrom` replaces 29 inline `item?.…` expressions, one per
// `useState`, in components/IntakeItemForm.tsx. A field the type gained and this
// forgot is seeded BLANK on an edit — the person opens their medication and a fact
// they entered is not there — and the old arrangement had no place to notice.
//
// SO THE FIRST TEST IS A CENSUS, NOT A SAMPLE. It walks the state's own keys and
// requires each to have moved off the blank for a row that states every one of them,
// which is the only form of this test that a 41st field cannot walk past.

/** A stored row with EVERY column this form reads set to something non-blank. */
const FULL_ROW = {
  id: 42,
  name: "Ibuprofen",
  notes: "half a tablet on bad days",
  active: 1,
  created_at: "2026-01-01T00:00:00.000Z",
  condition: "situational",
  obligation: "may",
  brand: "Advil",
  product: "Liqui-Gels",
  situation: "a migraine",
  situation_id: null,
  pause_situation: "a stomach bug",
  pause_situation_id: null,
  stack: "Evening stack",
  critical: 1,
  escalate_after_min: 45,
  escalate_chat_id: "chat-9",
  quantity_on_hand: 30,
  qty_per_dose: 2,
  supply_id: 11,
  supply_name: "The household ibuprofen",
  last_fill_size: null,
  kind: "medication",
  prescriber: "Dr. Rivera",
  pharmacy: "Walgreens #1234",
  rx_number: "RX7654321",
  rx: 1,
  min_interval_hours: 6,
  max_daily_count: 4,
  max_daily_amount_mg: 1200,
  redose_notice: 1,
  rxcui: "5640",
  rxcui_ingredients: '["5640"]',
  document_id: null,
  source: null,
  source_name: null,
  provider_id: 8,
  provider_name: "Sample Care East",
  source_record_id: null,
  indication_condition_id: 3,
  indication_condition_name: "Migraine",
  cadence_kind: "weekly",
  cadence_weekdays: "4,1",
  cadence_interval_days: 3,
  cadence_anchor_date: "2026-02-02",
} as unknown as IntakeItem;

const FULL_DOSE = {
  id: 5,
  amount: "200 mg",
  time_of_day: "Morning",
  food_timing: "with_food",
  weekdays: "6,2",
  start_date: "2026-03-01",
  end_date: "2026-04-01",
} as unknown as IntakeDose;

describe("the one intake seeding (#4664)", () => {
  const seeded = intakeItemFormStateFrom({
    kind: "medication",
    item: FULL_ROW,
    course: {
      id: 77,
      started_on: "2026-01-15",
      stopped_on: "2026-05-05",
    } as MedicationCourse,
    todayStr: "2026-09-04",
    doses: [FULL_DOSE],
    ingredients: [{ name: "Ibuprofen", amount: "200 mg" }],
    purposes: [{ kind: "condition", conditionId: 3 }],
    pairs: [{ otherId: 7, relation: "separate", note: "2 hours apart" }],
  });

  // THE FLOOR. The census below is generated from the state's own keys, and a walk of
  // an empty list is a green test that asserted nothing. Forty fields today; this
  // number moves when someone adds a field AND states it in FULL_ROW.
  it("walks all forty fields", () => {
    expect(Object.keys(seeded).length).toBe(40);
  });

  it("leaves no field of a fully-stated row on its blank", () => {
    const blank = emptyIntakeItemFormState("medication") as unknown as Record<
      string,
      unknown
    >;
    // `kind` is the ONE field a row cannot move off its blank: the door locks it, and
    // the blank is built for that same kind. Everything else must have been read.
    const exempt = new Set(["kind"]);
    const stillBlank = Object.entries(
      seeded as unknown as Record<string, unknown>
    )
      .filter(([key]) => !exempt.has(key))
      .filter(([key, v]) => JSON.stringify(v) === JSON.stringify(blank[key]))
      .map(([key]) => key);
    expect(stillBlank).toEqual([]);
  });

  it("reads the row's own facts back, not a re-derivation of them", () => {
    expect(seeded.id).toBe(42);
    expect(seeded.name).toBe("Ibuprofen");
    expect(seeded.critical).toBe(true);
    expect(seeded.rx).toBe(true);
    expect(seeded.redoseNotice).toBe(true);
    expect(seeded.escalateAfterMin).toBe("45");
    expect(seeded.indicationConditionId).toBe("3");
    expect(seeded.providerId).toBe(8);
    expect(seeded.provider).toBe("Sample Care East");
    // What the form LOADED, for the action's concurrency check.
    expect(seeded.providerLoaded).toBe("Sample Care East");
    expect(seeded.quantityOnHand).toBe("30");
    expect(seeded.quantityOnHandLoaded).toBe("30");
    expect(seeded.qtyPerDose).toBe("2");
    expect(seeded.supplyId).toBe("11");
    expect(seeded.rxcuiIngredients).toEqual(["5640"]);
    // Weekday sets are stored as CSV in either order and read back SORTED, on the
    // item's cadence and on each dose row alike.
    expect(seeded.cadence).toEqual({
      kind: "weekly",
      weekdays: [1, 4],
      intervalDays: "3",
      anchorDate: "2026-02-02",
    });
    expect(seeded.doses).toEqual([
      {
        id: 5,
        amount: "200 mg",
        time_of_day: "Morning",
        food_timing: "with_food",
        weekdays: [2, 6],
        start_date: "2026-03-01",
        end_date: "2026-04-01",
      },
    ]);
  });

  it("takes the course's window over the row's own dates", () => {
    expect(seeded.courseId).toBe(77);
    expect(seeded.startedOn).toBe("2026-01-15");
    expect(seeded.endDate).toBe("2026-05-05");
  });

  it("starts a new scheduled item today, and an as-needed one with no date", () => {
    const scheduled = intakeItemFormStateFrom({
      kind: "medication",
      todayStr: "2026-09-04",
    });
    expect(scheduled.startedOn).toBe("2026-09-04");
    expect(scheduled.obligation).toBe("must");
    // An as-needed item has no start date to volunteer, so it does not invent one.
    const prn = intakeItemFormStateFrom({
      kind: "medication",
      item: { ...FULL_ROW, obligation: "may" },
      todayStr: "2026-09-04",
    });
    expect(prn.startedOn).toBe("");
  });

  it("lets a picked bottle answer the name, the strength and the link", () => {
    const fromBottle = intakeItemFormStateFrom({
      kind: "supplement",
      supply: {
        id: 11,
        name: "Vitamin D3",
        strength: "5000 IU",
        form: "capsule",
        siblingKind: "supplement",
      },
    });
    expect(fromBottle.name).toBe("Vitamin D3");
    expect(fromBottle.doses[0].amount).toBe("5000 IU");
    expect(fromBottle.supplyId).toBe("11");
    // The kind's own default posture, not the medication one.
    expect(fromBottle.obligation).toBe("should");
  });

  it("seeds a create from the blank for the kind", () => {
    expect(intakeItemFormStateFrom({ kind: "supplement" })).toEqual({
      ...emptyIntakeItemFormState("supplement"),
      id: null,
      courseId: null,
      providerId: null,
    });
  });
});

// THE PAYLOAD ROUND TRIP (#4666). Four fields ride as JSON, and their parse used to
// live in the action module behind `(p as any)`. One parse each, here, so what the
// drafts above write is read back by something a test can drive without a database.
describe("intake JSON payload parsing (#4666)", () => {
  const post = (key: string, value: unknown): FormData => {
    const fd = new FormData();
    fd.set(key, JSON.stringify(value));
    return fd;
  };

  it("reads back what the form's own mapping wrote", () => {
    // The mapping is the only writer of these four, so the round trip is the claim.
    const fd = intakeItemFormData(
      med({
        doses: [
          {
            amount: "200 mg",
            time_of_day: "08:00",
            food_timing: "with_food",
            weekdays: [3, 1],
            start_date: "2026-03-01",
            end_date: "",
          },
        ],
        pairs: [{ otherId: 7, relation: "separate", note: "two hours apart" }],
        ingredients: [{ name: "Magnesium", amount: "200 mg" }],
        purposes: [{ kind: "goal", goalKey: "sleep" }],
      })
    );
    expect(parseIntakeDoses(fd)).toEqual([
      {
        id: undefined,
        amount: "200 mg",
        time_of_day: "08:00",
        food_timing: "with_food",
        // normalizeWeekdays canonicalizes the order, so a no-op edit never reads as
        // a change.
        weekdays: "1,3",
        start_date: "2026-03-01",
        end_date: null,
      },
    ]);
    expect(parseIntakePairs(fd)).toEqual([
      { otherId: 7, relation: "separate", note: "two hours apart" },
    ]);
    const ingredients = parseIntakeIngredients(fd);
    expect(ingredients?.ok).toBe(true);
    expect(ingredients?.ok && ingredients.rows[0].name).toBe("Magnesium");
    expect(parseIntakePurposes(fd)).toEqual([
      {
        kind: "goal",
        goal_key: "sleep",
        condition_id: null,
        biomarker_key: null,
        direction: null,
      },
    ]);
  });

  // Untrusted client text at a write boundary: every malformed payload has to degrade
  // to "nothing submitted", and nothing here may throw.
  it.each([
    ["not JSON at all", "{oh no"],
    ["a JSON scalar", "42"],
    ["an object where an array belongs", '{"amount":"1 g"}'],
    ["rows that are not objects", '[1,"two",null]'],
  ])("survives %s", (_label, raw) => {
    const fd = new FormData();
    for (const key of ["doses", "pairs", "ingredients", "purposes"])
      fd.set(key, raw);
    // A dose is always returned so an item is never left without a schedule entry.
    expect(parseIntakeDoses(fd)).toEqual([
      {
        amount: null,
        time_of_day: null,
        food_timing: "any",
        weekdays: null,
        start_date: null,
        end_date: null,
      },
    ]);
    expect(parseIntakePairs(fd)).toEqual([]);
    expect(parseIntakeIngredients(fd)).toEqual({ ok: true, rows: [] });
    expect(parseIntakePurposes(fd)).toEqual([]);
  });

  it.each([
    ["an unreadable food timing falls back", { food_timing: "midair" }, "any"],
    ["a real one is kept", { food_timing: "with_fat" }, "with_fat"],
  ])("%s", (_label, over, expected) => {
    expect(parseIntakeDoses(post("doses", [over]))[0].food_timing).toBe(
      expected
    );
  });

  it.each([
    ["a malformed window is dropped", "2026-02-30", null],
    ["a non-date is dropped", "soon", null],
    ["a real day is kept", "2026-02-28", "2026-02-28"],
  ])("%s", (_label, raw, expected) => {
    expect(
      parseIntakeDoses(post("doses", [{ start_date: raw }]))[0].start_date
    ).toBe(expected);
  });

  it("drops a pair with no other item, and defaults an unknown relation", () => {
    expect(
      parseIntakePairs(
        post("pairs", [
          { otherId: 0, relation: "with" },
          { otherId: "9", relation: "sideways" },
        ])
      )
    ).toEqual([{ otherId: 9, relation: "separate", note: null }]);
  });

  // ABSENT MEANS UNCHANGED for the two child sets: a form that does not render the
  // control posts nothing, and must not clear what is stored. An explicit empty array
  // from a form that DOES render it still clears every row.
  it.each([
    ["ingredients", parseIntakeIngredients, { ok: true, rows: [] }],
    ["purposes", parseIntakePurposes, []],
  ])("%s: absent is null, empty is a clear", (key, parse, empty) => {
    expect(parse(new FormData())).toBeNull();
    expect(parse(post(key, []))).toEqual(empty);
  });

  it("refuses a save whose ingredient amount cannot be read", () => {
    const bad = parseIntakeIngredients(
      post("ingredients", [{ name: "Niacin", amount: "1,000 mg or so" }])
    );
    expect(bad).toEqual({
      ok: false,
      name: "Niacin",
      amountText: "1,000 mg or so",
    });
  });

  it("keeps every purpose variant, and drops a row that names none", () => {
    expect(
      parseIntakePurposes(
        post("purposes", [
          { kind: "goal", goalKey: "sleep" },
          { kind: "condition", conditionId: 4 },
          { kind: "biomarker", biomarkerKey: "ferritin", direction: "low" },
          { kind: "biomarker", biomarkerKey: "b12", direction: "sideways" },
          { kind: "whatever", goalKey: "sleep" },
        ])
      )
    ).toEqual([
      {
        kind: "goal",
        goal_key: "sleep",
        condition_id: null,
        biomarker_key: null,
        direction: null,
      },
      {
        kind: "condition",
        goal_key: null,
        condition_id: 4,
        biomarker_key: null,
        direction: null,
      },
      {
        kind: "biomarker",
        goal_key: null,
        condition_id: null,
        biomarker_key: "ferritin",
        direction: "low",
      },
      {
        kind: "biomarker",
        goal_key: null,
        condition_id: null,
        biomarker_key: "b12",
        direction: null,
      },
    ]);
  });
});
