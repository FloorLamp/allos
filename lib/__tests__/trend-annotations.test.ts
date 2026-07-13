import { describe, it, expect } from "vitest";
import {
  buildAnnotations,
  annotationKindsPresent,
  filterAnnotationsByKind,
  snapAnnotationsToDates,
  diffSituations,
  parseSituationEvents,
  serializeSituationEvents,
  situationsActiveOn,
  situationHistoryResolver,
  SITUATION_LOG_CAP,
  type SituationEvent,
  type TrendAnnotation,
} from "../trend-annotations";

describe("buildAnnotations", () => {
  it("expands a medication course into start + stop markers", () => {
    const out = buildAnnotations(
      {
        medications: [
          {
            name: "Sertraline",
            startedOn: "2026-01-05",
            stoppedOn: "2026-02-10",
          },
        ],
      },
      {}
    );
    expect(out).toEqual([
      { date: "2026-01-05", label: "Sertraline started", kind: "medication" },
      { date: "2026-02-10", label: "Sertraline stopped", kind: "medication" },
    ]);
  });

  it("emits only a start marker for an open (never-stopped) course", () => {
    const out = buildAnnotations(
      {
        medications: [
          { name: "Vitamin D", startedOn: "2026-01-01", stoppedOn: null },
        ],
      },
      {}
    );
    expect(out).toEqual([
      { date: "2026-01-01", label: "Vitamin D started", kind: "medication" },
    ]);
  });

  it("falls back through title → provider → generic for an appointment label", () => {
    const out = buildAnnotations(
      {
        appointments: [
          {
            date: "2026-03-01",
            title: "Annual physical",
            providerName: "Dr. Lee",
          },
          { date: "2026-03-02", title: null, providerName: "Dr. Lee" },
          { date: "2026-03-03", title: "  ", providerName: null },
        ],
      },
      {}
    );
    expect(out.map((a) => a.label)).toEqual([
      "Annual physical",
      "Dr. Lee",
      "Appointment",
    ]);
    expect(out.every((a) => a.kind === "appointment")).toBe(true);
  });

  it("labels situation start/stop events", () => {
    const out = buildAnnotations(
      {
        situations: [
          { date: "2026-01-10", situation: "Illness", change: "start" },
          { date: "2026-01-20", situation: "Illness", change: "stop" },
        ],
      },
      {}
    );
    expect(out).toEqual([
      { date: "2026-01-10", label: "Illness started", kind: "situation" },
      { date: "2026-01-20", label: "Illness ended", kind: "situation" },
    ]);
  });

  it("filters markers to the inclusive [from, to] window (boundary dates kept)", () => {
    const meds = [
      { name: "A", startedOn: "2026-01-01", stoppedOn: null }, // before
      { name: "B", startedOn: "2026-02-01", stoppedOn: null }, // on from-boundary
      { name: "C", startedOn: "2026-02-15", stoppedOn: null }, // inside
      { name: "D", startedOn: "2026-02-28", stoppedOn: null }, // on to-boundary
      { name: "E", startedOn: "2026-03-05", stoppedOn: null }, // after
    ];
    const out = buildAnnotations(
      { medications: meds },
      { from: "2026-02-01", to: "2026-02-28" }
    );
    expect(out.map((a) => a.label)).toEqual([
      "B started",
      "C started",
      "D started",
    ]);
  });

  it("treats an open bound as unbounded on that side", () => {
    const meds = [
      { name: "A", startedOn: "2026-01-01", stoppedOn: null },
      { name: "B", startedOn: "2026-06-01", stoppedOn: null },
    ];
    expect(
      buildAnnotations({ medications: meds }, { to: "2026-03-01" }).map(
        (a) => a.label
      )
    ).toEqual(["A started"]);
    expect(
      buildAnnotations({ medications: meds }, { from: "2026-03-01" }).map(
        (a) => a.label
      )
    ).toEqual(["B started"]);
  });

  it("sorts by date, then kind (med, appt, situation), then label", () => {
    const out = buildAnnotations(
      {
        medications: [
          { name: "Zinc", startedOn: "2026-05-01", stoppedOn: null },
        ],
        appointments: [
          { date: "2026-05-01", title: "Checkup", providerName: null },
        ],
        situations: [
          { date: "2026-05-01", situation: "Travel", change: "start" },
        ],
      },
      {}
    );
    expect(out.map((a) => a.kind)).toEqual([
      "medication",
      "appointment",
      "situation",
    ]);
  });

  it("ignores malformed / missing dates and empty input", () => {
    expect(buildAnnotations({}, {})).toEqual([]);
    expect(
      buildAnnotations(
        {
          medications: [{ name: "X", startedOn: "not-a-date", stoppedOn: "" }],
          appointments: [{ date: null, title: "Y", providerName: null }],
          situations: [{ date: "nope", situation: "Z", change: "start" }],
        },
        {}
      )
    ).toEqual([]);
  });
});

describe("annotationKindsPresent", () => {
  it("returns only present kinds in canonical order", () => {
    const anns: TrendAnnotation[] = [
      { date: "2026-01-02", label: "b", kind: "situation" },
      { date: "2026-01-01", label: "a", kind: "medication" },
    ];
    expect(annotationKindsPresent(anns)).toEqual(["medication", "situation"]);
    expect(annotationKindsPresent([])).toEqual([]);
  });
});

describe("filterAnnotationsByKind", () => {
  const anns: TrendAnnotation[] = [
    { date: "2026-01-01", label: "m", kind: "medication" },
    { date: "2026-01-02", label: "a", kind: "appointment" },
    { date: "2026-01-03", label: "s", kind: "situation" },
  ];
  it("drops a kind toggled off; a kind omitted from the map defaults on", () => {
    expect(
      filterAnnotationsByKind(anns, { appointment: false }).map((a) => a.kind)
    ).toEqual(["medication", "situation"]);
  });
  it("keeps only explicitly enabled kinds when all are set", () => {
    expect(
      filterAnnotationsByKind(anns, {
        medication: true,
        appointment: false,
        situation: false,
      }).map((a) => a.kind)
    ).toEqual(["medication"]);
  });
});

describe("snapAnnotationsToDates", () => {
  const dates = ["2026-01-01", "2026-01-10", "2026-01-20"];
  it("snaps each marker to the nearest charted date", () => {
    const anns: TrendAnnotation[] = [
      { date: "2026-01-02", label: "near start", kind: "medication" },
      { date: "2026-01-12", label: "near mid", kind: "medication" },
    ];
    expect(snapAnnotationsToDates(anns, dates).map((a) => a.date)).toEqual([
      "2026-01-01",
      "2026-01-10",
    ]);
  });
  it("resolves an equidistant tie to the later date", () => {
    // 2026-01-05 is 4 days from both 01-01 and 01-10? no — pick a true midpoint.
    const anns: TrendAnnotation[] = [
      { date: "2026-01-15", label: "mid", kind: "medication" }, // 5 from 01-10 and 01-20
    ];
    expect(snapAnnotationsToDates(anns, dates)[0].date).toBe("2026-01-20");
  });
  it("returns [] when there are no dates to snap to", () => {
    const anns: TrendAnnotation[] = [
      { date: "2026-01-02", label: "x", kind: "medication" },
    ];
    expect(snapAnnotationsToDates(anns, [])).toEqual([]);
  });
});

describe("diffSituations", () => {
  it("emits start for added and stop for removed situations", () => {
    const out = diffSituations(
      ["Illness"],
      ["Illness", "Travel"],
      "2026-02-01"
    );
    expect(out).toEqual([
      { date: "2026-02-01", situation: "Travel", change: "start" },
    ]);
    const out2 = diffSituations(
      ["Illness", "Travel"],
      ["Travel"],
      "2026-02-02"
    );
    expect(out2).toEqual([
      { date: "2026-02-02", situation: "Illness", change: "stop" },
    ]);
  });
  it("returns [] when nothing changed", () => {
    expect(diffSituations(["A", "B"], ["B", "A"], "2026-01-01")).toEqual([]);
  });
  it("ignores blank/whitespace situations", () => {
    expect(diffSituations([], ["  ", "Real"], "2026-01-01")).toEqual([
      { date: "2026-01-01", situation: "Real", change: "start" },
    ]);
  });
});

describe("situation-event log (parse / serialize)", () => {
  it("round-trips well-formed events and drops malformed ones", () => {
    const raw = JSON.stringify([
      { date: "2026-01-01", situation: "Illness", change: "start" },
      { date: "bad", situation: "X", change: "start" }, // bad date
      { date: "2026-01-02", situation: "Y", change: "sideways" }, // bad change
      { date: "2026-01-03", situation: "  ", change: "stop" }, // blank name
    ]);
    expect(parseSituationEvents(raw)).toEqual([
      { date: "2026-01-01", situation: "Illness", change: "start" },
    ]);
  });
  it("returns [] for null/empty/non-array/garbage", () => {
    expect(parseSituationEvents(null)).toEqual([]);
    expect(parseSituationEvents("")).toEqual([]);
    expect(parseSituationEvents("{}")).toEqual([]);
    expect(parseSituationEvents("not json")).toEqual([]);
  });
  it("appends new events and caps the log to the most recent SITUATION_LOG_CAP", () => {
    const existing = Array.from({ length: SITUATION_LOG_CAP }, (_, i) => ({
      date: "2026-01-01",
      situation: `S${i}`,
      change: "start" as const,
    }));
    const added = [
      { date: "2026-02-01", situation: "New", change: "start" as const },
    ];
    const parsed = parseSituationEvents(
      serializeSituationEvents(existing, added)
    );
    expect(parsed).toHaveLength(SITUATION_LOG_CAP);
    expect(parsed[parsed.length - 1]).toEqual(added[0]);
    expect(parsed[0].situation).toBe("S1"); // oldest dropped
  });
});

describe("situationsActiveOn — adherence history reconstruction (#654)", () => {
  const ev = (
    date: string,
    situation: string,
    change: "start" | "stop"
  ): SituationEvent => ({ date, situation, change });

  it("scores past days against the state THAT day, not the current toggle", () => {
    // Travel turned on today (d5); it is active "now" but was off before.
    const events = [ev("2026-07-05", "Travel", "start")];
    const current = ["Travel"];
    // Days before the start: inactive.
    expect(
      situationsActiveOn("2026-07-01", current, events).has("Travel")
    ).toBe(false);
    expect(
      situationsActiveOn("2026-07-04", current, events).has("Travel")
    ).toBe(false);
    // The start day and after: active (start on D ⇒ active on D).
    expect(
      situationsActiveOn("2026-07-05", current, events).has("Travel")
    ).toBe(true);
    expect(
      situationsActiveOn("2026-07-09", current, events).has("Travel")
    ).toBe(true);
  });

  it("preserves real past active days when a situation is turned OFF today", () => {
    // Travel started long ago and was turned off today (d9); current set is empty.
    const events = [
      ev("2026-06-01", "Travel", "start"),
      ev("2026-07-09", "Travel", "stop"),
    ];
    const current: string[] = [];
    // A day inside the active interval is still active (real misses preserved).
    expect(
      situationsActiveOn("2026-07-03", current, events).has("Travel")
    ).toBe(true);
    // The stop day and after: inactive (stop on D ⇒ inactive on D).
    expect(
      situationsActiveOn("2026-07-09", current, events).has("Travel")
    ).toBe(false);
  });

  it("keeps a situation active across the whole window when there is no log entry", () => {
    // Active "now" with no recorded transition (e.g. active since before the log):
    // seeded from the present, it stays active for every past day.
    const active = situationsActiveOn("2026-01-01", ["Illness"], []);
    expect(active.has("Illness")).toBe(true);
  });

  it("the resolver reproduces the 25-days-off / 3-days-on travel scenario", () => {
    const events = [ev("2026-07-26", "Travel", "start")];
    const on = situationHistoryResolver(["Travel"], events);
    // Days 1–25 (before activation): inactive → the item scores "na".
    expect(on("2026-07-10").has("Travel")).toBe(false);
    expect(on("2026-07-25").has("Travel")).toBe(false);
    // Days 26–28: active.
    expect(on("2026-07-26").has("Travel")).toBe(true);
    expect(on("2026-07-28").has("Travel")).toBe(true);
  });
});
