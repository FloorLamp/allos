import { describe, it, expect } from "vitest";
import {
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
  slotHour: 8,
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
          slotHour: 20,
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
});

describe("renderEscalationMessage", () => {
  it("names the profile and the dose", () => {
    const msg = renderEscalationMessage("Mom", {
      doseId: 1,
      supplementId: 10,
      supplementName: "Lisinopril",
      amount: "10 mg",
      window: "Morning",
      escalateChatId: null,
    });
    expect(msg.title).toContain("Mom");
    expect(msg.title).toContain("Lisinopril");
    expect(msg.body).toContain("morning");
    expect(msg.body).toContain("10 mg");
    expect(msg.actions).toBeUndefined();
  });

  it("omits the amount when absent", () => {
    const msg = renderEscalationMessage("", {
      doseId: 1,
      supplementId: 10,
      supplementName: "Vitamin D",
      amount: null,
      window: "Evening",
      escalateChatId: null,
    });
    expect(msg.body).not.toContain("(");
  });
});
