import { describe, it, expect } from "vitest";
import {
  buildMomentSections,
  type MomentDose,
  type MomentSection,
} from "@/lib/moment-sections";
import {
  TIME_BUCKETS,
  TIME_BUCKET_LABELS,
  currentTimeBucket,
  type TimeBucket,
} from "@/lib/intake-schedule";

// Fixtures are counted doses in named slots — no PHI, nothing high-entropy.

let seq = 0;
function dose(
  bucket: TimeBucket,
  opts: { taken?: boolean; skipped?: boolean; at?: string } = {}
): MomentDose {
  const resolved = Boolean(opts.taken || opts.skipped);
  return {
    key: ++seq,
    bucket,
    resolved,
    taken: Boolean(opts.taken),
    takenClock: opts.at ?? null,
  };
}

function build(doses: MomentDose[], nowHhmm: string, slotClocks = {}) {
  return buildMomentSections({
    doses,
    currentBucket: currentTimeBucket(nowHhmm),
    slotClocks,
    labels: TIME_BUCKET_LABELS,
  });
}

function byBucket(sections: MomentSection[], bucket: TimeBucket) {
  const s = sections.find((x) => x.bucket === bucket);
  if (!s) throw new Error(`no section for ${bucket}`);
  return s;
}

describe("the moment decides which slot earns full height (#2652 behavior 1)", () => {
  it("in the morning, Morning is expanded and Evening spends one line", () => {
    const sections = build(
      [dose("Morning"), dose("Morning"), dose("Evening"), dose("Evening")],
      "08:00",
      { Evening: "21:00" }
    );
    expect(byBucket(sections, "Morning").state).toBe("moment");
    expect(byBucket(sections, "Morning").expanded).toBe(true);
    expect(byBucket(sections, "Evening").expanded).toBe(false);
    expect(byBucket(sections, "Evening").line).toBe("Evening · 2 doses · 21:00");
  });

  it("in the evening it INVERTS, and the morning line states the outcome", () => {
    const sections = build(
      [
        dose("Morning", { taken: true, at: "08:12" }),
        dose("Morning", { taken: true, at: "08:10" }),
        dose("Morning", { taken: true, at: "08:05" }),
        dose("Evening"),
      ],
      "19:00"
    );
    expect(byBucket(sections, "Morning").expanded).toBe(false);
    expect(byBucket(sections, "Morning").line).toBe(
      "✓ Morning · 3 of 3 taken · 08:12"
    );
    expect(byBucket(sections, "Evening").state).toBe("moment");
    expect(byBucket(sections, "Evening").expanded).toBe(true);
  });

  it("the collapsed line is never a truncation — it always carries a count", () => {
    const sections = build(
      [dose("Morning", { taken: true, at: "08:12" }), dose("Evening")],
      "08:00",
      { Evening: "21:00" }
    );
    for (const s of sections) {
      expect(s.line, s.bucket).toMatch(/\d/);
      expect(s.line, s.bucket).not.toBe(s.label);
    }
  });
});

describe("a section that owes something NOW never collapses (#2385)", () => {
  it("an unresolved morning dose seen in the evening stays at full height", () => {
    const sections = build(
      [dose("Morning"), dose("Evening"), dose("Evening")],
      "19:00"
    );
    expect(byBucket(sections, "Morning").state).toBe("obligation");
    expect(byBucket(sections, "Morning").expanded).toBe(true);
  });

  it("an unresolved Anytime dose is owed all day, in every slot", () => {
    for (const nowHhmm of ["07:00", "13:00", "18:00", "23:00"]) {
      const sections = build([dose("Anytime"), dose("Morning")], nowHhmm);
      expect(byBucket(sections, "Anytime").expanded, nowHhmm).toBe(true);
    }
  });

  it("a SETTLED Anytime dose collapses like any other settled slot", () => {
    const sections = build(
      [dose("Anytime", { taken: true, at: "10:00" }), dose("Evening")],
      "19:00"
    );
    expect(byBucket(sections, "Anytime").state).toBe("settled");
    expect(byBucket(sections, "Anytime").expanded).toBe(false);
  });

  it("no unresolved dose is EVER inside a collapsed slot that has arrived", () => {
    // The whole deceptive-success guard, stated as an invariant over every clock and
    // every mix of resolutions in the day's slots.
    const mixes: MomentDose[][] = [
      [dose("Morning"), dose("Midday"), dose("Evening")],
      [dose("Morning", { taken: true, at: "08:00" }), dose("Midday")],
      [dose("Midday", { skipped: true }), dose("Before sleep")],
      [dose("Anytime"), dose("Evening", { taken: true, at: "20:00" })],
    ];
    for (const doses of mixes) {
      for (const nowHhmm of ["06:30", "10:59", "11:00", "14:59", "20:59", "23:30"]) {
        const current = currentTimeBucket(nowHhmm);
        for (const s of build(doses, nowHhmm)) {
          if (s.expanded) continue;
          const unresolved = s.doses.filter((d) => !d.resolved).length;
          const arrived =
            s.bucket === "Anytime" ||
            TIME_BUCKETS.indexOf(s.bucket) <= TIME_BUCKETS.indexOf(current);
          expect(unresolved > 0 && arrived, `${s.bucket} @ ${nowHhmm}`).toBe(
            false
          );
        }
      }
    }
  });
});

describe("the line is the section's whole truth, not a smaller lie", () => {
  it("a skipped dose is stated, never folded into 'taken'", () => {
    const sections = build(
      [
        dose("Morning", { taken: true, at: "08:12" }),
        dose("Morning", { taken: true, at: "08:14" }),
        dose("Morning", { skipped: true }),
      ],
      "19:00"
    );
    expect(byBucket(sections, "Morning").line).toBe(
      "✓ Morning · 2 taken, 1 skipped · 08:14"
    );
  });

  it("a slot that was entirely SKIPPED wears no check mark", () => {
    const sections = build(
      [dose("Morning", { skipped: true }), dose("Morning", { skipped: true })],
      "19:00"
    );
    const s = byBucket(sections, "Morning");
    expect(s.line).toBe("Morning · 2 skipped");
    expect(s.line.startsWith("✓")).toBe(false);
  });

  it("an ahead slot with a head start says how far along it is", () => {
    const sections = build(
      [
        dose("Before sleep", { taken: true, at: "20:30" }),
        dose("Before sleep"),
        dose("Before sleep"),
      ],
      "08:00",
      { "Before sleep": "22:00" }
    );
    const s = byBucket(sections, "Before sleep");
    expect(s.state).toBe("ahead");
    expect(s.line).toBe("Bedtime · 1 of 3 taken · 22:00");
  });

  it("an ahead line omits the clock rather than inventing one", () => {
    const sections = build([dose("Morning"), dose("Evening")], "08:00");
    expect(byBucket(sections, "Evening").line).toBe("Evening · 1 dose");
  });

  it("a settled line quotes the LATEST time it actually has", () => {
    const sections = build(
      [
        dose("Midday", { taken: true, at: "12:05" }),
        dose("Midday", { taken: true, at: "13:40" }),
      ],
      "19:00"
    );
    expect(byBucket(sections, "Midday").line).toBe(
      "✓ Midday · 2 of 2 taken · 13:40"
    );
  });
});

describe("same data, only height moves", () => {
  it("every dose survives compression — nothing is filtered out", () => {
    const doses = [
      dose("Morning", { taken: true, at: "08:00" }),
      dose("Midday"),
      dose("Evening"),
      dose("Before sleep"),
      dose("Anytime", { skipped: true }),
    ];
    for (const nowHhmm of ["07:00", "12:00", "18:00", "22:30"]) {
      const seen = build(doses, nowHhmm).flatMap((s) => s.doses.map((d) => d.key));
      expect(seen.sort(), nowHhmm).toEqual(doses.map((d) => d.key).sort());
    }
  });

  it("sections stay in dose-day order at every clock — the moment is never hoisted", () => {
    const doses = [
      dose("Morning"),
      dose("Midday"),
      dose("Evening"),
      dose("Before sleep"),
      dose("Anytime"),
    ];
    const expected: TimeBucket[] = [
      "Morning",
      "Midday",
      "Evening",
      "Before sleep",
      "Anytime",
    ];
    for (const nowHhmm of ["07:00", "12:00", "18:00", "22:30"]) {
      expect(
        build(doses, nowHhmm).map((s) => s.bucket),
        nowHhmm
      ).toEqual(expected);
    }
  });

  it("an empty slot is not a collapsed line about nothing", () => {
    const sections = build([dose("Evening")], "08:00");
    expect(sections.map((s) => s.bucket)).toEqual(["Evening"]);
  });
});

describe("something always leads", () => {
  it("when the current slot is empty, the earliest unsettled slot leads", () => {
    // 08:00 is Morning; the day's only doses are in the evening.
    const sections = build([dose("Evening"), dose("Before sleep")], "08:00");
    expect(byBucket(sections, "Evening").expanded).toBe(true);
    expect(byBucket(sections, "Before sleep").expanded).toBe(false);
  });

  it("a fully settled day collapses everything — there is nothing to act in", () => {
    const sections = build(
      [
        dose("Morning", { taken: true, at: "08:00" }),
        dose("Evening", { taken: true, at: "20:00" }),
      ],
      "22:00"
    );
    expect(sections.every((s) => !s.expanded)).toBe(true);
  });

  it("a finished current slot collapses instead of showing a wall of checks", () => {
    const sections = build(
      [
        dose("Morning", { taken: true, at: "08:01" }),
        dose("Morning", { taken: true, at: "08:02" }),
        dose("Evening"),
      ],
      "09:00",
      { Evening: "21:00" }
    );
    expect(byBucket(sections, "Morning").state).toBe("settled");
    expect(byBucket(sections, "Morning").expanded).toBe(false);
    // …and the evening, still ahead, becomes the one place there is work.
    expect(byBucket(sections, "Evening").expanded).toBe(true);
  });

  it("no doses at all is no sections at all", () => {
    expect(build([], "08:00")).toEqual([]);
  });
});
