import { describe, it, expect } from "vitest";
import {
  elapsedLabel,
  escalationsDue,
  renderEscalationMessage,
  type EscalationCandidate,
} from "../notifications/escalation";

const candidate = (
  over: Partial<EscalationCandidate> = {}
): EscalationCandidate => ({
  doseId: 1,
  supplementId: 10,
  supplementName: "Lisinopril",
  amount: "10 mg",
  window: "Morning",
  kind: "supplement",
  slotMinute: 8 * 60,
  escalateAfterMin: 120,
  escalateChatId: null,
  ...over,
});

describe("escalationsDue", () => {
  it("escalates a sent, unconfirmed critical dose past its window", () => {
    const due = escalationsDue({
      candidates: [candidate()],
      sentWindows: ["Morning"],
      confirmedDoseIds: [],
      escalatedDoseIds: [],
      nowMinutes: 10 * 60, // 10:00, slot 8:00 + 120min = 10:00
    });
    expect(due.map((d) => d.doseId)).toEqual([1]);
  });

  it("does not escalate before the window has elapsed", () => {
    const due = escalationsDue({
      candidates: [candidate()],
      sentWindows: ["Morning"],
      confirmedDoseIds: [],
      escalatedDoseIds: [],
      nowMinutes: 9 * 60 + 59, // one minute short of 10:00
    });
    expect(due).toEqual([]);
  });

  it("does not escalate when the reminder was never sent", () => {
    const due = escalationsDue({
      candidates: [candidate()],
      sentWindows: [], // Morning reminder never went out
      confirmedDoseIds: [],
      escalatedDoseIds: [],
      nowMinutes: 12 * 60,
    });
    expect(due).toEqual([]);
  });

  it("does not escalate a confirmed dose", () => {
    const due = escalationsDue({
      candidates: [candidate()],
      sentWindows: ["Morning"],
      confirmedDoseIds: [1],
      escalatedDoseIds: [],
      nowMinutes: 12 * 60,
    });
    expect(due).toEqual([]);
  });

  // A deliberate skip is a DECISION, not a lapse — a skipped critical dose must
  // never escalate (#232), even though it's neither taken nor already-escalated.
  it("does not escalate a deliberately skipped critical dose", () => {
    const due = escalationsDue({
      candidates: [candidate()],
      sentWindows: ["Morning"],
      confirmedDoseIds: [], // not taken…
      skippedDoseIds: [1], // …but deliberately skipped
      escalatedDoseIds: [],
      nowMinutes: 12 * 60,
    });
    expect(due).toEqual([]);
  });

  it("still escalates a peer dose that was NOT skipped", () => {
    const due = escalationsDue({
      candidates: [candidate({ doseId: 1 }), candidate({ doseId: 2 })],
      sentWindows: ["Morning"],
      confirmedDoseIds: [],
      skippedDoseIds: [1], // only dose 1 skipped
      escalatedDoseIds: [],
      nowMinutes: 12 * 60,
    });
    expect(due.map((d) => d.doseId)).toEqual([2]);
  });

  it("does not escalate a dose already escalated today (dedup)", () => {
    const due = escalationsDue({
      candidates: [candidate()],
      sentWindows: ["Morning"],
      confirmedDoseIds: [],
      escalatedDoseIds: [1],
      nowMinutes: 12 * 60,
    });
    expect(due).toEqual([]);
  });

  it("carries the override chat and handles multiple doses independently", () => {
    const due = escalationsDue({
      candidates: [
        candidate({ doseId: 1, escalateChatId: "999" }),
        candidate({
          doseId: 2,
          supplementName: "Metformin",
          window: "Evening",
          slotMinute: 20 * 60,
          escalateAfterMin: 60,
        }),
      ],
      sentWindows: ["Morning", "Evening"],
      confirmedDoseIds: [],
      escalatedDoseIds: [],
      nowMinutes: 21 * 60, // 21:00 → Morning long past, Evening (20:00+60) just due
    });
    expect(due.map((d) => [d.doseId, d.escalateChatId])).toEqual([
      [1, "999"],
      [2, null],
    ]);
  });

  it("respects a custom escalate-after window", () => {
    const base = {
      candidates: [candidate({ escalateAfterMin: 30 })],
      sentWindows: ["Morning" as const],
      confirmedDoseIds: [] as number[],
      escalatedDoseIds: [] as number[],
    };
    // 8:00 + 30min = 8:30; the hourly tick at 9:00 fires it.
    expect(escalationsDue({ ...base, nowMinutes: 9 * 60 })).toHaveLength(1);
    expect(escalationsDue({ ...base, nowMinutes: 8 * 60 })).toHaveLength(0);
  });

  // #189: the shipped Bedtime slot (22:00) + default 120-min wait computes a raw
  // threshold of 1440 (midnight), which no hourly tick (max nowMinutes = 1380)
  // could ever reach — the escalation was silently dead. The clamp to the day's
  // last tick (23:00) makes it fire once at 23:00 instead of never.
  const bedtime = () =>
    candidate({
      doseId: 42,
      supplementName: "Warfarin",
      window: "Bedtime",
      slotMinute: 22 * 60,
      escalateAfterMin: 120,
    });

  it("escalates a Bedtime+120 critical dose at the day's last tick (#189)", () => {
    const due = escalationsDue({
      candidates: [bedtime()],
      sentWindows: ["Bedtime"],
      confirmedDoseIds: [],
      escalatedDoseIds: [],
      nowMinutes: 23 * 60, // 23:00, the final hourly tick of the day
    });
    expect(due.map((d) => d.doseId)).toEqual([42]);
  });

  it("does not escalate Bedtime+120 before the clamped last tick", () => {
    const due = escalationsDue({
      candidates: [bedtime()],
      sentWindows: ["Bedtime"],
      confirmedDoseIds: [],
      escalatedDoseIds: [],
      nowMinutes: 22 * 60, // 22:00 reminder just went out; not yet 23:00
    });
    expect(due).toEqual([]);
  });

  it("does not escalate a confirmed Bedtime dose even at the last tick", () => {
    const due = escalationsDue({
      candidates: [bedtime()],
      sentWindows: ["Bedtime"],
      confirmedDoseIds: [42], // taken
      escalatedDoseIds: [],
      nowMinutes: 23 * 60,
    });
    expect(due).toEqual([]);
  });

  it("does not double-fire a Bedtime escalation already sent this episode", () => {
    // The clamp keeps escalation same-day, so the once-per-day dedup marker
    // (notify_last_esc_<dose> == today) still suppresses a repeat at the 23:00
    // tick — and, because we never wrap into the next calendar day, it never
    // leaks a stale marker across midnight to suppress the next day's dose.
    const due = escalationsDue({
      candidates: [bedtime()],
      sentWindows: ["Bedtime"],
      confirmedDoseIds: [],
      escalatedDoseIds: [42], // already escalated at 23:00 this day
      nowMinutes: 23 * 60,
    });
    expect(due).toEqual([]);
  });
});

describe("renderEscalationMessage", () => {
  it("names the profile and the dose", () => {
    const msg = renderEscalationMessage(
      "Mom",
      {
        doseId: 1,
        supplementId: 10,
        supplementName: "Lisinopril",
        amount: "10 mg",
        window: "Morning",
        kind: "medication",
        unconfirmedMinutes: 160,
        escalateChatId: null,
      },
      3,
      "2026-07-11"
    );
    expect(msg.title).toContain("Mom");
    expect(msg.title).toContain("Lisinopril");
    expect(msg.body).toContain("morning");
    expect(msg.body).toContain("10 mg");
  });

  it("keeps a medication's formulation beside its dose", () => {
    const msg = renderEscalationMessage(
      "Child",
      {
        doseId: 1,
        supplementId: 10,
        supplementName: "Acetaminophen",
        amount: "160 mg",
        product: "Children's oral suspension (160 mg / 5 mL)",
        window: "Evening",
        kind: "medication",
        unconfirmedMinutes: 120,
        escalateChatId: null,
      },
      3,
      "2026-07-11"
    );
    expect(msg.body).toContain("160 mg / 5 mL");
  });

  it("omits the amount when absent", () => {
    const msg = renderEscalationMessage(
      "",
      {
        doseId: 1,
        supplementId: 10,
        supplementName: "Vitamin D",
        amount: null,
        window: "Evening",
        kind: "supplement",
        unconfirmedMinutes: 120,
        escalateChatId: null,
      },
      3,
      "2026-07-11"
    );
    expect(msg.body).not.toContain("(");
  });

  // The THREE caregiver buttons (#233 + #1716): ✅ Confirmed taken (esctake), ⏭️ Skip
  // (escskip) and 👍 I'm on it (escack), carrying profile/dose/supp ids + the day —
  // never a name — so a late tap resolves the right dose on the right date.
  it("carries the ✅ confirm, ⏭️ skip and 👍 ack buttons with id-only tokens", () => {
    const msg = renderEscalationMessage(
      "Mom",
      {
        doseId: 7,
        supplementId: 10,
        supplementName: "Lisinopril",
        amount: "10 mg",
        window: "Morning",
        kind: "medication",
        unconfirmedMinutes: 160,
        escalateChatId: null,
      },
      3,
      "2026-07-11"
    );
    expect(msg.actions?.map((a) => a.data)).toEqual([
      "esctake:3:7:10:2026-07-11",
      "escskip:3:7:10:2026-07-11",
      "escack:3:7:10:2026-07-11",
    ]);
    // All three share one row so they render side by side.
    expect(new Set(msg.actions?.map((a) => a.row))).toEqual(new Set(["esc"]));
    // No deep link without a configured public URL — the buttons still stand.
    expect(msg.actions?.some((a) => a.url)).toBe(false);
  });

  // #1716 §3: the message states the fact that made it fire. The elapsed time was
  // already computed to DECIDE the send; the body never said it.
  it("states how long the dose has been unconfirmed, and the slot", () => {
    const msg = renderEscalationMessage(
      "Mom",
      {
        doseId: 7,
        supplementId: 10,
        supplementName: "Warfarin",
        amount: "5 mg",
        window: "Morning",
        kind: "medication",
        unconfirmedMinutes: 160,
        escalateChatId: null,
      },
      3,
      "2026-07-11"
    );
    expect(msg.body).toBe(
      "Warfarin (5 mg) — morning slot, unconfirmed for 2h 40m."
    );
  });

  it("carries a kind-aware deep link when a public URL is configured", () => {
    const med = renderEscalationMessage(
      "Mom",
      {
        doseId: 7,
        supplementId: 10,
        supplementName: "Warfarin",
        amount: "5 mg",
        window: "Morning",
        kind: "medication",
        unconfirmedMinutes: 160,
        escalateChatId: null,
      },
      3,
      "2026-07-11",
      "https://allos.example/"
    );
    expect(med.actions?.at(-1)?.url).toBe("https://allos.example/medications");
    const supp = renderEscalationMessage(
      "Mom",
      {
        doseId: 7,
        supplementId: 10,
        supplementName: "Vitamin D",
        amount: null,
        window: "Bedtime",
        kind: "supplement",
        unconfirmedMinutes: 60,
        escalateChatId: null,
      },
      3,
      "2026-07-11",
      "https://allos.example"
    );
    expect(supp.actions?.at(-1)?.url).toContain("/nutrition");
  });
});

describe("elapsedLabel", () => {
  it("reads in the redose formatter's register and invents no precision", () => {
    expect(elapsedLabel(160)).toBe("2h 40m");
    expect(elapsedLabel(180)).toBe("3h");
    expect(elapsedLabel(45)).toBe("45m");
    expect(elapsedLabel(0)).toBe("0m");
    expect(elapsedLabel(-5)).toBe("0m");
  });
});
