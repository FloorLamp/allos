import { describe, expect, it } from "vitest";
import { shiftDateStr } from "../date";
import { doseSortKey } from "../dose-order";
import type { Finding } from "../findings";
import {
  composeHomeList,
  composeHomeSetup,
  type HomeListInput,
  type HomeNowSeat,
  type HomeSubject,
  type HomeTrainingInput,
} from "../home-list";
import type { OpenEpisode } from "../open-episode";
import type { UpcomingItem } from "../upcoming";

// HOME'S ONE LIST (#5435 §3.2). These cases are the pure half of §10's list: what the
// composer SELECTS and in what ORDER. What the rows look like is PR 2's.

const TODAY = shiftDateStr("2026-08-22", 0);
const NOON = Date.parse("2026-08-22T12:00:00Z");
const MIN = 60_000;

const subject: HomeSubject = { scope: "profile", profileId: 1 };

const dose = (
  id: number,
  name: string,
  timeOfDay: string,
  over: Partial<UpcomingItem> = {}
): UpcomingItem =>
  ({
    key: `dose:${id}`,
    domain: "dose",
    title: name,
    shortLabel: name,
    href: "/nutrition?tab=supplements",
    dueDate: null,
    doseId: id,
    obligation: "should",
    // The key the dose generator itself stamps (#297), so no fixture can encode a
    // bucket the app would not derive.
    sortHint: doseSortKey({
      timeOfDay,
      obligation: "should",
      stack: null,
      name,
    }),
    ...over,
  }) as UpcomingItem;

// The owner's own day: every slot the app has, each holding a run the model groups
// into one act (#5063).
const SCHEDULE = [
  dose(1, "Creatine", "morning"),
  dose(2, "Vitamin D", "morning"),
  dose(3, "Magnesium", "midday"),
  dose(4, "Zinc", "midday"),
  dose(5, "Omega-3", "evening"),
  dose(6, "Curcumin", "evening"),
  dose(7, "Glycine", "before sleep"),
  dose(8, "Melatonin", "before sleep"),
  dose(9, "Electrolytes", "anytime"),
  dose(10, "Creatine top-up", "anytime"),
];

const PRACTICE: UpcomingItem = {
  key: "practice:9",
  domain: "practice",
  title: "Red light therapy",
  detail: "Weekly practice target",
  href: "/wellness",
  dueDate: null,
  band: "week",
  weeklyTarget: true,
  dueText: "1/3 this week",
  practiceLog: {
    practice: "Red light therapy",
    todayCount: 1,
    defaultDurationMin: 15,
    liveSession: null,
  },
} as UpcomingItem;

// The practice row's twin: the same weekly-floor shape with NO control on it.
const PACE: UpcomingItem = {
  key: "training:4",
  domain: "training",
  title: "Cardio",
  detail: "Weekly training target",
  href: "/training",
  dueDate: null,
  band: "week",
  weeklyTarget: true,
  dueText: "1/2 this week",
} as UpcomingItem;

const DENTIST: UpcomingItem = {
  key: "appointment:31",
  domain: "appointment",
  title: "Dentist",
  href: "/appointments",
  dueDate: shiftDateStr(TODAY, 2),
  actionLabel: "View",
} as UpcomingItem;

const noTraining: HomeTrainingInput = {
  live: null,
  loggedToday: false,
  recommended: false,
  applicable: true,
};

function input(over: Partial<HomeListInput> = {}): HomeListInput {
  return {
    day: TODAY,
    today: TODAY,
    now: NOON,
    minutesOfDay: 12 * 60,
    subject,
    attention: [],
    training: noTraining,
    fast: null,
    period: { episode: null, canStartToday: false, writable: true },
    ...over,
  };
}

const seats = (list: ReturnType<typeof composeHomeList>): HomeNowSeat[] =>
  (list.now?.rows ?? []).map((row) => row.seat);

// ── The shape of the page through the day ───────────────────────────────────────

describe("the order stays fixed while windows and facts change", () => {
  // The whole reason v3 replaced the ranker: at four points in one day, over one
  // unchanged schedule, the seats read the same and only their MEMBERSHIP moves as
  // each window opens. A ranked page reshuffled here.
  const hours: [string, number, string[]][] = [
    ["02:00, before anything has opened", 2 * 60, ["Morning", "Anytime"]],
    ["07:40, the owner's morning", 7 * 60 + 40, ["Morning", "Anytime"]],
    ["13:00, midday", 13 * 60, ["Morning", "Midday", "Anytime"]],
    [
      "22:30, late evening",
      22 * 60 + 30,
      ["Morning", "Midday", "Evening", "Before sleep", "Anytime"],
    ],
  ];

  it.each(hours)("at %s", (_label, minutesOfDay, openSlots) => {
    const list = composeHomeList(
      input({
        minutesOfDay,
        attention: [...SCHEDULE, PRACTICE, PACE, DENTIST],
        training: { ...noTraining, recommended: true },
      })
    );
    expect(seats(list)).toEqual([
      ...openSlots.map(() => "dose"),
      "practice",
      "training",
    ]);
    expect(
      (list.now?.rows ?? []).flatMap((row) =>
        row.content.kind === "dose-slot" ? [row.content.bucket] : []
      )
    ).toEqual(openSlots);
  });

  // EVERYTHING NOT YET CURRENT GOES INTO THE FOLD, WHATEVER THE SCHEDULE. That the
  // fold is ONE row is the type's job — `HomeLaterFold.row` is a single `HomeRow`, so
  // no depth but one can be constructed. What the type cannot hold is that the fold
  // COLLECTS: at every hour it carries each slot whose window has not opened plus the
  // dated commitment, and lets nothing leak past the rule or vanish.
  it.each(hours)(
    "collects every not-yet-current thing at %s",
    (_label, minutesOfDay, openSlots) => {
      const list = composeHomeList(
        input({
          minutesOfDay,
          attention: [...SCHEDULE, PRACTICE, PACE, DENTIST],
        })
      );
      // The five scheduled slots less those already open, plus the dentist in two days.
      expect(list.later?.entries).toHaveLength(5 - openSlots.length + 1);
    }
  );
});

describe("the owner's 07:40", () => {
  it("renders one Later row, then Morning, Anytime and the training seat", () => {
    const list = composeHomeList(
      input({
        minutesOfDay: 7 * 60 + 40,
        attention: [...SCHEDULE, PRACTICE, PACE, DENTIST],
        training: { ...noTraining, recommended: true },
      })
    );
    expect(list.later?.entries.map((entry) => entry.content)).toEqual([
      { kind: "dose-slot", bucket: "Midday", count: 2, opensAt: 11 * 60 },
      { kind: "dose-slot", bucket: "Evening", count: 2, opensAt: 15 * 60 },
      {
        kind: "dose-slot",
        bucket: "Before sleep",
        count: 2,
        opensAt: 21 * 60,
      },
      { kind: "commitment", name: "Dentist", on: shiftDateStr(TODAY, 2) },
    ]);
    expect(seats(list)).toEqual(["dose", "dose", "practice", "training"]);
    // The unmet pace row is on neither side of the rule: it reports progress, and
    // progress is the hub's (#5198). Only the practice target carries a control.
    expect(JSON.stringify(list)).not.toContain("training:4");
  });
});

describe("the Later fold", () => {
  it("carries names and windows and nothing that writes", () => {
    // The guarantee is the type — a Later entry has no control field to leave unset
    // and no `UpcomingItem` riding along to reach a one-tap write through. This pins
    // the projection so a later widening cannot quietly hand the fold a doseId.
    const list = composeHomeList(
      input({ minutesOfDay: 0, attention: [...SCHEDULE, DENTIST] })
    );
    for (const entry of list.later?.entries ?? [])
      expect(Object.keys(entry.content).sort()).toEqual(
        entry.content.kind === "dose-slot"
          ? ["bucket", "count", "kind", "opensAt"]
          : entry.content.kind === "action"
            ? ["kind", "name", "opensAt"]
            : ["kind", "name", "on"]
      );
  });

  it("states one appointment beyond the 1–7 day tail and no more", () => {
    const far = (id: number, days: number): UpcomingItem =>
      ({
        key: `appointment:${id}`,
        domain: "appointment",
        title: `Visit ${id}`,
        href: "/appointments",
        dueDate: shiftDateStr(TODAY, days),
      }) as UpcomingItem;
    const list = composeHomeList(
      input({ attention: [far(1, 40), far(2, 12), far(3, 90), DENTIST] })
    );
    expect(list.later?.entries.map((entry) => entry.id)).toEqual([
      "attention.fact:appointment:31",
      "attention.fact:appointment:2",
    ]);
  });

  it("is absent when nothing is later", () => {
    expect(
      composeHomeList(input({ minutesOfDay: 23 * 60, attention: SCHEDULE }))
        .later
    ).toBeNull();
  });
});

describe("the Now band pins what is owed", () => {
  it("keeps an overdue slot under the rule whatever its window says", () => {
    // The one thing that must never sink into the record. At 02:00 the Evening slot
    // has not opened, and an evening dose still owed from yesterday is owed NOW.
    const overdue = dose(3, "Omega-3", "evening", {
      dueDate: shiftDateStr(TODAY, -1),
    });
    const list = composeHomeList(
      input({
        minutesOfDay: 2 * 60,
        attention: [overdue, dose(6, "Curcumin", "evening")],
      })
    );
    expect(list.later).toBeNull();
    expect(list.now?.rows.map((row) => row.content.kind)).toEqual([
      "dose-slot",
    ]);
    expect(
      list.now?.rows[0]?.content.kind === "dose-slot" &&
        list.now.rows[0].content.overdue
    ).toBe(true);
  });

  // THE MODEL'S OWN GROUPING DECIDES, on both sides of the rule (#5063): a bucket
  // holding one dose is that dose, keeping the id its Upcoming twin has, and the fold
  // names it instead of counting it.
  it("leaves a bucket of one as the dose itself", () => {
    const lone = dose(3, "Omega-3", "evening");
    const later = composeHomeList(
      input({ minutesOfDay: 2 * 60, attention: [lone] })
    );
    expect(later.later?.entries).toEqual([
      {
        id: "attention.fact:dose:3",
        factKey: "upcoming.dose:3",
        subject,
        applicable: true,
        content: { kind: "action", name: "Omega-3", opensAt: 15 * 60 },
      },
    ]);
    const now = composeHomeList(
      input({ minutesOfDay: 16 * 60, attention: [lone] })
    );
    expect(now.now?.rows[0]?.id).toBe("attention.fact:dose:3");
    expect(now.now?.rows[0]?.content).toEqual({ kind: "item", item: lone });
  });

  it("seats a dated fact nowhere: only actions sit under the rule", () => {
    const reading: UpcomingItem = {
      key: "biomarker:LDL",
      domain: "biomarker",
      title: "LDL",
      href: "/results",
      dueDate: TODAY,
    } as UpcomingItem;
    expect(seats(composeHomeList(input({ attention: [reading] })))).toEqual([]);
  });

  // EVERY AFFORDANCE, ONE AT A TIME. The predicate above is the attention model's
  // `itemIsActionable`, and the whole reason Home reads it rather than keeping a copy
  // is that a clause may not go missing on one side only. So each clause is asserted
  // where Home consumes it: a dated fact carrying that field ALONE takes the care
  // seat, and dropping the clause reddens this case and nothing else.
  it.each([
    ["actionLabel", { actionLabel: "View" }],
    ["altAction", { altAction: { href: "/results" as const, label: "Open" } }],
    ["doseId", { doseId: 3 }],
    [
      "practiceLog",
      {
        practiceLog: {
          practice: "Red light therapy",
          todayCount: 0,
          defaultDurationMin: 15,
          liveSession: null,
        },
      },
    ],
    ["preventiveRuleKey", { preventiveRuleKey: "colonoscopy" }],
    ["bookHref", { bookHref: "/appointments" as const }],
    ["carePlanItemId", { carePlanItemId: 12 }],
    [
      "conditionSuggestion",
      { conditionSuggestion: { name: "Anaemia", code: null } },
    ],
    [
      "followUpResolve",
      { followUpResolve: { carePlanItemId: 12, resolvingRecordId: 4 } },
    ],
    ["followUpSettle", { followUpSettle: { carePlanItemId: 12 } }],
  ] as [string, Partial<UpcomingItem>][])(
    "seats a dated fact carrying only %s under the rule",
    (_field, affordance) => {
      const item = {
        key: "careplan:12",
        domain: "careplan",
        title: "Repeat ferritin",
        href: "/results",
        dueDate: TODAY,
        ...affordance,
      } as UpcomingItem;
      // The care seat is what the predicate decides. A practice target also takes
      // its own seat, which \`isPracticeTarget\` decides and this does not speak for.
      expect(seats(composeHomeList(input({ attention: [item] })))).toContain(
        "care"
      );
    }
  );

  it("states the clock the rule reads", () => {
    expect(
      composeHomeList(input({ minutesOfDay: 940 })).now?.minutesOfDay
    ).toBe(940);
  });
});

// ── The three state rows on one lifecycle (#5142) ───────────────────────────────

describe("the Training row moves through its three states in one day", () => {
  const live = (quietMin: number): OpenEpisode => ({
    kind: "workout",
    lastSignalAt: NOON - quietMin * MIN,
    expectedEnd: null,
  });

  it("is a session in progress while the shared reading says it is going", () => {
    const list = composeHomeList(
      input({ training: { ...noTraining, live: live(10) } })
    );
    expect(list.now?.rows[0]?.content).toEqual({
      kind: "training",
      state: {
        kind: "in-progress",
        episode: { kind: "running", quietMin: 10 },
      },
    });
  });

  it("keeps a quiet draft in progress: stale is still open", () => {
    const list = composeHomeList(
      input({ training: { ...noTraining, live: live(60) } })
    );
    expect(
      list.now?.rows[0]?.content.kind === "training" &&
        list.now.rows[0].content.state.kind
    ).toBe("in-progress");
  });

  it("falls through to the day's own facts once the draft is abandoned", () => {
    // Past the abandon bound the model has stopped expecting more of it, so offering
    // End on a draft nothing will finish is exactly what the one lifecycle removes.
    const list = composeHomeList(
      input({
        training: { ...noTraining, live: live(200), loggedToday: true },
      })
    );
    expect(list.now?.rows[0]?.content).toEqual({
      kind: "training",
      state: { kind: "logged" },
    });
  });

  it("offers the next workout when nothing is running or logged", () => {
    const list = composeHomeList(
      input({ training: { ...noTraining, recommended: true } })
    );
    expect(list.now?.rows[0]?.content).toEqual({
      kind: "training",
      state: { kind: "next" },
    });
  });

  it("has no row when the day holds none of the three", () => {
    expect(seats(composeHomeList(input()))).toEqual([]);
  });

  it("is absent for a profile training is not relevant to", () => {
    expect(
      seats(
        composeHomeList(
          input({
            training: { ...noTraining, recommended: true, applicable: false },
          })
        )
      )
    ).toEqual([]);
  });
});

describe("the Fast row", () => {
  const fast = (quietMin: number): OpenEpisode => ({
    kind: "fast",
    lastSignalAt: NOON - quietMin * MIN,
    expectedEnd: null,
  });

  it("keeps its seat and its End on a fast that has outrun its bound", () => {
    // Nothing auto-ends a fast: stopping and never starting are different truths and
    // only the person knows which (#2756).
    const list = composeHomeList(input({ fast: fast(40 * 60) }));
    expect(list.now?.rows.map((row) => row.seat)).toEqual(["fast"]);
    expect(list.now?.rows[0]?.content).toEqual({
      kind: "fast",
      episode: { kind: "stale", quietMin: 40 * 60 },
    });
  });
});

describe("the Period row reads the day-counted episode", () => {
  const openSince = (daysAgo: number) => ({
    kind: "period" as const,
    lastSignalOn: shiftDateStr(TODAY, -daysAgo),
  });

  it("counts the start day as day 1", () => {
    const list = composeHomeList(
      input({
        period: {
          episode: openSince(2),
          canStartToday: false,
          writable: true,
        },
      })
    );
    expect(list.now?.rows[0]?.content).toEqual({
      kind: "period",
      state: {
        kind: "open",
        day: 3,
        episode: { kind: "running", quietDays: 2 },
      },
    });
  });

  it("keeps the row on a period that has outrun its ten-day bound", () => {
    const list = composeHomeList(
      input({
        period: {
          episode: openSince(14),
          canStartToday: false,
          writable: true,
        },
      })
    );
    expect(
      list.now?.rows[0]?.content.kind === "period" &&
        list.now.rows[0].content.state.kind
    ).toBe("open");
  });

  // A CLOSED PERIOD IS THE ABSENCE OF AN EPISODE, not a fourth state (#5142). Nothing
  // predicts the day a period ends, so the model has no `finished` to report; what
  // renders on a forecast-window day is the cycle's own offer.
  it("offers a start on a forecast-window day with nothing open", () => {
    const list = composeHomeList(
      input({
        period: { episode: null, canStartToday: true, writable: true },
      })
    );
    expect(list.now?.rows[0]?.content).toEqual({
      kind: "period",
      state: { kind: "start-offer" },
    });
  });

  it("makes no offer without write access to the target", () => {
    expect(
      seats(
        composeHomeList(
          input({
            period: { episode: null, canStartToday: true, writable: false },
          })
        )
      )
    ).toEqual([]);
  });

  it("has no row when no period is open and none may start", () => {
    expect(seats(composeHomeList(input()))).toEqual([]);
  });
});

// ── Setup, and the days that are not today ──────────────────────────────────────

describe("the Setup list", () => {
  const gap: Finding = {
    domain: "data-quality",
    dedupeKey: "data-quality:dose-amount-unreadable",
    title: "Some dose amounts cannot be read",
    actionHref: "/nutrition?tab=supplements",
  };

  it("is absent when the bus has nothing", () => {
    expect(composeHomeSetup(subject, [])).toEqual([]);
  });

  it("keys its rows on the bus's own dismissal identity", () => {
    const [row] = composeHomeSetup(subject, [gap]);
    expect(row?.factKey).toBe("data-quality:dose-amount-unreadable");
    expect(row?.finding).toBe(gap);
  });

  it("is composed apart from the day's bands", () => {
    // Configuration is not a daily fact (§2.9), and Setup streams behind its own
    // boundary (§6.1) — so a setup finding cannot reach the Later or Now bands,
    // because the composer that builds them never sees one.
    const list = composeHomeList(input());
    expect(list.later).toBeNull();
    expect(list.now?.rows).toEqual([]);
    expect(composeHomeSetup(subject, [gap])).toHaveLength(1);
  });
});

describe("a day that is not today", () => {
  it("is the plain record: no rule, no Later row", () => {
    const list = composeHomeList(
      input({
        day: shiftDateStr(TODAY, -1),
        minutesOfDay: 7 * 60 + 40,
        attention: [...SCHEDULE, DENTIST],
        training: { ...noTraining, recommended: true },
        period: { episode: null, canStartToday: true, writable: true },
      })
    );
    expect(list).toEqual({ later: null, now: null });
  });
});
